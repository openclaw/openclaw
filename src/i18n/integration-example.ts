/**
 * Integration Example for i18n Module
 *
 * @fileoverview
 * This file demonstrates how to integrate the i18n module into various parts
 * of the OpenClaw application. Use these patterns when adding i18n support
 * to existing code.
 *
 * @module i18n/integration-example
 */

import { LOCALE_EN, LOCALE_ZH_CN } from "./config.js";
import { createI18n, t, setLocale, getLocale, has, type Translator } from "./index.js";

// =============================================================================
// PATTERN 1: Simple Function-Level Usage
// =============================================================================

/**
 * Example function using the simple t() helper
 * Use this for quick integration in small functions
 */
function displayErrorMessage(errorCode: string): void {
  // Simple translation with no parameters
  console.error(t("errors.unknown"));

  // Translation with parameters
  const errorMessage = t("errors.fileNotFound", { file: errorCode });
  console.error(errorMessage);
}

// 示例函数导出，避免未使用警告
export { displayErrorMessage };

// =============================================================================
// PATTERN 2: Class-Based Usage with Dedicated Translator
// =============================================================================

/**
 * Example service class with i18n integration
 * Use this pattern for services that need consistent translation behavior
 */
class ConfigurationService {
  private translator: Translator;

  constructor() {
    // Create a dedicated translator instance for this service
    this.translator = createI18n(getLocale());
  }

  /**
   * Load configuration with translated status messages
   */
  async loadConfig(_configPath: string): Promise<void> {
    console.log(t("status.loading"));

    try {
      // ... loading logic ...
      console.log(t("status.success"));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(t("errors.loadFailed", { reason: errorMessage }));
      throw error;
    }
  }

  /**
   * Save configuration with translated prompts
   */
  async saveConfig(configPath: string, overwrite: boolean = false): Promise<void> {
    if (!overwrite && has("validation.fileExists")) {
      const confirmMessage = t("wizards.overwriteConfig");
      const shouldOverwrite = await confirm({
        message: confirmMessage,
      });
      if (!shouldOverwrite) {
        return;
      }
    }

    console.log(t("status.saving"));
    // ... save logic ...
    console.log(`Config saved to: ${configPath}`);
  }

  /**
   * Switch language at runtime
   */
  setLanguage(locale: string): void {
    setLocale(locale as unknown as Parameters<typeof setLocale>[0]);
    console.log(t("status.languageChanged", { language: locale }));
  }
}

// 示例类导出，避免未使用警告
export { ConfigurationService };

// =============================================================================
// PATTERN 3: CLI Command Integration
// =============================================================================

/**
 * Example CLI command with i18n support
 */
interface StatusCommandOptions {
  json?: boolean;
  lang?: string;
}

function handleStatusCommand(options: StatusCommandOptions): void {
  // Set locale from CLI flag if provided
  if (options.lang) {
    setLocale(options.lang as unknown as Parameters<typeof setLocale>[0]);
  }

  // Use translated messages
  const status = {
    running: t("status.running"),
    uptime: t("status.uptime", { uptime: process.uptime() }),
  };

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`${t("status.running")}: ${status.uptime}`);
  }
}

// 示例函数导出，避免未使用警告
export { handleStatusCommand };

// =============================================================================
// PATTERN 4: Wizard/Interactive Prompt Integration
// =============================================================================

/**
 * Example wizard step with i18n support
 * Uses @clack/prompts with translated messages
 */
import { confirm, select } from "@clack/prompts";

async function setupLanguageStep(): Promise<string> {
  const language = await select({
    message: t("wizards.selectLanguage"),
    options: [
      { value: "en", label: "English" },
      { value: "zh-CN", label: "简体中文" },
    ],
  });

  if (language) {
    setLocale(language as unknown as Parameters<typeof setLocale>[0]);
  }

  return language as string;
}

// 示例函数导出，避免未使用警告
export { setupLanguageStep };

async function setupConfirmationStep(): Promise<boolean> {
  const confirmed = await confirm({
    message: t("wizards.saveConfigPrompt"),
    initialValue: true,
  });

  return confirmed === true;
}

// 示例函数导出，避免未使用警告
export { setupConfirmationStep };

// =============================================================================
// PATTERN 5: Error Handling Integration
// =============================================================================

/**
 * Example error handling with translated error messages
 */
class AppError extends Error {
  constructor(messageKey: string, params?: Record<string, string>) {
    // Translate the error message
    const translatedMessage = t(messageKey, params);
    super(translatedMessage);
    this.name = "AppError";
  }
}

