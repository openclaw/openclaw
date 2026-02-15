import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  t,
  setLocale,
  getLocale,
  availableLocales,
  initializeLocale,
  detectLocale,
  getLocaleDisplayNames,
  type Locale
} from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("i18n System", () => {
  beforeEach(() => {
    // Reset to default locale before each test
    setLocale("en");
  });

  describe("Basic functionality", () => {
    it("should return English string by default", () => {
      expect(t("commands.help.description")).toBe("Help and commands.");
      expect(getLocale()).toBe("en");
    });

    it("should return Ukrainian string after setLocale('uk')", () => {
      setLocale("uk");
      expect(t("commands.help.description")).toBe("Допомога та команди.");
      expect(getLocale()).toBe("uk");
    });

    it("should return the key itself for unknown keys", () => {
      expect(t("unknown.key.that.does.not.exist")).toBe("unknown.key.that.does.not.exist");
    });

    it("should substitute {placeholder} parameters", () => {
      expect(t("commands.dock.description", { dock: "telegram" })).toBe("Switch to telegram for replies.");
      
      setLocale("uk");
      expect(t("commands.dock.description", { dock: "telegram" })).toBe("Перемкнутися на telegram для відповідей.");
    });

    it("should return current locale with getLocale()", () => {
      expect(getLocale()).toBe("en");
      setLocale("uk");
      expect(getLocale()).toBe("uk");
      setLocale("de");
      expect(getLocale()).toBe("de");
    });

    it("should throw error for unknown locale in setLocale()", () => {
      expect(() => setLocale("unknown" as Locale)).toThrow("Unknown locale: unknown");
    });

    it("should return list of available locales", () => {
      const locales = availableLocales();
      expect(locales).toContain("en");
      expect(locales).toContain("uk");
      expect(locales).toContain("de");
      expect(locales).toContain("es");
      expect(locales).toContain("fr");
      expect(locales).toContain("pt");
      expect(locales).toContain("ja");
      expect(locales).toContain("zh");
      expect(locales).toContain("pl");
      expect(locales).toContain("tr");
      expect(locales).toHaveLength(10);
    });
  });

  describe("Completeness tests", () => {
    let enData: Record<string, any>;
    let allLocaleFiles: string[];

    beforeEach(() => {
      // Load English reference data
      const enPath = path.join(__dirname, "en.json");
      enData = JSON.parse(fs.readFileSync(enPath, "utf-8"));
      
      // Get all locale files
      allLocaleFiles = fs.readdirSync(__dirname)
        .filter(file => file.endsWith(".json"))
        .map(file => file.replace(".json", ""));
    });

    // Helper function to get all keys from nested object
    function getAllKeys(obj: any, prefix = ""): string[] {
      const keys: string[] = [];
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          keys.push(...getAllKeys(value, fullKey));
        } else {
          keys.push(fullKey);
        }
      }
      return keys;
    }

    // Helper function to get value by dot path
    function getValueByPath(obj: any, path: string): any {
      return path.split(".").reduce((current, key) => current?.[key], obj);
    }

    // Helper function to extract placeholders from string
    function getPlaceholders(str: string): string[] {
      const matches = str.match(/\{([^}]+)\}/g);
      return matches ? matches.map(match => match.slice(1, -1)) : [];
    }

    it("should have all English keys in Ukrainian locale", () => {
      const ukPath = path.join(__dirname, "uk.json");
      const ukData = JSON.parse(fs.readFileSync(ukPath, "utf-8"));
      
      const enKeys = getAllKeys(enData);
      
      for (const key of enKeys) {
        const ukValue = getValueByPath(ukData, key);
        expect(ukValue, `Key "${key}" missing in uk.json`).toBeDefined();
      }
    });

    it("should have all English keys in every other locale file", () => {
      const enKeys = getAllKeys(enData);
      const otherLocales = allLocaleFiles.filter(locale => locale !== "en");
      
      for (const locale of otherLocales) {
        const localePath = path.join(__dirname, `${locale}.json`);
        const localeData = JSON.parse(fs.readFileSync(localePath, "utf-8"));
        
        for (const key of enKeys) {
          const localeValue = getValueByPath(localeData, key);
          expect(localeValue, `Key "${key}" missing in ${locale}.json`).toBeDefined();
        }
      }
    });

    it("should have no empty string translations", () => {
      for (const locale of allLocaleFiles) {
        const localePath = path.join(__dirname, `${locale}.json`);
        const localeData = JSON.parse(fs.readFileSync(localePath, "utf-8"));
        const keys = getAllKeys(localeData);
        
        for (const key of keys) {
          const value = getValueByPath(localeData, key);
          expect(value, `Empty string found for key "${key}" in ${locale}.json`).not.toBe("");
          expect(typeof value, `Non-string value found for key "${key}" in ${locale}.json`).toBe("string");
        }
      }
    });

    it("should have all placeholders from English in corresponding translations", () => {
      const enKeys = getAllKeys(enData);
      const otherLocales = allLocaleFiles.filter(locale => locale !== "en");
      
      for (const key of enKeys) {
        const enValue = getValueByPath(enData, key);
        if (typeof enValue !== "string") continue;
        
        const enPlaceholders = getPlaceholders(enValue);
        if (enPlaceholders.length === 0) continue;
        
        for (const locale of otherLocales) {
          const localePath = path.join(__dirname, `${locale}.json`);
          const localeData = JSON.parse(fs.readFileSync(localePath, "utf-8"));
          const localeValue = getValueByPath(localeData, key);
          
          if (typeof localeValue === "string") {
            const localePlaceholders = getPlaceholders(localeValue);
            
            for (const placeholder of enPlaceholders) {
              expect(localePlaceholders, 
                `Placeholder "{${placeholder}}" missing in "${key}" for ${locale}.json`
              ).toContain(placeholder);
            }
          }
        }
      }
    });

    it("should have no extra keys in translations that don't exist in English", () => {
      const enKeys = new Set(getAllKeys(enData));
      const otherLocales = allLocaleFiles.filter(locale => locale !== "en");
      
      for (const locale of otherLocales) {
        const localePath = path.join(__dirname, `${locale}.json`);
        const localeData = JSON.parse(fs.readFileSync(localePath, "utf-8"));
        const localeKeys = getAllKeys(localeData);
        
        for (const key of localeKeys) {
          expect(enKeys.has(key), 
            `Extra key "${key}" found in ${locale}.json that doesn't exist in en.json`
          ).toBe(true);
        }
      }
    });
  });

  describe("Integration tests", () => {
    beforeEach(() => {
      // Reset environment
      delete process.env.LANG;
      delete process.env.LC_ALL;
      delete process.env.LANGUAGE;
      setLocale("en");
    });

    it("should initialize to Ukrainian with config {locale: 'uk'}", () => {
      initializeLocale({ agents: { defaults: { locale: "uk" } } });
      expect(getLocale()).toBe("uk");
      expect(t("commands.help.description")).toBe("Допомога та команди.");
    });

    it("should stay English with initializeLocale() without locale config", () => {
      initializeLocale();
      expect(getLocale()).toBe("en");
      expect(t("commands.help.description")).toBe("Help and commands.");
    });

    it("should detect Ukrainian locale from env LANG=uk_UA", () => {
      process.env.LANG = "uk_UA.UTF-8";
      const detected = detectLocale();
      expect(detected).toBe("uk");
    });

    it("should detect locale from various environment formats", () => {
      // Test various LANG formats
      process.env.LANG = "de_DE.UTF-8";
      expect(detectLocale()).toBe("de");
      
      process.env.LANG = "es_ES";
      expect(detectLocale()).toBe("es");
      
      process.env.LANG = "fr";
      expect(detectLocale()).toBe("fr");
      
      // Test LC_ALL override
      process.env.LANG = "en_US";
      process.env.LC_ALL = "pt_BR.UTF-8";
      expect(detectLocale()).toBe("pt");
      
      // Test unknown locale fallback
      process.env.LANG = "xx_YY";
      expect(detectLocale()).toBe("en");
      
      // Test alternative mappings
      process.env.LANG = "ua_UA"; // ua should map to uk
      expect(detectLocale()).toBe("uk");
      
      process.env.LANG = "jp_JP"; // jp should map to ja
      expect(detectLocale()).toBe("ja");
      
      process.env.LANG = "cn_CN"; // cn should map to zh
      expect(detectLocale()).toBe("zh");
    });

    it("should prioritize config over environment", () => {
      process.env.LANG = "de_DE";
      const detected = detectLocale({ agents: { defaults: { locale: "fr" } } });
      expect(detected).toBe("fr");
    });

    it("should handle malformed config gracefully", () => {
      process.env.LANG = "uk_UA";
      
      // Invalid locale in config should fall back to env detection
      const detected1 = detectLocale({ agents: { defaults: { locale: "invalid" } } });
      expect(detected1).toBe("uk");
      
      // Empty string should fall back to env detection
      const detected2 = detectLocale({ agents: { defaults: { locale: "" } } });
      expect(detected2).toBe("uk");
    });
  });

  describe("Locale-specific functionality tests", () => {
    it("should return non-empty string for 'commands.help.description' in every locale", () => {
      const locales = availableLocales();
      
      for (const locale of locales) {
        setLocale(locale);
        const description = t("commands.help.description");
        
        expect(description, `Empty description for locale "${locale}"`).toBeTruthy();
        expect(typeof description, `Non-string description for locale "${locale}"`).toBe("string");
        expect(description.length, `Too short description for locale "${locale}"`).toBeGreaterThan(0);
        expect(description, `Description equals key for locale "${locale}"`).not.toBe("commands.help.description");
      }
    });

    it("should handle parameter substitution correctly in all locales", () => {
      const locales = availableLocales();
      
      for (const locale of locales) {
        setLocale(locale);
        const result = t("system.model_changed", { model: "claude-3" });
        
        // Should contain the parameter value
        expect(result, `Parameter not substituted in locale "${locale}"`).toContain("claude-3");
        // Should not contain the placeholder
        expect(result, `Placeholder not replaced in locale "${locale}"`).not.toContain("{model}");
      }
    });

    it("should fall back to English for partially missing keys", () => {
      // Test with a key that might exist in English but not in other locales
      setLocale("en");
      const enValue = t("system.error_generic");
      expect(enValue).toBeTruthy();
      
      // Switch to another locale and verify fallback works
      for (const locale of availableLocales()) {
        if (locale === "en") continue;
        
        setLocale(locale);
        const localeValue = t("system.error_generic");
        // Should either be translated or fall back to English, but never return the key
        expect(localeValue).toBeTruthy();
        expect(localeValue).not.toBe("system.error_generic");
      }
    });

    it("should handle nested key access correctly in all locales", () => {
      const locales = availableLocales();
      
      for (const locale of locales) {
        setLocale(locale);
        
        // Test deeply nested key
        const skillName = t("commands.skill.args.name");
        expect(skillName, `Nested key failed for locale "${locale}"`).toBeTruthy();
        expect(skillName, `Nested key returned key itself for locale "${locale}"`).not.toBe("commands.skill.args.name");
        
        // Test another nested structure
        const helpTitle = t("help.title");
        expect(helpTitle, `Help title missing for locale "${locale}"`).toBeTruthy();
        expect(helpTitle, `Help title returned key itself for locale "${locale}"`).not.toBe("help.title");
      }
    });

    it("should maintain consistent behavior across locale switches", () => {
      // Test switching between locales multiple times
      const testKey = "actions.save";
      
      setLocale("en");
      const enValue = t(testKey);
      
      setLocale("uk");
      const ukValue = t(testKey);
      
      setLocale("de");
      const deValue = t(testKey);
      
      // Switch back to English
      setLocale("en");
      expect(t(testKey)).toBe(enValue);
      
      // Switch back to Ukrainian
      setLocale("uk");
      expect(t(testKey)).toBe(ukValue);
      
      // Verify all values are different (unless they happen to be the same)
      expect(enValue).toBeTruthy();
      expect(ukValue).toBeTruthy();
      expect(deValue).toBeTruthy();
    });

    it("should handle empty parameters object gracefully", () => {
      const locales = availableLocales();
      
      for (const locale of locales) {
        setLocale(locale);
        
        // Test with empty params object
        expect(() => t("commands.help.description", {})).not.toThrow();
        
        // Test with undefined params
        expect(() => t("commands.help.description", undefined)).not.toThrow();
        
        // Test with null params
        expect(() => t("commands.help.description", null as any)).not.toThrow();
      }
    });

    it("should preserve non-existent placeholders when no params provided", () => {
      setLocale("en");
      const result = t("commands.dock.description"); // Contains {dock} placeholder
      expect(result).toContain("{dock}");
    });
  });

  describe("getLocaleDisplayNames()", () => {
    it("should return a display name for every available locale", () => {
      const names = getLocaleDisplayNames();
      const locales = availableLocales();

      for (const locale of locales) {
        expect(names[locale], `Missing display name for locale "${locale}"`).toBeDefined();
        expect(typeof names[locale]).toBe("string");
        expect(names[locale].length).toBeGreaterThan(0);
      }
    });

    it("should not contain locales that are not available", () => {
      const names = getLocaleDisplayNames();
      const locales = new Set(availableLocales());

      for (const key of Object.keys(names)) {
        expect(locales.has(key as Locale), `Extra locale "${key}" in display names but not in availableLocales()`).toBe(true);
      }
    });

    it("should have exactly the same keys as availableLocales()", () => {
      const names = getLocaleDisplayNames();
      expect(Object.keys(names).sort()).toEqual(availableLocales().sort());
    });
  });

  describe("Error handling and edge cases", () => {
    it("should handle deeply nested missing keys gracefully", () => {
      expect(t("very.deeply.nested.key.that.does.not.exist.anywhere")).toBe("very.deeply.nested.key.that.does.not.exist.anywhere");
    });

    it("should handle special characters in parameter values", () => {
      setLocale("en");
      const result = t("system.model_changed", { model: "claude-3 {special} & <chars>" });
      expect(result).toContain("claude-3 {special} & <chars>");
    });

    it("should handle multiple placeholders correctly", () => {
      // Use a key that might have multiple placeholders or create a test with current_queue
      setLocale("en");
      const result = t("status.current_queue", { 
        mode: "batch", 
        debounce: "100", 
        cap: "5", 
        drop: "oldest" 
      });
      
      expect(result).toContain("batch");
      expect(result).toContain("100");
      expect(result).toContain("5");
      expect(result).toContain("oldest");
    });

    it("should handle undefined and null values in parameters", () => {
      setLocale("en");
      
      // Test with undefined parameter value
      expect(() => t("system.model_changed", { model: undefined as any })).not.toThrow();
      
      // Test with null parameter value
      expect(() => t("system.model_changed", { model: null as any })).not.toThrow();
    });
  });
});