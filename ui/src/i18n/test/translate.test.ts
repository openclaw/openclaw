// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../../src/plugin-sdk/test-helpers/import-fresh.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadLazyLocaleTranslation } from "../lib/registry.ts";
import * as translate from "../lib/translate.ts";
let translateImportCase = 0;

async function importFreshTranslate() {
  return importFreshModule<typeof import("../lib/translate.ts")>(
    import.meta.url,
    `../lib/translate.ts?case=${++translateImportCase}`,
  );
}

function stubDocumentLocaleMetadata() {
  const documentElement = { lang: "", dir: "" };
  vi.stubGlobal("document", { documentElement } as unknown as Document);
  return documentElement;
}

describe("i18n", () => {
  function readTranslationString(value: unknown, path: string): string {
    let cursor = value;
    for (const part of path.split(".")) {
      cursor =
        cursor && typeof cursor === "object"
          ? (cursor as Record<string, unknown>)[part]
          : undefined;
    }
    return typeof cursor === "string" ? cursor : "";
  }

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

  it("renders a provided empty-string param as empty, not the raw placeholder", () => {
    expect(translate.t("connection.help.copyCommandAria", { command: "" })).toBe("Copy command: ");
  });

  it("keeps the visible placeholder when the param is missing", () => {
    expect(translate.t("connection.help.copyCommandAria", {})).toBe("Copy command: {command}");
  });

  it("loads saved non-English locale on startup", async () => {
    localStorage.setItem("openclaw.i18n.locale", "zh-CN");
    const fresh = await importFreshTranslate();
    await vi.dynamicImportSettled();
    expect(fresh.i18n.getLocale()).toBe("zh-CN");
    expect(fresh.t("common.health")).toBe(
      readTranslationString(await loadLazyLocaleTranslation("zh-CN"), "common.health"),
    );
  });

  it("syncs canonical document locale metadata on startup", async () => {
    const documentElement = stubDocumentLocaleMetadata();
    vi.stubGlobal("navigator", { language: "fa-IR" } as Navigator);
    localStorage.removeItem("openclaw.i18n.locale");

    const fresh = await importFreshTranslate();

    await vi.dynamicImportSettled();
    expect(fresh.i18n.getLocale()).toBe("fa");
    expect(documentElement).toEqual({ lang: "fa", dir: "rtl" });
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
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

  it("loads the browser's Chinese script preference on startup", async () => {
    vi.stubGlobal("navigator", { language: "ZH-hAnT-CN" } as Navigator);
    localStorage.removeItem("openclaw.i18n.locale");

    const fresh = await importFreshTranslate();

    await vi.dynamicImportSettled();
    expect(fresh.i18n.getLocale()).toBe("zh-TW");
    expect(fresh.t("common.health")).toBe(
      readTranslationString(await loadLazyLocaleTranslation("zh-TW"), "common.health"),
    );
  });

  it("skips node localStorage accessors that warn without a storage file", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    const fresh = await importFreshTranslate();

    expect(fresh.i18n.getLocale()).toBe("en");
    const warningMessages = warningSpy.mock.calls.map((call) => String(call[0]));
    expect(warningMessages).not.toContain(
      "`--localstorage-file` was provided without a valid path",
    );
  });
});
