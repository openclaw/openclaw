/**
 * Core Translator Module
 *
 * @fileoverview
 * Main translation function and i18n instance creation.
 * Handles interpolation, language switching, and fallback logic.
 *
 * @module i18n/translator
 */

import type {
  TranslationFile,
  TranslationParams,
  Translator,
  I18nConfig,
  Locale,
} from "./types.js";
import {
  DEFAULT_LOCALE,
  FALLBACK_STRING,
  availableLocales,
  type SupportedLocale,
} from "./config.js";
import { detectLocale } from "./detector.js";
import { loadAllTranslationFiles, getTranslationValue, translationKeyExists } from "./loader.js";

// Store for loaded translations (lazy loaded)
let loadedTranslations: Map<SupportedLocale, TranslationFile> | null = null;

// Current i18n instance
let currentInstance: I18nInstance | null = null;

/**
 * Internal translator implementation
 */
class I18nInstance implements Translator {
  private currentLocale: SupportedLocale;
  private fallbackLocale: SupportedLocale;
  private translations: Map<SupportedLocale, TranslationFile>;
  private warnOnMissing: boolean;
  private interpolationPrefix: string;
  private interpolationSuffix: string;

  constructor(
    locale: SupportedLocale,
    fallbackLocale: SupportedLocale,
    translations: Map<SupportedLocale, TranslationFile>,
    options?: Partial<I18nConfig>,
  ) {
    this.currentLocale = locale;
    this.fallbackLocale = fallbackLocale;
    this.translations = translations;
    this.warnOnMissing = options?.warnOnMissing ?? true;
    this.interpolationPrefix = options?.interpolation?.prefix ?? "{{";
    this.interpolationSuffix = options?.interpolation?.suffix ?? "}}";
  }

  /**
   * Translate a key with optional parameters
   */
  translate(key: string, params?: TranslationParams): string {
    // Try current locale first
    let translation = this.getTranslation(key, this.currentLocale);

    // Fall back to default locale if needed
    if (translation === null && this.fallbackLocale !== this.currentLocale) {
      translation = this.getTranslation(key, this.fallbackLocale);
    }

    // Use fallback string if still not found
    if (translation === null) {
      if (this.warnOnMissing && this.currentLocale !== DEFAULT_LOCALE) {
        console.warn(
          `[i18n] Missing translation for key: "${key}" in locale: ${this.currentLocale}`,
        );
      }
      return this.interpolate(FALLBACK_STRING.replace("{{key}}", key), params);
    }

    return this.interpolate(translation, params);
  }

  /**
   * Get translation value for a specific locale
   */
  private getTranslation(key: string, locale: SupportedLocale): string | null {
    const translationFile = this.translations.get(locale);
    if (!translationFile) {
      return null;
    }

    return getTranslationValue(translationFile, key);
  }

