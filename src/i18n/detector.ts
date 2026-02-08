/**
 * Language Detection Module
 *
 * @fileoverview
 * Provides language detection capabilities for the i18n system.
 * Supports detection via environment variables, CLI flags, and system locale.
 *
 * @module i18n/detector
 */

import {
  LOCALE_ENV_VAR,
  LOCALE_CLI_FLAG,
  DEFAULT_LOCALE,
  availableLocales,
  type SupportedLocale,
} from "./config.js";

/**
 * Get system locale from environment variables
 * Checks common OS and Node.js environment variables
 *
 * @returns Detected system locale or null if not determinable
 */
export function getSystemLocale(): SupportedLocale | null {
  // Check common environment variables in priority order
  // Standard locale environment variables per POSIX and common conventions
  const localeEnvVars = ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"];

  for (const envVar of localeEnvVars) {
    const value = process.env[envVar];
    if (value) {
      // Parse locale from environment variable
      // Format is typically: language_TERRITORY or language_TERRITORY.encoding
      const normalized = normalizeLocaleCode(value);
      if (normalized) {
        return normalized;
      }
    }
  }

  // Try Intl API as fallback
  if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {
    try {
      const userLocale = Intl.DateTimeFormat().resolvedOptions().locale;
      const normalized = normalizeLocaleCode(userLocale);
      if (normalized) {
        return normalized;
      }
    } catch {
      // Intl API not fully supported, continue
    }
  }

  return null;
}

/**
 * Normalize locale code to supported format
 *
 * @param code - Raw locale code from system
 * @returns Normalized locale code or null if not supported
 */
function normalizeLocaleCode(code: string): SupportedLocale | null {
  if (!code || typeof code !== "string") {
    return null;
  }

  // Remove encoding suffix (e.g., en_US.UTF-8 -> en_US)
  const baseCode = code.split(".")[0].split("@")[0];

  // Map common locale codes to supported locales
  const localeMappings: Record<string, SupportedLocale> = {
    // English
    en: "en",
    en_US: "en",
    en_GB: "en",
    en_CA: "en",
    en_AU: "en",
    "en_US.UTF-8": "en",
    "en_GB.UTF-8": "en",

    // Chinese Simplified (Mainland China)
    zh: "zh-CN",
    zh_CN: "zh-CN",
    "zh_CN.UTF-8": "zh-CN",
    zh_Hans: "zh-CN",
    zh_Hans_CN: "zh-CN",

    // Chinese Traditional
    zh_TW: "zh-TW",
    zh_HK: "zh-TW",
    "zh_TW.UTF-8": "zh-TW",
    "zh_HK.UTF-8": "zh-TW",
    zh_Hant: "zh-TW",
    zh_Hant_TW: "zh-TW",
  };

  return localeMappings[baseCode] || null;
}

/**
 * Detect locale from command line arguments
 *
 * @param args - Command line arguments array
 * @returns Detected locale from CLI or null
 */
export function detectLocaleFromArgs(args: string[]): SupportedLocale | null {
  // Look for --lang or --locale flag
  const langIndex = args.findIndex((arg) => arg === `--${LOCALE_CLI_FLAG}` || arg === `--locale`);

  if (langIndex !== -1 && args[langIndex + 1]) {
    const detected = normalizeLocaleCode(args[langIndex + 1]);
    if (detected) {
      return detected;
    }
  }

  // Also check for short form -l
  const shortLangIndex = args.findIndex((arg) => arg === `-${LOCALE_CLI_FLAG}`);
  if (shortLangIndex !== -1 && args[shortLangIndex + 1]) {
    const detected = normalizeLocaleCode(args[shortLangIndex + 1]);
    if (detected) {
      return detected;
    }
  }

  return null;
}

/**
 * Main locale detection function
 * Checks multiple sources in priority order:
 * 1. Environment variable (OPENCLAW_LOCALE)
 * 2. CLI arguments
 * 3. System locale
 * 4. Default locale
 *
 * @param args - Optional command line arguments for CLI flag detection
 * @returns Detected locale
 */
export function detectLocale(args?: string[]): SupportedLocale {
  // Priority 1: Environment variable override
  const envLocale = process.env[LOCALE_ENV_VAR];
  if (envLocale) {
    const normalized = normalizeLocaleCode(envLocale);
    if (normalized) {
      return normalized;
    }
  }

  // Priority 2: CLI argument
  if (args && args.length > 0) {
    const cliLocale = detectLocaleFromArgs(args);
    if (cliLocale) {
      return cliLocale;
    }
  }

  // Priority 3: System locale
  const systemLocale = getSystemLocale();
  if (systemLocale) {
    return systemLocale;
  }

  // Priority 4: Fallback to default
  return DEFAULT_LOCALE;
}

/**
 * Validate if a locale is supported
 *
 * @param locale - Locale code to validate
 * @returns True if locale is supported
 */
export function isLocaleSupported(locale: string): boolean {
  const normalized = normalizeLocaleCode(locale);
  if (!normalized) {
    return false;
  }

  return availableLocales.includes(normalized);
}

/**
 * Get locale display name in English
 *
 * @param locale - Locale code
 * @returns Human-readable locale name
 */
export function getLocaleDisplayName(locale: SupportedLocale): string {
  const displayNames: Record<SupportedLocale, string> = {
    en: "English",
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
  };

  return displayNames[locale] || locale;
}
