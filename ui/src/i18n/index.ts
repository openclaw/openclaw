/**
 * Lightweight i18n module for Control UI
 * 
 * Usage:
 *   import { t, setLocale, getLocale } from './i18n';
 *   
 *   // Get translated string
 *   t('nav.chat') // => "Chat" or "聊天"
 *   
 *   // Change locale
 *   setLocale('zh-CN');
 *   
 *   // Get current locale
 *   getLocale() // => 'zh-CN'
 */

import type { Locale, TranslationKey, TranslationKeys } from './types';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';

const STORAGE_KEY = 'moltbot-locale';

const locales: Record<Locale, TranslationKeys> = {
  'en': en,
  'zh-CN': zhCN,
};

let currentLocale: Locale = 'en';

/**
 * Detect the best locale based on browser settings
 */
function detectLocale(): Locale {
  // Check localStorage first
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isValidLocale(stored)) {
      return stored as Locale;
    }
  } catch {
    // localStorage not available
  }

  // Check browser language
  const browserLang = navigator.language || (navigator as any).userLanguage || 'en';
  
  // Check for exact match
  if (isValidLocale(browserLang)) {
    return browserLang as Locale;
  }
  
  // Check for language code match (e.g., 'zh' matches 'zh-CN')
  const langCode = browserLang.split('-')[0].toLowerCase();
  if (langCode === 'zh') {
    return 'zh-CN';
  }
  
  return 'en';
}

/**
 * Check if a locale is valid
 */
function isValidLocale(locale: string): locale is Locale {
  return locale in locales;
}

/**
 * Get the current locale
 */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Get all available locales
 */
export function getAvailableLocales(): Locale[] {
  return Object.keys(locales) as Locale[];
}

/**
 * Get locale display name
 */
export function getLocaleDisplayName(locale: Locale): string {
  switch (locale) {
    case 'en':
      return 'English';
    case 'zh-CN':
      return '简体中文';
    default:
      return locale;
  }
}

/**
 * Set the current locale
 */
export function setLocale(locale: Locale): void {
  if (!isValidLocale(locale)) {
    console.warn(`Invalid locale: ${locale}, falling back to 'en'`);
    locale = 'en';
  }
  
  currentLocale = locale;
  
  // Persist to localStorage
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // localStorage not available
  }
  
  // Dispatch event for components to react
  window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale } }));
}

/**
 * Get a translated string
 */
export function t(key: TranslationKey): string {
  const translations = locales[currentLocale] ?? locales['en'];
  return translations[key] ?? key;
}

/**
 * Get a translated string with interpolation
 * 
 * Usage:
 *   tf('greeting', { name: 'World' }) // "Hello, {name}!" => "Hello, World!"
 */
export function tf(key: TranslationKey, params: Record<string, string | number>): string {
  let result = t(key);
  for (const [param, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{${param}\\}`, 'g'), String(value));
  }
  return result;
}

/**
 * Initialize i18n with auto-detection
 */
export function initI18n(): Locale {
  currentLocale = detectLocale();
  return currentLocale;
}

// Auto-initialize on module load
initI18n();
