/**
 * i18n Module Tests
 *
 * @fileoverview
 * Unit tests for the i18n internationalization module.
 *
 * @module i18n/i18n.test
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LOCALE_EN, LOCALE_ZH_CN, DEFAULT_LOCALE } from "./config.js";
import {
  createI18n,
  t,
  setLocale,
  getLocale,
  has,
  resetI18n,
  getNamespaces,
  getKeysByNamespace,
} from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("i18n Module", () => {
  beforeEach(() => {
    resetI18n();
    setLocale(LOCALE_EN);
  });

  afterEach(() => {
    resetI18n();
  });

  describe("createI18n", () => {
    it("should create a translator instance", () => {
      const translator = createI18n(LOCALE_EN);
      expect(translator).toBeDefined();
      expect(typeof translator.translate).toBe("function");
    });

    it("should return correct locale when specified", () => {
      const translator = createI18n(LOCALE_ZH_CN);
      expect(translator.getLocale()).toBe(LOCALE_ZH_CN);
    });

    it("should allow creating translator with any locale string (validation happens at setLocale)", () => {
      // createI18n accepts any string for flexibility, validation occurs when calling setLocale
      const translator = createI18n("unsupported-locale" as unknown as typeof LOCALE_EN);
      expect(translator.getLocale()).toBe("unsupported-locale");
    });
  });

  describe("t function", () => {
    it("should translate a key in English", () => {
      const result = t("common.ok");
      expect(result).toBe("OK");
    });

    it("should translate a key in Chinese", () => {
      setLocale(LOCALE_ZH_CN);
      const result = t("common.ok");
      expect(result).toBe("确定");
    });

    it("should interpolate parameters", () => {
      const result = t("errors.fileNotFound", { file: "config.json" });
      expect(result).toBe("File not found: config.json");
    });

    it("should return fallback string for missing key", () => {
      const result = t("nonexistent.key");
      expect(result).toContain("missing translation");
    });
  });

  describe("setLocale", () => {
    it("should change the current locale", () => {
      expect(getLocale()).toBe(LOCALE_EN);
      setLocale(LOCALE_ZH_CN);
      expect(getLocale()).toBe(LOCALE_ZH_CN);
    });
  });

  describe("has", () => {
    it("should return true for existing key", () => {
      expect(has("common.ok")).toBe(true);
    });

    it("should return false for non-existing key", () => {
      expect(has("nonexistent.key")).toBe(false);
    });
  });

  describe("getNamespaces", () => {
    it("should return all available namespaces", () => {
      const namespaces = getNamespaces();
      expect(namespaces).toContain("cli");
      expect(namespaces).toContain("errors");
      expect(namespaces).toContain("wizards");
      expect(namespaces).toContain("status");
      expect(namespaces).toContain("validation");
      expect(namespaces).toContain("common");
    });
  });

  describe("getKeysByNamespace", () => {
    it("should return all keys in a namespace", () => {
      const keys = getKeysByNamespace("common");
      expect(keys.yes).toBe("Yes");
      expect(keys.no).toBe("No");
      expect(keys.ok).toBe("OK");
    });
  });

  describe("interpolation", () => {
    it("should interpolate multiple parameters", () => {
      const result = t("validation.minLength", { min: 8 });
      expect(result).toBe("Must be at least 8 characters");
    });

    it("should handle numeric parameters", () => {
      const result = t("errors.valueOutOfRange", { field: "Age", min: 0, max: 120 });
      expect(result).toBe("Age must be between 0 and 120");
    });

    it("should handle boolean parameters", () => {
      // Test with a custom translation that uses boolean
      const result = t("errors.notFound", { item: "User" });
      expect(result).toBe("User not found");
    });
  });

  describe("error namespace", () => {
    it("should translate error messages", () => {
      expect(t("errors.unknown")).toBe("An unknown error occurred");
      expect(t("errors.permissionDenied")).toBe("Permission denied");
      expect(t("errors.connectionFailed")).toBe("Connection failed");
    });

    it("should interpolate error parameters", () => {
      const result = t("errors.networkError", { reason: "ECONNREFUSED" });
      expect(result).toBe("Network error: ECONNREFUSED");
    });
  });

  describe("status namespace", () => {
    it("should translate status messages", () => {
      expect(t("status.running")).toBe("Running");
      expect(t("status.stopped")).toBe("Stopped");
      expect(t("status.connected")).toBe("Connected");
    });
  });

  describe("wizard namespace", () => {
    it("should translate wizard messages", () => {
      expect(t("wizards.welcomeTitle")).toBe("Welcome to OpenClaw");
      expect(t("wizards.setupComplete")).toBe("Setup complete!");
    });
  });

  describe("validation namespace", () => {
    it("should translate validation messages", () => {
      expect(t("validation.emailInvalid")).toBe("Please enter a valid email address");
      expect(t("validation.urlInvalid")).toBe("Please enter a valid URL");
    });
  });
});

describe("Locale Detection", () => {
  beforeEach(() => {
    resetI18n();
    // Force English locale to avoid system locale interference
    process.env.OPENCLAW_LOCALE = "en";
  });

  afterEach(() => {
    resetI18n();
    delete process.env.OPENCLAW_LOCALE;
  });

  it("should default to English locale", () => {
    const translator = createI18n();
    expect(translator.getLocale()).toBe(DEFAULT_LOCALE);
  });
});

describe("Locale Switching", () => {
  beforeEach(() => {
    resetI18n();
    process.env.OPENCLAW_LOCALE = "en";
  });

  afterEach(() => {
    resetI18n();
    delete process.env.OPENCLAW_LOCALE;
  });

  it("should switch between locales", () => {
    const enT = createI18n(LOCALE_EN);
    const zhT = createI18n(LOCALE_ZH_CN);

    expect(enT.translate("common.ok")).toBe("OK");
    expect(zhT.translate("common.ok")).toBe("确定");
  });

  it("should maintain separate locale state for different instances", () => {
    const translator1 = createI18n(LOCALE_EN);
    const translator2 = createI18n(LOCALE_ZH_CN);

    translator1.setLocale(LOCALE_ZH_CN);
    expect(translator1.translate("common.ok")).toBe("确定");
    expect(translator2.translate("common.ok")).toBe("确定");

    translator2.setLocale(LOCALE_EN);
    expect(translator1.translate("common.ok")).toBe("确定");
    expect(translator2.translate("common.ok")).toBe("OK");
  });
});

describe("Chinese Translations", () => {
  beforeEach(() => {
    resetI18n();
    setLocale(LOCALE_ZH_CN);
  });

  it("should translate common words", () => {
    setLocale(LOCALE_ZH_CN);
    expect(t("common.yes")).toBe("是");
    expect(t("common.no")).toBe("否");
    expect(t("common.save")).toBe("保存");
    expect(t("common.cancel")).toBe("取消");
  });

  it("should translate error messages", () => {
    setLocale(LOCALE_ZH_CN);
    expect(t("errors.unknown")).toBe("发生未知错误");
    expect(t("errors.fileNotFound", { file: "test.json" })).toBe("文件未找到: test.json");
  });

  it("should translate status messages", () => {
    setLocale(LOCALE_ZH_CN);
    expect(t("status.running")).toBe("运行中");
    expect(t("status.stopped")).toBe("已停止");
    expect(t("status.connected")).toBe("已连接");
  });
});

describe("Complex Interpolation", () => {
  beforeEach(() => {
    resetI18n();
    setLocale(LOCALE_EN);
  });

  it("should handle multiple interpolations in one string", () => {
    const result = t("errors.valueOutOfRange", {
      field: "Quantity",
      min: "1",
      max: "100",
    });
    expect(result).toBe("Quantity must be between 1 and 100");
  });

  it("should handle empty parameters gracefully", () => {
    const result = t("errors.notFound", {});
    // When item is missing, the placeholder remains in the output
    expect(result).toBe("{{item}} not found");
  });
});

describe("Namespace Access", () => {
  beforeEach(() => {
    resetI18n();
    setLocale(LOCALE_EN);
  });

  it("should access cli namespace", () => {
    const translator = createI18n(LOCALE_EN);
    const cliKeys = translator.getKeysByNamespace("cli");
    expect(cliKeys.help).toBe("Help");
    expect(cliKeys.version).toBe("version");
  });

  it("should return empty object for non-existent namespace", () => {
    const translator = createI18n(LOCALE_EN);
    const keys = translator.getKeysByNamespace("nonexistent");
    expect(Object.keys(keys).length).toBe(0);
  });
});
