/**
 * Simple i18n system for OpenClaw Onboarding UI
 */

import en from "./en.js";
import zh from "./zh.js";

export type Locale = "en" | "zh";
export type TranslationKey = keyof typeof en;

const translations: Record<Locale, Record<string, string>> = { en, zh };
let currentLocale: Locale = detectLocale();

/**
 * Detect user's preferred locale from browser settings
 */
function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith("zh")) return "zh";
  return "en";
}

/**
 * Get translated string for a key
 */
export function t(key: string): string {
  return translations[currentLocale][key] ?? translations.en[key] ?? key;
}

/**
 * Get current locale
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Set current locale
 */
export function setLocale(locale: Locale): void {
  currentLocale = locale;
  // Dispatch event for reactive updates
  window.dispatchEvent(new CustomEvent("locale-changed", { detail: { locale } }));
}

/**
 * Toggle between locales
 */
export function toggleLocale(): void {
  setLocale(currentLocale === "en" ? "zh" : "en");
}
