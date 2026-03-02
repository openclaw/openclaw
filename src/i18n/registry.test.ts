import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  loadLazyLocaleTranslation,
  resolveNavigatorLocale,
} from "../../ui/src/i18n/lib/registry.ts";

describe("ui i18n locale registry", () => {
  it("lists supported locales", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh-CN", "zh-TW", "pt-BR", "de"]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("resolves browser locale fallbacks", () => {
    expect(resolveNavigatorLocale("de-DE")).toBe("de");
    expect(resolveNavigatorLocale("pt-PT")).toBe("pt-BR");
    expect(resolveNavigatorLocale("zh-HK")).toBe("zh-TW");
    expect(resolveNavigatorLocale("en-US")).toBe("en");
  });

  it("loads lazy locale translations from the registry", async () => {
    const de = await loadLazyLocaleTranslation("de");
    const zhCN = await loadLazyLocaleTranslation("zh-CN");

    expect(de?.common?.health).toBe("Status");
    expect(zhCN?.common?.health).toBe("健康状况");
    expect(await loadLazyLocaleTranslation("en")).toBeNull();
  });
});
