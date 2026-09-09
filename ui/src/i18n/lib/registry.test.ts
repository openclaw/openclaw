// @vitest-environment node

import { describe, expect, it } from "vitest";
import { configHints as deConfigHints, de } from "../locales/de.ts";
import { configHints as esConfigHints, es } from "../locales/es.ts";
import { configHints as hiConfigHints, hi } from "../locales/hi.ts";
import { configHints as ptBrConfigHints, pt_BR } from "../locales/pt-BR.ts";
import { configHints as ruConfigHints, ru } from "../locales/ru.ts";
import { configHints as thConfigHints, th } from "../locales/th.ts";
import { configHints as zhCnConfigHints, zh_CN } from "../locales/zh-CN.ts";
import {
  DEFAULT_LOCALE,
  loadLazyLocaleTranslation,
  resolveNavigatorLocale,
  SUPPORTED_LOCALES,
} from "./registry.ts";

describe("resolveNavigatorLocale", () => {
  it.each([
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-Hans-SG", "zh-CN"],
    ["zh-Hans-HK", "zh-CN"],
    ["zh-Hans-TW", "zh-CN"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
    ["zh-Hant-MO", "zh-TW"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["ZH-hAnT-hK", "zh-TW"],
    ["ZH-hAnS-hK", "zh-CN"],
    ["en-US", "en"],
    ["pt-PT", "pt-BR"],
    ["PT-br", "pt-BR"],
    ["de-DE", "de"],
    ["DE-at", "de"],
    ["es-MX", "es"],
    ["ja-JP", "ja-JP"],
    ["ko-KR", "ko"],
    ["fr-CA", "fr"],
    ["hi-IN", "hi"],
    ["ar-EG", "ar"],
    ["it-IT", "it"],
    ["tr-TR", "tr"],
    ["uk-UA", "uk"],
    ["id-ID", "id"],
    ["pl-PL", "pl"],
    ["th-TH", "th"],
    ["vi-VN", "vi"],
    ["nl-NL", "nl"],
    ["fa-IR", "fa"],
    ["ru-RU", "ru"],
    ["sv-SE", "en"],
    ["", "en"],
  ] as const)("maps browser language %s to %s", (browserLanguage, expectedLocale) => {
    expect(resolveNavigatorLocale(browserLanguage)).toBe(expectedLocale);
  });
});

describe("lazy locale registry", () => {
  it("keeps English as the default and materializes every registered foreign catalog", async () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(SUPPORTED_LOCALES).toHaveLength(21);
    expect(await loadLazyLocaleTranslation("en")).toBeNull();

    const catalogs = await Promise.all(
      SUPPORTED_LOCALES.slice(1).map(
        async (locale) => [locale, await loadLazyLocaleTranslation(locale)] as const,
      ),
    );
    for (const [locale, catalog] of catalogs) {
      expect(catalog?.common, locale).toHaveProperty("health");
    }
    const byLocale = Object.fromEntries(catalogs);
    for (const [locale, expected] of Object.entries({
      de: { ...de, ...deConfigHints },
      es: { ...es, ...esConfigHints },
      "pt-BR": { ...pt_BR, ...ptBrConfigHints },
      "zh-CN": { ...zh_CN, ...zhCnConfigHints },
      hi: { ...hi, ...hiConfigHints },
      th: { ...th, ...thConfigHints },
      ru: { ...ru, ...ruConfigHints },
    })) {
      expect(byLocale[locale], locale).toEqual(expected);
    }
  });
});
