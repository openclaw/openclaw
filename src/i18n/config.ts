/**
 * i18n Configuration
 *
 * @fileoverview
 * Centralized configuration for internationalization settings.
 * Defines supported locales, default locale, and configuration constants.
 *
 * @module i18n/config
 */

// Supported locales in the application
export const LOCALE_EN = "en" as const;
export const LOCALE_ZH_CN = "zh-CN" as const;
export const LOCALE_ZH_TW = "zh-TW" as const;

export type SupportedLocale = typeof LOCALE_EN | typeof LOCALE_ZH_CN | typeof LOCALE_ZH_TW;

// Array of all available locales for iteration
export const availableLocales: SupportedLocale[] = [LOCALE_EN, LOCALE_ZH_CN, LOCALE_ZH_TW];

// Default locale (fallback when detection fails or translation is missing)
export const DEFAULT_LOCALE = LOCALE_EN;

// Environment variable name for locale override
export const LOCALE_ENV_VAR = "OPENCLAW_LOCALE";

// CLI flag name for locale override
export const LOCALE_CLI_FLAG = "lang";

// Path pattern for locale files (relative to project root or dist directory)
export const LOCALE_FILE_PATTERN = "locales/{{locale}}.json";

// Namespace separator for translation keys
export const NAMESPACE_SEPARATOR = ":";

// Fallback string when translation is not found
// Includes {{key}} placeholder for the missing translation key
export const FALLBACK_STRING = "[missing translation: {{key}}]";

// Interpolation pattern for variable substitution
export const INTERPOLATION_PATTERN = /\{\{([^}]+)\}\}/g;
