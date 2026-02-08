/**
 * i18n Utility Module
 *
 * @fileoverview
 * Internationalization utility for OpenClaw CLI application.
 * Provides language detection, translation function, and language switching capabilities.
 *
 * @module i18n
 */

export type { I18nConfig, TranslationParams, Translator, Locale } from "./types.js";
export {
  createI18n,
  t,
  setLocale,
  getLocale,
  has,
  getNamespaces,
  getKeysByNamespace,
  resetI18n,
  reloadTranslations,
} from "./translator.js";
export { detectLocale, getSystemLocale } from "./detector.js";
export { DEFAULT_LOCALE, LOCALE_EN, LOCALE_ZH_CN, availableLocales } from "./config.js";
