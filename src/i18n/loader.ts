/**
 * Translation File Loader
 *
 * @fileoverview
 * Handles loading and parsing of translation files from the filesystem.
 * Supports JSON format with namespace organization.
 *
 * @module i18n/loader
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { TranslationFile } from "./types.js";
import { LOCALE_FILE_PATTERN, type SupportedLocale } from "./config.js";

// Get the directory where this module is located
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find the project root directory
 * Handles both development and production (dist) environments
 *
 * @returns Absolute path to project root
 */
function findProjectRoot(): string {
  // Try to find from current module location
  let currentDir = __dirname;

  // Navigate up to find package.json or project marker
  const markers = ["package.json", "tsconfig.json", ".git"];

  for (let i = 0; i < 10; i++) {
    // Check if current directory has any marker
    for (const marker of markers) {
      const fullPath = path.join(currentDir, marker);
      if (fs.existsSync(fullPath)) {
        return currentDir;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parentDir;
  }

  // Fallback to current working directory
  return process.cwd();
}

/**
 * Get the path to a locale file
 *
 * @param locale - Target locale code
 * @param customPattern - Optional custom file pattern
 * @returns Absolute path to locale file
 */
export function getLocaleFilePath(locale: SupportedLocale, customPattern?: string): string {
  const projectRoot = findProjectRoot();
  const pattern = customPattern || LOCALE_FILE_PATTERN;

  // Replace {{locale}} placeholder with actual locale code
  const filePath = pattern.replace("{{locale}}", locale);

  // First check in dist/locales (production)
  const distPath = path.join(projectRoot, "dist", filePath);
  if (fs.existsSync(distPath)) {
    return distPath;
  }

  // Then check in locales at root (development)
  const rootPath = path.join(projectRoot, filePath);
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }

  // Finally check in src/i18n/locales
  const srcLocalesPath = path.join(__dirname, "locales", `${locale}.json`);
  if (fs.existsSync(srcLocalesPath)) {
    return srcLocalesPath;
  }

  return rootPath;
}

/**
 * Load and parse a translation file
 *
 * @param locale - Locale to load
 * @returns Parsed translation file or null if not found
 *
 * @throws Error if file exists but cannot be parsed
 */
export function loadTranslationFile(locale: SupportedLocale): TranslationFile | null {
  const filePath = getLocaleFilePath(locale);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content);

    // Validate structure
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`Invalid translation file structure for locale: ${locale}`);
    }

    return parsed as TranslationFile;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse translation file for locale ${locale}: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Load all available translation files
 *
 * @param locales - Array of locales to load
 * @returns Map of locale to translation file
 */
export function loadAllTranslationFiles(
  locales: SupportedLocale[],
): Map<SupportedLocale, TranslationFile> {
  const translations = new Map<SupportedLocale, TranslationFile>();

  for (const locale of locales) {
    const translation = loadTranslationFile(locale);
    if (translation) {
      translations.set(locale, translation);
    }
  }

  return translations;
}

/**
 * Check if a translation key exists in a translation file
 *
 * @param translations - Translation file to search
 * @param key - Key to find (with namespace, e.g., "errors.notFound")
 * @returns True if key exists
 */
export function translationKeyExists(translations: TranslationFile, key: string): boolean {
  const parts = key.split(".");
  let current: Record<string, unknown> = translations;

  for (const part of parts) {
    if (current === undefined || current === null || typeof current !== "object") {
      return false;
    }
    current = current[part] as Record<string, unknown>;
  }

  return current !== undefined;
}

/**
 * Get a translation value by key path
 *
 * @param translations - Translation file to search
 * @param key - Key to find (with namespace, e.g., "errors.notFound")
 * @returns Translation string or null if not found
 */
export function getTranslationValue(translations: TranslationFile, key: string): string | null {
  const parts = key.split(".");
  let current: Record<string, unknown> = translations;

  for (const part of parts) {
    if (current === undefined || current === null || typeof current !== "object") {
      return null;
    }
    current = current[part] as Record<string, unknown>;
  }

  return typeof current === "string" ? current : null;
}

/**
 * Get all keys from a namespace
 *
 * @param translations - Translation file
 * @param namespace - Namespace to extract (e.g., "errors")
 * @returns Object with all keys in namespace
 */
export function getNamespace(
  translations: TranslationFile,
  namespace: string,
): Record<string, string> | null {
  const nsKey = namespace as keyof TranslationFile;
  const namespaceData = translations[nsKey];

  if (!namespaceData || typeof namespaceData !== "object") {
    return null;
  }

  // Filter to only string values
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(namespaceData)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return result;
}
