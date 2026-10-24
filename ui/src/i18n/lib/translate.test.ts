// @vitest-environment node

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Locale } from "../../../../src/shared/control-ui-locale.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  createStorageMock,
  installSafeLocalStorageForTesting,
} from "../../test-helpers/storage.ts";
import { registerCommandPaletteEnglish } from "../locales/en-command-palette.ts";
import { createLazyLocaleCatalog } from "./lazy-catalog.ts";
import { createI18nManagerForTesting } from "./translate.test-support.ts";
import type { TranslationMap } from "./types.ts";

const german = { common: { health: "Gesundheit" } } satisfies TranslationMap;
const spanish = { common: { health: "Salud" } } satisfies TranslationMap;

const loadTranslation = vi.fn<(locale: Locale) => Promise<TranslationMap | null>>();
let manager: ReturnType<typeof createI18nManagerForTesting>;

async function retryPendingLocale() {
  manager.retryPendingLocale();
  await Promise.allSettled(loadTranslation.mock.results.map((result) => result.value));
}

function state() {
  return {
    locale: manager.getLocale(),
    requested: manager.getRequestedLocale(),
    stored: localStorage.getItem("openclaw.i18n.locale"),
    loads: loadTranslation.mock.calls.length,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  loadTranslation.mockReset();
  manager = createI18nManagerForTesting(loadTranslation);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("repairs a Node-style storage accessor without invoking its unsafe getter", async () => {
  const unsafeGetter = vi.fn(() => {
    throw new Error("Node WebStorage is unavailable without a local-storage file");
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: unsafeGetter });
  const storage = installSafeLocalStorageForTesting();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  expect(unsafeGetter).not.toHaveBeenCalled();
  expect(Object.hasOwn(descriptor ?? {}, "get")).toBe(false);
  expect(descriptor?.value).toBe(storage);
  expect(getSafeLocalStorage()).toBe(storage);
  manager = createI18nManagerForTesting(loadTranslation);
  await manager.setLocale("en");
  expect(storage.getItem("openclaw.i18n.locale")).toBe("en");
});

it("looks up only the active locale when a caller owns its fallback", async () => {
  manager.registerTranslation("de", german);
  await manager.setLocale("de");
  expect(manager.translateActive("common.health")).toBe("Gesundheit");
  expect(manager.translateActive("common.connected")).toBeUndefined();
  expect(loadTranslation).not.toHaveBeenCalled();
});

it("uses lazy English as fallback without replacing the active language", async () => {
  manager.registerTranslation("de", { commandPalette: { newSessionSettings: "Neue Sitzung" } });
  await manager.setLocale("de");
  registerCommandPaletteEnglish();
  expect(manager.t("commandPalette.newSessionSettings")).toBe("Neue Sitzung");
  expect(manager.t("commandPalette.rememberUnavailable")).toBe("Reconnect to remember settings.");
  await manager.setLocale("en");
  expect(manager.t("commandPalette.newSessionSettings")).toBe("New session settings");
});

it("prepares registered English namespaces before publishing a locale without loading unopened ones", async () => {
  registerCommandPaletteEnglish();
  const page = deferred<{ default: TranslationMap }>();
  const loadPage = vi.fn(() => page.promise);
  const loadHints = vi.fn();
  const catalog = createLazyLocaleCatalog(
    { common: { health: "Gesundheit" }, commandPalette: { newSessionSettings: "Neue Sitzung" } },
    { commandPalette: loadPage, configHints: loadHints },
  );
  manager.registerTranslation("de", catalog);
  const subscriber = vi.fn();
  manager.subscribe(subscriber);
  const changing = manager.setLocale("de");
  expect(manager.getLocale()).toBe("en");
  expect(manager.t("commandPalette.rememberUnavailable")).toBe("Reconnect to remember settings.");
  expect(loadPage).toHaveBeenCalledOnce();
  expect(loadHints).not.toHaveBeenCalled();
  page.resolve({
    default: { commandPalette: { rememberUnavailable: "Zum Speichern erneut verbinden." } },
  });
  await changing;
  expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
  expect(manager.t("commandPalette.rememberUnavailable")).toBe("Zum Speichern erneut verbinden.");
  expect(manager.t("commandPalette.newSessionSettings")).toBe("Neue Sitzung");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(loadPage).toHaveBeenCalledOnce();
});

it("keeps late namespace results scoped to their locale and retries a failed namespace", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const page = deferred<{ default: TranslationMap }>();
  const loadPage = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockReturnValueOnce(page.promise);
  manager.registerTranslation("de", createLazyLocaleCatalog(german, { configHints: loadPage }));
  manager.registerTranslation("es", spanish);
  await manager.setLocale("de");
  expect(manager.translateActive("configHints.label")).toBeUndefined();
  await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
  expect(manager.translateActive("configHints.label")).toBeUndefined();
  expect(loadPage).toHaveBeenCalledTimes(2);
  await manager.setLocale("es");
  const subscriber = vi.fn();
  manager.subscribe(subscriber);
  page.resolve({ default: { configHints: { label: "Einstellung" } } });
  await page.promise;
  await Promise.resolve();
  expect(subscriber).not.toHaveBeenCalled();
  expect(manager.translateActive("configHints.label")).toBeUndefined();
  await manager.setLocale("de");
  expect(manager.translateActive("configHints.label")).toBe("Einstellung");
  expect(loadPage).toHaveBeenCalledTimes(2);
});

it("deduplicates an in-flight target and permits retry after the shared load settles", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const firstLoad = deferred<TranslationMap | null>();
  loadTranslation.mockReturnValueOnce(firstLoad.promise).mockResolvedValueOnce(german);
  const subscriber = vi.fn();
  const unsubscribe = manager.subscribe(subscriber);
  const first = manager.setLocale("de");
  const second = manager.setLocale("de");
  expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
  expect(manager.getRequestedLocale()).toBe("de");
  firstLoad.reject(new Error("gateway unavailable"));
  await Promise.all([first, second]);
  expect(state()).toMatchObject({ locale: "en", requested: "de" });
  expect(subscriber).not.toHaveBeenCalled();

  await retryPendingLocale();
  expect(state()).toMatchObject({ locale: "de", loads: 2 });
  expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
  unsubscribe();
});

