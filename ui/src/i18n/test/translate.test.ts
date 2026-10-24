// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../../src/plugin-sdk/test-helpers/import-fresh.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadLazyLocaleTranslation } from "../lib/registry.ts";
import * as translate from "../lib/translate.ts";
let translateImportCase = 0;

async function importFreshTranslate() {
  const fresh = await importFreshModule<typeof import("../lib/translate.ts")>(
    import.meta.url,
    `../lib/translate.ts?case=${++translateImportCase}`,
  );
  await vi.dynamicImportSettled();
  return fresh;
}

function stubDocumentLocaleMetadata() {
  const documentElement = { lang: "", dir: "" };
  vi.stubGlobal("document", { documentElement } as unknown as Document);
  return documentElement;
}

describe("i18n", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    await translate.i18n.setLocale("en");
  });

  afterEach(async () => {
    await vi.dynamicImportSettled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("should return the key if translation is missing", () => {
    expect(translate.t("non.existent.key")).toBe("non.existent.key");
  });

  it.each<[Record<string, string>, string]>([
    [{ command: "" }, "Copy command: "],
    [{}, "Copy command: {command}"],
  ])("renders provided or missing parameters: %j", (params, expected) => {
    expect(translate.t("connection.help.copyCommandAria", params)).toBe(expected);
  });

  it.each([
    ["en-US", "zh-CN", "zh-CN", "ltr"],
    ["fa-IR", null, "fa", "rtl"],
    ["ZH-hAnT-CN", null, "zh-TW", "ltr"],
  ])("loads startup locale for browser %s and saved %s", async (language, saved, locale, dir) => {
    const documentElement = stubDocumentLocaleMetadata();
    vi.stubGlobal("navigator", { language });
    localStorage.removeItem("openclaw.i18n.locale");
    if (saved) {
      localStorage.setItem("openclaw.i18n.locale", saved);
    }
    const fresh = await importFreshTranslate();
    expect(fresh.i18n.getLocale()).toBe(locale);
    expect(documentElement).toEqual({ lang: locale, dir });
    expect(localStorage.getItem("openclaw.i18n.locale")).toBe(saved);
    expect(await loadLazyLocaleTranslation(fresh.i18n.getLocale())).toMatchObject({
      common: { health: fresh.t("common.health") },
    });
  });

  it("clears an explicit locale when returning to the system language", async () => {
    vi.stubGlobal("navigator", { language: "de-DE" } as Navigator);
    await translate.i18n.setLocale("fr");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBe("fr");
    await translate.i18n.useSystemLocale();
    expect(translate.i18n.getLocale()).toBe("de");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
  });

  it("syncs document locale metadata when the locale changes", async () => {
    const documentElement = stubDocumentLocaleMetadata();
    await translate.i18n.setLocale("ar");
    expect(documentElement).toEqual({ lang: "ar", dir: "rtl" });
    await translate.i18n.setLocale("de");
    expect(documentElement).toEqual({ lang: "de", dir: "ltr" });
  });

  it("skips node localStorage accessors that warn without a storage file", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const fresh = await importFreshTranslate();
    expect(fresh.i18n.getLocale()).toBe("en");
    expect(warningSpy.mock.calls.map((call) => String(call[0]))).not.toContain(
      "`--localstorage-file` was provided without a valid path",
    );
  });
});
