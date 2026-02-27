import { getSystemLocale } from "./locale.js";
import { translations, type TranslationKey } from "./translations.js";

let currentLocale: string = "en";

export function initI18n() {
  currentLocale = getSystemLocale();
}

export function setLocale(locale: string) {
  currentLocale = locale;
}

export function getLocale(): string {
  return currentLocale;
}

export function t(key: TranslationKey, params?: Record<string, string>): string {
  const localeTranslations = translations[currentLocale] ?? translations.en;
  let message = localeTranslations[key] ?? translations.en[key] ?? key;

  if (params) {
    for (const [param, value] of Object.entries(params)) {
      message = message.replace(new RegExp(`{{${param}}}`, "g"), value);
    }
  }

  return message;
}

export { type TranslationKey };