function handleError(error: unknown): void {
  if (error instanceof AppError) {
    console.error(`${t("common.error")}: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(t("errors.unknown"));
    console.error(error.message);
  } else {
    console.error(t("errors.unknown"));
  }
}

// 示例函数导出，避免未使用警告
export { handleError };

// =============================================================================
// PATTERN 6: Validation Messages Integration
// =============================================================================

/**
 * Example form validation with translated messages
 */
interface FormData {
  email?: string;
  name?: string;
  age?: number;
}

function validateForm(data: FormData): string[] {
  const errors: string[] = [];

  if (!data.email) {
    errors.push(t("validation.requiredField", { field: "Email" }));
  } else if (!data.email.includes("@")) {
    errors.push(t("validation.emailInvalid"));
  }

  if (!data.name || data.name.length < 2) {
    errors.push(t("validation.minLength", { min: 2 }));
  }

  if (data.age !== undefined && data.age < 0) {
    errors.push(t("validation.positiveNumber"));
  }

  return errors;
}

// 示例函数导出，避免未使用警告
export { validateForm };

// =============================================================================
// PATTERN 7: Dynamic Status Updates
// =============================================================================

/**
 * Example status display with dynamic updates
 */
function displaySystemStatus(memoryUsage: string, cpuUsage: string): void {
  console.log(t("status.memoryUsage", { usage: memoryUsage }));
  console.log(t("status.cpuUsage", { usage: cpuUsage }));
}

// 示例函数导出，避免未使用警告
export { displaySystemStatus };

// =============================================================================
// PATTERN 8: Initialization with Language Detection
// =============================================================================

/**
 * Example application initialization with language setup
 */
async function initializeApp(): Promise<void> {
  // Language is automatically detected from:
  // 1. OPENCLAW_LOCALE environment variable
  // 2. --lang CLI flag
  // 3. System locale
  // 4. Default fallback (English)

  console.log(t("status.starting"));

  // Allow runtime language switching
  const detectedLocale = getLocale();
  console.log(t("status.detectedLanguage", { language: detectedLocale }));

  // ... rest of initialization ...
}

// 示例函数导出，避免未使用警告
export { initializeApp };

// =============================================================================
// PATTERN 9: Plugin/Extension Integration
// =============================================================================

/**
 * Example plugin registration with i18n support
 */
interface PluginInfo {
  name: string;
  version: string;
  descriptionKey: string;
}

function registerPlugin(plugin: PluginInfo): void {
  // Use translated description if available
  const _description = has(plugin.descriptionKey)
    ? t(plugin.descriptionKey)
    : plugin.descriptionKey; // Fallback to key if not translated

  console.log(`${t("status.registeringPlugin")}: ${plugin.name}`);
  // ... registration logic ...
  console.log(t("status.pluginRegistered", { name: plugin.name }));
}

// 示例函数导出，避免未使用警告
export { registerPlugin };

// =============================================================================
// PATTERN 10: Testing with i18n
// =============================================================================

/**
 * Example test setup with i18n
 */
import { describe, it, expect, beforeEach } from "vitest";

describe("Feature with i18n", () => {
  beforeEach(() => {
    // Reset to default locale before each test
    setLocale(LOCALE_EN);
  });

  it("should display error in English", () => {
    setLocale(LOCALE_EN);
    expect(t("errors.notFound", { item: "test" })).toBe("test not found");
  });

  it("should display error in Chinese", () => {
    setLocale(LOCALE_ZH_CN);
    expect(t("errors.notFound", { item: "test" })).toBe("未找到test");
  });
});

// =============================================================================
// USAGE GUIDE
// =============================================================================

/*
 * QUICK START:
 *
 * 1. Basic usage - just use t() anywhere:
 *    t("errors.fileNotFound", { file: "config.json" })
 *
 * 2. Set language programmatically:
 *    setLocale("zh-CN")
 *
 * 3. Check if a key exists:
 *    has("errors.notFound")
 *
 * 4. Get current locale:
 *    getLocale()
 *
 * 5. Create dedicated translator for classes:
 *    this.t = createI18n(getLocale())
 *
 * KEY CONVENTIONS:
 *
 * - Translation keys use dot notation: "namespace.key"
 * - Placeholders use double curly braces: {{variableName}}
 * - Namespace groups: cli, errors, wizards, status, validation, common
 * - Fallback language is English (en)
 *
 * ENVIRONMENT VARIABLES:
 *
 * - OPENCLAW_LOCALE: Override detected locale (e.g., "zh-CN")
 *
 * CLI FLAGS:
 *
 * --lang <locale>: Set locale via command line
 * --locale <locale>: Same as --lang
 */