it.each(["explicit", "system"] as const)("persists the latest %s request", async (mode) => {
  vi.stubGlobal("navigator", { language: "de-DE" });
  localStorage.setItem("openclaw.i18n.locale", "es");
  const localeLoad = deferred<TranslationMap | null>();
  loadTranslation.mockReturnValueOnce(localeLoad.promise);
  const subscriber = vi.fn();
  manager.subscribe(subscriber);
  const select = () => manager.setLocale("de");
  const system = () => manager.useSystemLocale();
  const requests = mode === "system" ? [select(), system()] : [system(), select()];
  expect(loadTranslation).toHaveBeenCalledExactlyOnceWith("de");
  localeLoad.resolve(german);
  await Promise.all(requests);
  expect(state()).toMatchObject({ locale: "de", stored: mode === "system" ? null : "de" });
  expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
});

it("clears an abandoned pending target after another locale succeeds", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  loadTranslation.mockRejectedValueOnce(new Error("gateway unavailable"));
  loadTranslation.mockResolvedValueOnce(spanish);
  await manager.setLocale("de");
  await manager.setLocale("es");
  await retryPendingLocale();

  expect(state()).toMatchObject({ locale: "es", requested: "es", loads: 2 });
});

it.each(["explicit", "system"] as const)("keeps %s recovery preference", async (mode) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("navigator", { language: "de-DE" });
  localStorage.setItem("openclaw.i18n.locale", "es");
  const onUnrecoverableLocaleLoad = vi.fn(() => state().stored);
  const importFailure = new Error("Failed to fetch dynamically imported module");
  manager.setLocaleLoadRecovery({
    isUnrecoverableError: (error) => error === importFailure,
    onUnrecoverableLocaleLoad,
  });
  loadTranslation
    .mockRejectedValueOnce(new Error("gateway unavailable"))
    .mockRejectedValueOnce(importFailure)
    .mockResolvedValueOnce(german);

  await (mode === "system" ? manager.useSystemLocale() : manager.setLocale("de"));
  expect(state()).toMatchObject({ locale: "en", stored: mode === "system" ? null : "es" });
  await retryPendingLocale();

  const preference = mode === "system" ? null : "de";
  expect(state()).toMatchObject({ locale: "en", stored: preference, loads: 2 });
  expect(onUnrecoverableLocaleLoad).toHaveBeenCalledExactlyOnceWith("de");
  expect(onUnrecoverableLocaleLoad).toHaveReturnedWith(preference);

  await retryPendingLocale();
  expect(state()).toMatchObject({ locale: "de", stored: preference, loads: 3 });
});

it.each(["failure", "success"] as const)("ignores a stale locale load's %s", async (outcome) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const germanLoad = deferred<TranslationMap | null>();
  const spanishLoad = deferred<TranslationMap | null>();
  loadTranslation.mockReturnValueOnce(germanLoad.promise).mockReturnValueOnce(spanishLoad.promise);
  if (outcome === "success") {
    loadTranslation.mockResolvedValueOnce(spanish);
  }
  const setGerman = manager.setLocale("de");
  const setSpanish = manager.setLocale("es");
  if (outcome === "failure") {
    spanishLoad.resolve(spanish);
    await setSpanish;
    germanLoad.reject(new Error("late German failure"));
  } else {
    spanishLoad.reject(new Error("Spanish load failed"));
    await setSpanish;
    germanLoad.resolve(german);
  }
  await setGerman;
  expect(manager.getLocale()).toBe(outcome === "failure" ? "es" : "en");
  await retryPendingLocale();
  expect(state()).toMatchObject({ locale: "es", loads: outcome === "failure" ? 2 : 3 });
});
