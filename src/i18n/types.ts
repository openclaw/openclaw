/**
 * i18n Type Definitions
 *
 * @fileoverview
 * TypeScript type definitions for the internationalization module.
 * Provides interfaces for configuration, translation parameters, and locale support.
 *
 * @module i18n/types
 */

/**
 * Supported locale type
 */
export type Locale = string;

/**
 * Parameters for translation interpolation
 * Keys correspond to placeholder names in translation strings
 *
 * @example
 * ```typescript
 * const params: TranslationParams = {
 *   appName: "OpenClaw",
 *   count: 5,
 *   user: "John"
 * };
 * ```
 */
export type TranslationParams = Record<string, string | number | boolean>;

/**
 * Translation namespace categories
 * Organizes translations into logical groups for better maintainability
 */
export type TranslationNamespace =
  | "cli" // CLI commands and prompts
  | "errors" // Error messages
  | "wizards" // Wizard step messages
  | "status" // Status and progress messages
  | "validation" // Input validation messages
  | "common"; // Common strings (yes/no, ok/cancel, etc.)

/**
 * Complete translation key format
 * Combines namespace with dot notation for hierarchical keys
 *
 * @example
 * "errors.fileNotFound" - Error message for missing file
 * "wizards.welcome.title" - Wizard welcome screen title
 */
export type TranslationKey = `${TranslationNamespace}.${string}`;

/**
 * Translation file structure
 * Top-level keys are namespaces, each containing nested translation keys
 */
export interface TranslationFile {
  /** Index signature for dynamic namespace access */
  [namespace: string]: Record<string, string> | undefined;
  /** CLI-related translations */
  cli?: Record<string, string>;
  /** Error message translations */
  errors?: Record<string, string>;
  /** Wizard prompt translations */
  wizards?: Record<string, string>;
  /** Status and progress message translations */
  status?: Record<string, string>;
  /** Validation message translations */
  validation?: Record<string, string>;
  /** Common UI strings */
  common?: Record<string, string>;
}

/**
 * i18n configuration options
 */
export interface I18nConfig {
  /** Current locale to use */
  locale: Locale;
  /** Default fallback locale */
  fallbackLocale: Locale;
  /** Whether to warn on missing translations (development only) */
  warnOnMissing: boolean;
  /** Custom interpolation options */
  interpolation?: {
    /** Prefix for interpolation variables */
    prefix?: string;
    /** Suffix for interpolation variables */
    suffix?: string;
  };
}

/**
 * Translator interface
 * Provides the core translation functionality
 */
export interface Translator {
  /**
   * Translate a key with optional parameters
   *
   * @param key - Translation key (e.g., "errors.fileNotFound")
   * @param params - Optional parameters for interpolation
   * @returns Translated string with parameters substituted
   *
   * @example
   * ```typescript
   * const i18n = createTranslator();
   * i18n.translate("errors.fileNotFound", { file: "config.json" });
   * // Returns: "File not found: config.json"
   * ```
   */
  translate(key: string, params?: TranslationParams): string;

  /**
   * Change the current locale at runtime
   *
   * @param locale - New locale to use
   */
  setLocale(locale: Locale): void;

  /**
   * Get the current locale
   *
   * @returns Current active locale
   */
  getLocale(): Locale;

  /**
   * Check if a translation key exists
   *
   * @param key - Translation key to check
   * @returns True if key exists in current locale
   */
  has(key: string): boolean;

  /**
   * Get available namespaces for current locale
   *
   * @returns Array of namespace names
   */
  getNamespaces(): string[];

  /**
   * Get all keys in a namespace
   *
   * @param namespace - Namespace to query
   * @returns Object with key-value pairs
   */
  getKeysByNamespace(namespace: string): Record<string, string>;
}