  /**
   * Interpolate parameters into translation string
   */
  private interpolate(text: string, params?: TranslationParams): string {
    if (!params || Object.keys(params).length === 0) {
      return text;
    }

    // Use configurable interpolation pattern
    const pattern = new RegExp(
      `${this.escapeRegex(this.interpolationPrefix)}([^}]+)${this.escapeRegex(this.interpolationSuffix)}`,
      "g",
    );

    return text.replace(pattern, (match, variableName) => {
      const trimmedName = variableName.trim();
      const value = params[trimmedName];
      // 当参数缺失时保留占位符，便于调试和发现问题
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Escape special regex characters in a string
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Change the current locale at runtime
   */
  setLocale(locale: Locale): void {
    if (!availableLocales.includes(locale as SupportedLocale)) {
      throw new Error(`Unsupported locale: ${locale}`);
    }
    this.currentLocale = locale as SupportedLocale;
  }

  /**
   * Get the current locale
   */
  getLocale(): Locale {
    return this.currentLocale as Locale;
  }

  /**
   * Check if a translation key exists
   */
  has(key: string): boolean {
    const translationFile = this.translations.get(this.currentLocale);
    if (!translationFile) {
      return false;
    }

    return translationKeyExists(translationFile, key);
  }

  /**
   * Get available namespaces for current locale
   */
  getNamespaces(): string[] {
    const translationFile = this.translations.get(this.currentLocale);
    if (!translationFile) {
      return [];
    }

    return Object.keys(translationFile);
  }

  /**
   * Get all keys in a namespace
   */
  getKeysByNamespace(namespace: string): Record<string, string> {
    const translationFile = this.translations.get(this.currentLocale);
    if (!translationFile) {
      return {};
    }

    const nsData = translationFile[namespace as keyof TranslationFile];
    if (!nsData || typeof nsData !== "object") {
      return {};
    }

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(nsData)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }

    return result;
  }
}

/**
 * Get or load translations (lazy loading)
 */
function getTranslations(): Map<SupportedLocale, TranslationFile> {
  if (!loadedTranslations) {
    loadedTranslations = loadAllTranslationFiles(availableLocales);
  }
  return loadedTranslations;
}

/**
 * Create a translator instance with specified locale
 *
 * @param locale - Locale to use (defaults to auto-detection)
 * @param options - Additional configuration options
 * @returns Translator instance
 *
 * @example
 * ```typescript
 * import { createI18n } from "./src/i18n/index.js";
 *
 * const t = createI18n("zh-CN");
 * console.log(t("errors.notFound", { file: "config.json" }));
 * ```
 */
export function createI18n(locale?: SupportedLocale, options?: Partial<I18nConfig>): Translator {
  const detectedLocale = locale || detectLocale();
  const translations = getTranslations();

  return new I18nInstance(
    detectedLocale,
    (options?.fallbackLocale ?? DEFAULT_LOCALE) as SupportedLocale,
    translations,
    options,
  );
}

/**
 * Default translator instance
 * Lazily initialized on first call
 */
function getDefaultTranslator(): Translator {
  if (!currentInstance) {
    currentInstance = new I18nInstance(detectLocale(), DEFAULT_LOCALE, getTranslations());
  }
  return currentInstance;
}

/**
 * Translate a key using the default translator
 *
 * @param key - Translation key (e.g., "errors.fileNotFound")
 * @param params - Optional parameters for interpolation
 * @returns Translated string
 *
 * @example
 * ```typescript
 * import { t } from "./src/i18n/index.js";
 *
 * t("errors.fileNotFound", { file: "config.json" });
 * // Returns: "File not found: config.json"
 * ```
 */
export function t(key: string, params?: TranslationParams): string {
  return getDefaultTranslator().translate(key, params);
}

/**
 * Get the current locale
 *
 * @returns Current active locale
 */
export function getLocale(): SupportedLocale {
  return getDefaultTranslator().getLocale() as SupportedLocale;
}

/**
 * Set the current locale
 *
 * @param locale - New locale to use
 */
export function setLocale(locale: SupportedLocale): void {
  getDefaultTranslator().setLocale(locale);
}

/**
 * Check if a translation key exists
 *
 * @param key - Translation key to check
 * @returns True if key exists in current locale
 */
export function has(key: string): boolean {
  return getDefaultTranslator().has(key);
}

/**
 * Get available namespaces
 *
 * @returns Array of namespace names
 */
export function getNamespaces(): string[] {
  return getDefaultTranslator().getNamespaces();
}

/**
 * Get all keys in a namespace for current locale
 *
 * @param namespace - Namespace to query
 * @returns Object with key-value pairs
 */
export function getKeysByNamespace(namespace: string): Record<string, string> {
  return getDefaultTranslator().getKeysByNamespace(namespace);
}

/**
 * Reset the i18n instance (useful for testing)
 */
export function resetI18n(): void {
  currentInstance = null;
  loadedTranslations = null;
}

/**
 * Force reload translation files
 */
export function reloadTranslations(): void {
  loadedTranslations = loadAllTranslationFiles(availableLocales);
}
