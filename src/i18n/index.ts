import en from "./en.json";
import uk from "./uk.json";

export type Locale = "en" | "uk";

const locales: Record<Locale, typeof en> = { en, uk };

let currentLocale: Locale = "en";

/**
 * Set the active locale.
 */
export function setLocale(locale: Locale): void {
  if (!locales[locale]) throw new Error(`Unknown locale: ${locale}`);
  currentLocale = locale;
}

/**
 * Get the active locale.
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Retrieve a translated string by dot-path (e.g. "commands.help.description").
 * Supports simple {placeholder} interpolation.
 */
export function t(key: string, params?: Record<string, string>): string {
  const parts = key.split(".");
  let value: any = locales[currentLocale];
  for (const part of parts) {
    value = value?.[part];
  }
  if (typeof value !== "string") {
    // Fallback to English
    value = locales.en as any;
    for (const part of parts) {
      value = value?.[part];
    }
  }
  if (typeof value !== "string") return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replace(`{${k}}`, v);
    }
  }
  return value;
}

/**
 * Get the list of available locales.
 */
export function availableLocales(): Locale[] {
  return Object.keys(locales) as Locale[];
}
