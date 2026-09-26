// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  createStorageMock,
  installSafeLocalStorageForTesting,
} from "../../test-helpers/storage.ts";
import { registerCommandPaletteEnglish } from "../locales/en-command-palette.ts";
import { createI18nManagerForTesting } from "./translate.test-support.ts";
import type { Locale, TranslationMap } from "./types.ts";

const german = { common: { health: "Gesundheit" } } satisfies TranslationMap;
const spanish = { common: { health: "Salud" } } satisfies TranslationMap;

function createManager() {
  const loadTranslation = vi.fn<(locale: Locale) => Promise<TranslationMap | null>>();
  const manager = createI18nManagerForTesting(loadTranslation);
  return {
    loadTranslation,
    manager,
    retryPendingLocale: async () => {
      manager.retryPendingLocale();
      await Promise.allSettled(loadTranslation.mock.results.map((result) => result.value));
    },
  };
}

describe("I18nManager pending locale retry", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("repairs a Node-style storage accessor without invoking its unsafe getter", async () => {
    const unsafeGetter = vi.fn(() => {
      throw new Error("Node WebStorage is unavailable without a local-storage file");
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: unsafeGetter,
    });

    const storage = installSafeLocalStorageForTesting();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

    expect(unsafeGetter).not.toHaveBeenCalled();
    expect(Object.hasOwn(descriptor ?? {}, "get")).toBe(false);
    expect(descriptor?.value).toBe(storage);
    expect(getSafeLocalStorage()).toBe(storage);

    const { manager } = createManager();
    await manager.setLocale("en");
    expect(storage.getItem("openclaw.i18n.locale")).toBe("en");
  });

  it("applies and notifies when a failed locale load is retried after recovery", async () => {
    const { loadTranslation, manager, retryPendingLocale } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadTranslation.mockRejectedValueOnce(new Error("gateway unavailable"));
    loadTranslation.mockResolvedValueOnce(german);
    const subscriber = vi.fn();
    const unsubscribe = manager.subscribe(subscriber);

    await manager.setLocale("de");

    expect(manager.getLocale()).toBe("en");
    expect(subscriber).not.toHaveBeenCalled();

    await retryPendingLocale();
    expect(manager.getLocale()).toBe("de");

    expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
    unsubscribe();
  });

  it("does nothing when no locale load is pending", async () => {
    const { loadTranslation, manager, retryPendingLocale } = createManager();
    const subscriber = vi.fn();
    const unsubscribe = manager.subscribe(subscriber);

    await retryPendingLocale();

    expect(loadTranslation).not.toHaveBeenCalled();
    expect(manager.getLocale()).toBe("en");
    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("uses a pre-warmed locale without invoking the loader", async () => {
    const { loadTranslation, manager } = createManager();
    manager.registerTranslation("de", german);

    await manager.setLocale("de");

    expect(manager.getLocale()).toBe("de");
    expect(loadTranslation).not.toHaveBeenCalled();
  });

  it("looks up only the active locale when a caller owns its fallback", async () => {
    const { manager } = createManager();
    manager.registerTranslation("de", german);
    await manager.setLocale("de");

    expect(manager.translateActive("common.health")).toBe("Gesundheit");
    expect(manager.translateActive("common.connected")).toBeUndefined();
  });

  it("uses lazy English as fallback without replacing the active language", async () => {
    const { manager } = createManager();
    manager.registerTranslation("de", {
      commandPalette: { newSessionSettings: "Neue Sitzung" },
    });
    await manager.setLocale("de");
    registerCommandPaletteEnglish();
    expect(manager.t("commandPalette.newSessionSettings")).toBe("Neue Sitzung");
    expect(manager.t("commandPalette.rememberUnavailable")).toBe("Reconnect to remember settings.");
    await manager.setLocale("en");
    expect(manager.t("commandPalette.newSessionSettings")).toBe("New session settings");
  });

  it("deduplicates an in-flight target and permits retry after the shared load settles", async () => {
    const { loadTranslation, manager, retryPendingLocale } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const firstLoad = deferred<TranslationMap | null>();
    loadTranslation.mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce(german);

    const first = manager.setLocale("de");
    const second = manager.setLocale("de");

    expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
    firstLoad.reject(new Error("gateway unavailable"));
    await Promise.all([first, second]);

    await retryPendingLocale();
    expect(manager.getLocale()).toBe("de");

    expect(loadTranslation).toHaveBeenCalledTimes(2);
  });

  it("shares one successful in-flight load across same-target callers", async () => {
    const { loadTranslation, manager } = createManager();
    const localeLoad = deferred<TranslationMap | null>();
    const subscriber = vi.fn();
    manager.subscribe(subscriber);
    loadTranslation.mockReturnValueOnce(localeLoad.promise);

    const first = manager.setLocale("de");
    const second = manager.setLocale("de");

    expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
    localeLoad.resolve(german);
    await Promise.all([first, second]);

    expect(manager.getLocale()).toBe("de");
    expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
  });

  it("lets the latest System request clear persistence during a shared load", async () => {
    const { loadTranslation, manager } = createManager();
    vi.stubGlobal("navigator", { language: "de-DE" } as Navigator);
    localStorage.setItem("openclaw.i18n.locale", "es");
    const localeLoad = deferred<TranslationMap | null>();
    loadTranslation.mockReturnValueOnce(localeLoad.promise);

    const explicit = manager.setLocale("de");
    const system = manager.useSystemLocale();

    expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
    localeLoad.resolve(german);
    await Promise.all([explicit, system]);

    expect(manager.getLocale()).toBe("de");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
  });

  it("lets the latest explicit request persist during a shared System load", async () => {
    const { loadTranslation, manager } = createManager();
    vi.stubGlobal("navigator", { language: "de-DE" } as Navigator);
    const localeLoad = deferred<TranslationMap | null>();
    loadTranslation.mockReturnValueOnce(localeLoad.promise);

    const system = manager.useSystemLocale();
    const explicit = manager.setLocale("de");

    expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
    localeLoad.resolve(german);
    await Promise.all([system, explicit]);

    expect(manager.getLocale()).toBe("de");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBe("de");
  });

  it("clears an abandoned pending target after another locale succeeds", async () => {
    const { loadTranslation, manager, retryPendingLocale } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadTranslation.mockRejectedValueOnce(new Error("gateway unavailable"));
    loadTranslation.mockResolvedValueOnce(spanish);

    await manager.setLocale("de");
    await manager.setLocale("es");
    await retryPendingLocale();

    expect(manager.getLocale()).toBe("es");
    expect(loadTranslation).toHaveBeenCalledTimes(2);
  });

  it("records a repeat failure so a later retry can still recover", async () => {
    const { loadTranslation, manager, retryPendingLocale } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadTranslation
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("gateway still unavailable"))
      .mockResolvedValueOnce(german);

    await manager.setLocale("de");
    await retryPendingLocale();
    expect(loadTranslation).toHaveBeenCalledTimes(2);
    expect(manager.getLocale()).toBe("en");

    await retryPendingLocale();
    expect(manager.getLocale()).toBe("de");

    expect(loadTranslation).toHaveBeenCalledTimes(3);
  });

  it.each(["explicit", "system"] as const)(
    "preserves %s persistence when reporting a repeated module-import failure",
    async (mode) => {
      const { loadTranslation, manager, retryPendingLocale } = createManager();
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal("navigator", { language: "de-DE" });
      localStorage.setItem("openclaw.i18n.locale", "es");
      const persistedLocalesAtHook: Array<string | null> = [];
      const onUnrecoverableLocaleLoad = vi.fn(() => {
        persistedLocalesAtHook.push(localStorage.getItem("openclaw.i18n.locale"));
      });
      manager.setLocaleLoadRecovery({
        isUnrecoverableError: (error) =>
          error instanceof Error &&
          /failed to fetch dynamically imported module/i.test(error.message),
        onUnrecoverableLocaleLoad,
      });
      loadTranslation
        .mockRejectedValueOnce(new Error("gateway unavailable"))
        .mockRejectedValueOnce(
          new Error("Failed to fetch dynamically imported module: /assets/de-abc123.js"),
        )
        .mockResolvedValueOnce(german);

      await (mode === "system" ? manager.useSystemLocale() : manager.setLocale("de"));
      await retryPendingLocale();

      const preference = mode === "system" ? null : "de";
      expect(loadTranslation).toHaveBeenCalledTimes(2);
      expect(onUnrecoverableLocaleLoad).toHaveBeenCalledExactlyOnceWith("de");
      expect(persistedLocalesAtHook).toEqual([preference]);
      expect(localStorage.getItem("openclaw.i18n.locale")).toBe(preference);
      expect(manager.getLocale()).toBe("en");

      await retryPendingLocale();
      expect(loadTranslation).toHaveBeenCalledTimes(3);
      expect(manager.getLocale()).toBe("de");
      expect(localStorage.getItem("openclaw.i18n.locale")).toBe(preference);
    },
  );

  it("keeps a pending system locale unpersisted across retry recovery", async () => {
    const { loadTranslation, manager, retryPendingLocale } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("navigator", { language: "de-DE" } as Navigator);
    localStorage.setItem("openclaw.i18n.locale", "es");
    loadTranslation.mockRejectedValueOnce(new Error("gateway unavailable"));
    loadTranslation.mockResolvedValueOnce(german);

    await manager.useSystemLocale();

    expect(manager.getLocale()).toBe("en");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();

    await retryPendingLocale();
    expect(manager.getLocale()).toBe("de");

    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
  });

  it("does not report a repeated non-import failure", async () => {
    const { loadTranslation, manager, retryPendingLocale } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onUnrecoverableLocaleLoad = vi.fn();
    manager.setLocaleLoadRecovery({
      isUnrecoverableError: (error) =>
        error instanceof Error &&
        /failed to fetch dynamically imported module/i.test(error.message),
      onUnrecoverableLocaleLoad,
    });
    loadTranslation
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("request failed"))
      .mockResolvedValueOnce(german);

    await manager.setLocale("fr");
    await retryPendingLocale();
    expect(loadTranslation).toHaveBeenCalledTimes(2);

    expect(onUnrecoverableLocaleLoad).not.toHaveBeenCalled();
    expect(manager.getLocale()).toBe("en");

    await retryPendingLocale();
    expect(loadTranslation).toHaveBeenCalledTimes(3);
    expect(manager.getLocale()).toBe("fr");
  });

  it("ignores an older failure after a newer locale succeeds", async () => {
    const { loadTranslation, manager, retryPendingLocale } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const germanLoad = deferred<TranslationMap | null>();
    const spanishLoad = deferred<TranslationMap | null>();
    loadTranslation
      .mockReturnValueOnce(germanLoad.promise)
      .mockReturnValueOnce(spanishLoad.promise);

    const setGerman = manager.setLocale("de");
    const setSpanish = manager.setLocale("es");
    spanishLoad.resolve(spanish);
    await setSpanish;
    germanLoad.reject(new Error("late German failure"));
    await setGerman;
    await retryPendingLocale();

    expect(manager.getLocale()).toBe("es");
    expect(loadTranslation).toHaveBeenCalledTimes(2);
  });

  it("preserves a newer failed target when an older load succeeds late", async () => {
    const { loadTranslation, manager, retryPendingLocale } = createManager();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const germanLoad = deferred<TranslationMap | null>();
    const spanishLoad = deferred<TranslationMap | null>();
    loadTranslation
      .mockReturnValueOnce(germanLoad.promise)
      .mockReturnValueOnce(spanishLoad.promise)
      .mockResolvedValueOnce(spanish);

    const setGerman = manager.setLocale("de");
    const setSpanish = manager.setLocale("es");
    spanishLoad.reject(new Error("Spanish load failed"));
    await setSpanish;
    germanLoad.resolve(german);
    await setGerman;

    expect(manager.getLocale()).toBe("en");

    await retryPendingLocale();
    expect(manager.getLocale()).toBe("es");

    expect(loadTranslation).toHaveBeenCalledTimes(3);
  });
});
