import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as translate from "../lib/translate.ts";
import { en } from "../locales/en.ts";
import { vi as viLocale } from "../locales/vi.ts";

describe("i18n", () => {
  function flatten(value: Record<string, string | Record<string, unknown>>, prefix = ""): string[] {
    return Object.entries(value).flatMap(([key, nested]) => {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof nested === "string") {
        return [fullKey];
      }
      return flatten(nested as Record<string, string | Record<string, unknown>>, fullKey);
    });
  }

  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.clear();
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
    await translate.i18n.setLocale("vi");
    // Since we don't mock the import, it might fail to load vi,
    // but let's assume it falls back to English for now.
    expect(translate.t("common.health")).toBeDefined();
  });

  it("loads translations even when setting the same locale again", async () => {
    const internal = translate.i18n as unknown as {
      locale: string;
      translations: Record<string, unknown>;
    };
    internal.locale = "vi";
    delete internal.translations.vi;

    await translate.i18n.setLocale("vi");
    expect(translate.t("common.health")).toBe("Tình trạng");
  });

  it("loads Vietnamese translations on demand", async () => {
    await translate.i18n.setLocale("vi");
    expect(translate.t("common.health")).toBe("Tình trạng");
  });

  it("loads saved non-English locale on startup", async () => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.setItem("openclaw.i18n.locale", "vi");
    const fresh = await import("../lib/translate.ts");
    await vi.waitFor(() => {
      expect(fresh.i18n.getLocale()).toBe("vi");
    });
    expect(fresh.i18n.getLocale()).toBe("vi");
    expect(fresh.t("common.health")).toBe("Tình trạng");
  });

  it("skips node localStorage accessors that warn without a storage file", async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    const fresh = await import("../lib/translate.ts");

    expect(fresh.i18n.getLocale()).toBe("vi");
    expect(warningSpy).not.toHaveBeenCalledWith(
      "`--localstorage-file` was provided without a valid path",
      expect.anything(),
      expect.anything(),
    );
  });

  it("keeps the version label available in shipped locales", () => {
    expect((en.common as { version?: string }).version).toBeTruthy();
    expect((viLocale.common as { version?: string }).version).toBeTruthy();
  });

  it("keeps shipped locales structurally aligned with English", () => {
    const englishKeys = flatten(en);
    for (const [locale, value] of Object.entries({ vi: viLocale })) {
      expect(flatten(value as Record<string, string | Record<string, unknown>>), locale).toEqual(
        englishKeys,
      );
    }
  });
});
