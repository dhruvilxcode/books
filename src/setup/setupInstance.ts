import { Fyo } from 'fyo';
import { DocValueMap } from 'fyo/core/types';
import { Doc } from 'fyo/model/doc';
import { createNumberSeries } from 'fyo/model/naming';
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  DEFAULT_SERIES_START
} from 'fyo/utils/consts';
import { AccountRootTypeEnum } from 'models/baseModels/Account/types';
import { AccountingSettings } from 'models/baseModels/AccountingSettings/AccountingSettings';
import { ModelNameEnum } from 'models/types';
import { initializeInstance, setCurrencySymbols } from 'src/initFyo';
import { createRegionalRecords } from 'src/regional';
import { getRandomString } from 'utils';
import { defaultUOMs } from 'utils/defaults';
import { getCountryCodeFromCountry, getCountryInfo } from 'utils/misc';
import { CountryInfo } from 'utils/types';
import { CreateCOA } from './createCOA';
import { SetupWizardOptions } from './types';

export default async function setupInstance(
  dbPath: string,
  setupWizardOptions: SetupWizardOptions,
  fyo: Fyo
) {
  const { companyName, country, bankName, chartOfAccounts } =
    setupWizardOptions;

  fyo.store.skipTelemetryLogging = true;
  await initializeDatabase(dbPath, country, fyo);
  await updateSystemSettings(setupWizardOptions, fyo);
  await updateAccountingSettings(setupWizardOptions, fyo);
  await updatePrintSettings(setupWizardOptions, fyo);

  await createCurrencyRecords(fyo);
  await createAccountRecords(bankName, country, chartOfAccounts, fyo);
  await createRegionalRecords(country, fyo);
  await createDefaultEntries(fyo);
  await createDefaultNumberSeries(fyo);

  await completeSetup(companyName, fyo);
  if (!Object.keys(fyo.currencySymbols).length) {
    await setCurrencySymbols(fyo);
  }

  fyo.store.skipTelemetryLogging = false;
}

async function createDefaultEntries(fyo: Fyo) {
  /**
   * Create default UOM entries
   */
  for (const uom of defaultUOMs) {
    await checkAndCreateDoc(ModelNameEnum.UOM, uom, fyo);
  }
}

async function initializeDatabase(dbPath: string, country: string, fyo: Fyo) {
  const countryCode = getCountryCodeFromCountry(country);
  await initializeInstance(dbPath, true, countryCode, fyo);
}

async function updateAccountingSettings(
  {
    companyName,
    country,
    fullname,
    email,
    bankName,
    fiscalYearStart,
    fiscalYearEnd,
  }: SetupWizardOptions,
  fyo: Fyo
) {
  const accountingSettings = (await fyo.doc.getDoc(
    'AccountingSettings'
  )) as AccountingSettings;
  await accountingSettings.setAndSync({
    companyName,
    country,
    fullname,
    email,
    bankName,
    fiscalYearStart,
    fiscalYearEnd,
  });
  return accountingSettings;
}

async function updatePrintSettings(
  { logo, companyName, email }: SetupWizardOptions,
  fyo: Fyo
) {
  const printSettings = await fyo.doc.getDoc('PrintSettings');
  await printSettings.setAndSync({
    logo,
    companyName,
    email,
    displayLogo: logo ? true : false,
  });
}

async function updateSystemSettings(
  { country, currency: companyCurrency }: SetupWizardOptions,
  fyo: Fyo
) {
  const countryInfo = getCountryInfo();
  const countryOptions = countryInfo[country] as CountryInfo;
  const currency =
    companyCurrency ?? countryOptions.currency ?? DEFAULT_CURRENCY;
  const locale = countryOptions.locale ?? DEFAULT_LOCALE;
  const countryCode = getCountryCodeFromCountry(country);
  const systemSettings = await fyo.doc.getDoc('SystemSettings');
  const instanceId = getRandomString();

  systemSettings.setAndSync({
    locale,
    currency,
    instanceId,
    countryCode,
  });
}

async function createCurrencyRecords(fyo: Fyo) {
  const promises: Promise<Doc | undefined>[] = [];
  const queue: string[] = [];
  const countrySettings = Object.values(getCountryInfo()) as CountryInfo[];

  for (const country of countrySettings) {
    const {
      currency,
      currency_fraction,
      currency_fraction_units,
      smallest_currency_fraction_value,
      currency_symbol,
    } = country;

    if (!currency || queue.includes(currency)) {
      continue;
    }

    const docObject = {
      name: currency,
      fraction: currency_fraction ?? '',
      fractionUnits: currency_fraction_units ?? 100,
      smallestValue: smallest_currency_fraction_value ?? 0.01,
      symbol: currency_symbol ?? '',
    };

    const doc = checkAndCreateDoc('Currency', docObject, fyo);
    if (doc) {
      promises.push(doc);
      queue.push(currency);
    }
  }
  return Promise.all(promises);
}

