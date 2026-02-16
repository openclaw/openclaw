import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import ja from "./ja.json";
import pl from "./pl.json";
import pt from "./pt.json";
import tr from "./tr.json";
import uk from "./uk.json";
import zh from "./zh.json";

export type Locale = "en" | "uk" | "de" | "es" | "fr" | "pt" | "ja" | "zh" | "pl" | "tr";

const locales: Record<Locale, typeof en> = {
  en,
  uk,
  de,
  es,
  fr,
  pt,
  ja,
  zh,
  pl,
  tr,
};

let currentLocale: Locale = "en";

/**
 * Set the active locale.
 */
export function setLocale(locale: Locale): void {
  if (!locales[locale]) {
    throw new Error(`Unknown locale: ${locale}`);
  }
  currentLocale = locale;
}

/**
 * Get the active locale.
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Detect locale from config or system.
 * Priority: config.agents.defaults.locale -> system LANG/LC_ALL -> "en"
 */
export function detectLocale(config?: { agents?: { defaults?: { locale?: string } } }): Locale {
  // 1. Try config first
  const configLocale = config?.agents?.defaults?.locale;
  if (configLocale && isValidLocale(configLocale)) {
    return configLocale;
  }

  // 2. Try system environment
  const systemLang = process.env.LC_ALL || process.env.LANG || process.env.LANGUAGE || "";
  const langCode = systemLang.split("_")[0]?.split(".")[0]?.toLowerCase();

  if (langCode) {
    // Map common language codes to our supported locales
    const langMap: Record<string, Locale> = {
      en: "en",
      uk: "uk",
      ua: "uk", // Ukrainian alternative
      de: "de",
      es: "es",
      fr: "fr",
      pt: "pt",
      ja: "ja",
      jp: "ja", // Japanese alternative
      zh: "zh",
      cn: "zh", // Chinese alternative
      pl: "pl",
      tr: "tr",
    };

    const detectedLocale = langMap[langCode];
    if (detectedLocale) {
      return detectedLocale;
    }
  }

  // 3. Default fallback
  return "en";
}

/**
 * Check if a string is a valid locale.
 */
function isValidLocale(locale: string): locale is Locale {
  return Object.keys(locales).includes(locale);
}

/**
 * Initialize locale from config and environment.
 */
export function initializeLocale(config?: { agents?: { defaults?: { locale?: string } } }): void {
  const detectedLocale = detectLocale(config);
  setLocale(detectedLocale);
}

/**
 * Retrieve a translated string by dot-path (e.g. "commands.help.description").
 * Supports simple {placeholder} interpolation.
 */
export function t(key: string, params?: Record<string, string>): string {
  const parts = key.split(".");
  let value: unknown = locales[currentLocale];
  for (const part of parts) {
    value = value?.[part];
  }
  if (typeof value !== "string") {
    // Fallback to English
    value = locales.en as unknown;
    for (const part of parts) {
      value = value?.[part];
    }
  }
  if (typeof value !== "string") {
    return key;
  }
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

/**
 * Get locale display names in their native language.
 */
export function getLocaleDisplayNames(): Record<Locale, string> {
  return {
    en: "English",
    uk: "Українська",
    de: "Deutsch",
    es: "Español",
    fr: "Français",
    pt: "Português",
    ja: "日本語",
    zh: "简体中文",
    pl: "Polski",
    tr: "Türkçe",
  };
}
