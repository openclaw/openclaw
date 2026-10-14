// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  loadLazyLocaleTranslation,
  resolveNavigatorLocale,
  SUPPORTED_LOCALES,
} from "./registry.ts";

describe("resolveNavigatorLocale", () => {
  it.each([
    ["zh", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["ZH-hAnT-CN", "zh-TW"],
    ["ZH-hAnS-hK", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["pt-PT", "pt-BR"],
    ["DE-at", "de"],
    ["ja-JP", "ja-JP"],
    ["sv-SE", "sv"],
    ["sv-FI", "sv"],
    ["nb-NO", "en"],
    ["", "en"],
  ] as const)("maps browser language %s to %s", (browserLanguage, expectedLocale) => {
    expect(resolveNavigatorLocale(browserLanguage)).toBe(expectedLocale);
  });
});

describe("lazy locale registry", () => {
  it("keeps English as the default and materializes every registered foreign catalog", async () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(await loadLazyLocaleTranslation("en")).toBeNull();

    const catalogs = await Promise.all(
      SUPPORTED_LOCALES.slice(1).map(
        async (locale) => [locale, await loadLazyLocaleTranslation(locale)] as const,
      ),
    );
    for (const [locale, catalog] of catalogs) {
      expect(catalog?.common, locale).toHaveProperty("health");
    }
  });
});