async function createAccountRecords(
  bankName: string,
  country: string,
  chartOfAccounts: string,
  fyo: Fyo
) {
  const createCOA = new CreateCOA(chartOfAccounts, fyo);
  await createCOA.run();
  const parentAccount = await getBankAccountParentName(country, fyo);
  const bankAccountDoc = {
    name: bankName,
    rootType: AccountRootTypeEnum.Asset,
    parentAccount,
    accountType: 'Bank',
    isGroup: false,
  };

  await checkAndCreateDoc('Account', bankAccountDoc, fyo);
  await createDiscountAccount(fyo);
  await setDefaultAccounts(fyo);
}

export async function createDiscountAccount(fyo: Fyo) {
  const incomeAccountName = fyo.t`Indirect Income`;
  const accountExists = await fyo.db.exists(
    ModelNameEnum.Account,
    incomeAccountName
  );

  if (!accountExists) {
    return;
  }

  const discountAccountName = fyo.t`Discounts`;
  const discountAccountDoc = {
    name: discountAccountName,
    rootType: AccountRootTypeEnum.Income,
    parentAccount: incomeAccountName,
    accountType: 'Income Account',
    isGroup: false,
  };

  await checkAndCreateDoc(ModelNameEnum.Account, discountAccountDoc, fyo);
  await fyo.singles.AccountingSettings!.setAndSync(
    'discountAccount',
    discountAccountName
  );
}

async function setDefaultAccounts(fyo: Fyo) {
  const accountMap: Record<string, string> = {
    writeOffAccount: fyo.t`Write Off`,
    roundOffAccount: fyo.t`Rounded Off`,
  };

  for (const key in accountMap) {
    const accountName = accountMap[key];
    const accountExists = await fyo.db.exists(
      ModelNameEnum.Account,
      accountName
    );

    if (!accountExists) {
      continue;
    }

    await fyo.singles.AccountingSettings!.setAndSync(key, accountName);
  }
}

async function completeSetup(companyName: string, fyo: Fyo) {
  await fyo.singles.AccountingSettings!.setAndSync('setupComplete', true);
}

async function checkAndCreateDoc(
  schemaName: string,
  docObject: DocValueMap,
  fyo: Fyo
) {
  const canCreate = await checkIfExactRecordAbsent(schemaName, docObject, fyo);
  if (!canCreate) {
    return;
  }

  const doc = await fyo.doc.getNewDoc(schemaName, docObject);
  return doc.sync();
}

async function checkIfExactRecordAbsent(
  schemaName: string,
  docMap: DocValueMap,
  fyo: Fyo
) {
  const name = docMap.name as string;
  const newDocObject = Object.assign({}, docMap);

  const rows = await fyo.db.getAllRaw(schemaName, {
    fields: ['*'],
    filters: { name },
  });

  if (rows.length === 0) {
    return true;
  }

  const storedDocObject = rows[0];
  const matchList = Object.keys(newDocObject).map((key) => {
    const newValue = newDocObject[key];
    const storedValue = storedDocObject[key];
    return newValue == storedValue; // Should not be type sensitive.
  });

  if (!matchList.every(Boolean)) {
    await fyo.db.delete(schemaName, name);
    return true;
  }

  return false;
}

async function getBankAccountParentName(country: string, fyo: Fyo) {
  const parentBankAccount = await fyo.db.getAllRaw('Account', {
    fields: ['*'],
    filters: { isGroup: true, accountType: 'Bank' },
  });

  if (parentBankAccount.length === 0) {
    // This should not happen if the fixtures are correct.
    return 'Bank Accounts';
  } else if (parentBankAccount.length > 1) {
    switch (country) {
      case 'Indonesia':
        return 'Bank Rupiah - 1121.000';
      default:
        break;
    }
  }

  return parentBankAccount[0].name;
}

async function createDefaultNumberSeries(fyo: Fyo) {
  await createNumberSeries('SINV-', 'SalesInvoice', DEFAULT_SERIES_START, fyo);
  await createNumberSeries(
    'PINV-',
    'PurchaseInvoice',
    DEFAULT_SERIES_START,
    fyo
  );
  await createNumberSeries('PAY-', 'Payment', DEFAULT_SERIES_START, fyo);
  await createNumberSeries('JV-', 'JournalEntry', DEFAULT_SERIES_START, fyo);
}
