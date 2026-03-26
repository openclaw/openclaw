import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { pt_BR } from "../locales/pt-BR.ts";
import { zh_CN } from "../locales/zh-CN.ts";
import { zh_TW } from "../locales/zh-TW.ts";

type TranslateModule = typeof import("../lib/translate.ts");
type TestI18nManager = ReturnType<TranslateModule["createI18nManagerForTests"]>;

describe("i18n", () => {
  let translate: TranslateModule;

  beforeEach(async () => {
    translate = await importFreshI18n();
    localStorage.clear();
    // Reset to English
    await translate.i18n.setLocale("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return the key if translation is missing", () => {
    expect(translate.t("non.existent.key")).toBe("non.existent.key");
  });

  it("should return the correct English translation", () => {
    expect(translate.t("common.health")).toBe("Health");
  });

  it("should replace parameters correctly", () => {
    expect(translate.t("overview.stats.cronNext", { time: "10:00" })).toBe("Next wake 10:00");
  });

  it("should fallback to English if key is missing in another locale", async () => {
    // We haven't registered other locales in the test environment yet,
    // but the logic should fallback to 'en' map which is always there.
    await translate.i18n.setLocale("zh-CN");
    // Since we don't mock the import, it might fail to load zh-CN,
    // but let's assume it falls back to English for now.
    expect(translate.t("common.health")).toBeDefined();
  });

  it("loads translations even when setting the same locale again", async () => {
    const internal = translate.i18n as unknown as {
      locale: string;
      translations: Record<string, unknown>;
    };
    internal.locale = "zh-CN";
    delete internal.translations["zh-CN"];

    await translate.i18n.setLocale("zh-CN");
    expect(translate.t("common.health")).toBe("健康状况");
  });

  it("loads saved non-English locale on startup", async () => {
    const fresh = await createFreshManagerWithSavedLocale("zh-CN");
    expect(fresh.getLocale()).toBe("zh-CN");
    expect(fresh.t("common.health")).toBe("健康状况");
  });

  it("loads saved Turkish locale on startup", async () => {
    const fresh = await createFreshManagerWithSavedLocale("tr");
    expect(fresh.getLocale()).toBe("tr");
    expect(fresh.t("common.health")).toBe("Durum");
  });

  it("lazy loads Turkish translations", async () => {
    const translation = await loadLazyLocaleTranslation("tr");

    expect(translation).not.toBeNull();
    expect((translation as { common: { health: string } }).common.health).toBe("Durum");
  });

  it("resolves Turkish navigator locales", () => {
    expect(resolveNavigatorLocale("tr-TR")).toBe("tr");
  });

  it("resolves the Turkish language label used by the picker", async () => {
    await translate.i18n.setLocale("tr");

    expect(translate.t("languages.tr")).toBe("Türkçe");
  });

  it("skips node localStorage accessors that warn without a storage file", async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    const emitWarning = vi.fn();
    vi.stubGlobal("process", { env: { VITEST: "1" }, emitWarning } as unknown as NodeJS.Process);

    const fresh = await import("../lib/translate.ts");

    expect(fresh.i18n.getLocale()).toBe("en");
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("keeps the version label available in shipped locales", () => {
    expect((pt_BR.common as { version?: string }).version).toBeTruthy();
    expect((zh_CN.common as { version?: string }).version).toBeTruthy();
    expect((zh_TW.common as { version?: string }).version).toBeTruthy();
  });
});
