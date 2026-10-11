// @vitest-environment node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../../src/plugin-sdk/test-helpers/import-fresh.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadLazyLocaleTranslation, SUPPORTED_LOCALES } from "../lib/registry.ts";
import * as translate from "../lib/translate.ts";
import { registerLoginEnglish } from "../locales/en-login.ts";
import { en } from "../locales/en.ts";

const shippedLocales = new Map(
  await Promise.all(
    SUPPORTED_LOCALES.slice(1).map(
      async (locale) => [locale, await loadLazyLocaleTranslation(locale)] as const,
    ),
  ),
);
const memoryDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.i18n");
// Swedish is registered before the post-merge locale refresh creates its memory.
const sourceOnlyLocales = new Map(
  [...shippedLocales].filter(
    ([locale]) => locale === "sv" && !existsSync(path.join(memoryDir, `${locale}.tm.jsonl`)),
  ),
);
const translatedLocales = new Map(
  [...shippedLocales].filter(([locale]) => !sourceOnlyLocales.has(locale)),
);
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
  function flatten(value: Record<string, string | Record<string, unknown>>, prefix = ""): string[] {
    return Object.entries(value).flatMap(([key, nested]) => {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof nested === "string") {
        return [fullKey];
      }
      return flatten(nested as Record<string, string | Record<string, unknown>>, fullKey);
    });
  }

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

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("should return the key if translation is missing", () => {
    expect(translate.t("non.existent.key")).toBe("non.existent.key");
  });

  it("should replace parameters correctly", () => {
    expect(translate.t("connection.help.copyCommandAria", { command: "openclaw dashboard" })).toBe(
      "Copy command: openclaw dashboard",
    );
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
    await vi.waitFor(() => {
      expect(fresh.i18n.getLocale()).toBe("zh-CN");
    });
    expect(fresh.t("common.health")).toBe(
      readTranslationString(shippedLocales.get("zh-CN"), "common.health"),
    );
  });

  it("syncs canonical document locale metadata on startup", async () => {
    const documentElement = stubDocumentLocaleMetadata();
    vi.stubGlobal("navigator", { language: "fa-IR" } as Navigator);
    localStorage.removeItem("openclaw.i18n.locale");

    const fresh = await importFreshTranslate();

    await vi.waitFor(() => expect(fresh.i18n.getLocale()).toBe("fa"));
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

    await vi.waitFor(() => expect(fresh.i18n.getLocale()).toBe("zh-TW"));
    expect(fresh.t("common.health")).toBe(
      readTranslationString(shippedLocales.get("zh-TW"), "common.health"),
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

  it("keeps the version label available in shipped locales", () => {
    for (const [locale, value] of shippedLocales) {
      expect(readTranslationString(value, "common.version").trim(), locale).not.toBe("");
    }
  });

  it("uses English source copy until a new locale has generated memory", () => {
    for (const [locale, value] of sourceOnlyLocales) {
      expect(readTranslationString(value, "login.failure.rawError"), locale).toBe(
        readTranslationString(registerLoginEnglish.catalog, "login.failure.rawError"),
      );
      for (const key of ["devices.pairing.button", "chat.composer.addAttachment"]) {
        expect(readTranslationString(value, key), `${locale}:${key}`).toBe(
          readTranslationString(en, key),
        );
      }
    }
  });

  it("keeps newly exposed locales from shipping as English fallback bundles", () => {
    for (const locale of ["ar", "hi", "fa", "it", "nl", "vi"] as const) {
      expect(readTranslationString(shippedLocales.get(locale), "common.health"), locale).not.toBe(
        readTranslationString(en, "common.health"),
      );
    }
  });

  it("keeps login failure guidance localized in shipped locale bundles", () => {
    const checkedKeys = flatten(registerLoginEnglish.catalog.login.failure, "login.failure");
    expect(checkedKeys.length).toBeGreaterThan(0);
    for (const [locale, value] of translatedLocales) {
      for (const key of checkedKeys) {
        expect(readTranslationString(value, key), `${locale}:${key}`).not.toBe(
          readTranslationString(registerLoginEnglish.catalog, key),
        );
      }
    }
  });

  it("keeps mobile pairing copy localized in shipped locale bundles", () => {
    const checkedKeys = flatten(en).filter(
      (key) => key.startsWith("devices.pairing.") && key !== "devices.pairing.title",
    );

    for (const [locale, value] of translatedLocales) {
      for (const key of checkedKeys) {
        expect(readTranslationString(value, key), `${locale}:${key}`).not.toBe(
          readTranslationString(en, key),
        );
      }
    }
  });

  it("keeps the chat composer attachment action localized in shipped locale bundles", () => {
    const key = "chat.composer.addAttachment";

    for (const [locale, value] of translatedLocales) {
      expect(readTranslationString(value, key), `${locale}:${key}`).not.toBe(
        readTranslationString(en, key),
      );
    }
  });
});
