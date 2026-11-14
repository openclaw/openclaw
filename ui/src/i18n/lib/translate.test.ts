// @vitest-environment node

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Locale } from "../../../../src/shared/control-ui-locale.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { getSafeLocalStorage } from "../../local-storage.ts";
import * as storageHelpers from "../../test-helpers/storage.ts";
import { registerCommandPaletteEnglish } from "../locales/en-command-palette.ts";
import { createLazyLocaleCatalog } from "./lazy-catalog.ts";
import { createI18nManagerForTesting } from "./translate.test-support.ts";
import type { TranslationMap } from "./types.ts";

const german = { common: { health: "Gesundheit" } } satisfies TranslationMap;
const spanish = { common: { health: "Salud" } } satisfies TranslationMap;
const settingsKey = "commandPalette.newSessionSettings";
const rememberKey = "commandPalette.rememberUnavailable";
const offline = new Error("offline");
const loadTranslation = vi.fn<(locale: Locale) => Promise<TranslationMap | null>>();
const subscriber = vi.fn<(locale: Locale) => void>();
let manager: ReturnType<typeof createI18nManagerForTesting>;

async function retryPendingLocale() {
  manager.retryPendingLocale();
  await Promise.allSettled(loadTranslation.mock.results.map((result) => result.value));
}

const state = () => ({
  locale: manager.getLocale(),
  requested: manager.getRequestedLocale(),
  stored: localStorage.getItem("openclaw.i18n.locale"),
  loads: loadTranslation.mock.calls.length,
});

beforeEach(() => {
  vi.stubGlobal("localStorage", storageHelpers.createStorageMock());
  vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  loadTranslation.mockReset();
  subscriber.mockReset();
  manager = createI18nManagerForTesting(loadTranslation);
  manager.subscribe(subscriber);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("repairs a Node-style storage accessor without invoking its unsafe getter", () => {
  const unsafeGetter = vi.fn(() => {
    throw new Error("Node WebStorage is unavailable without a local-storage file");
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: unsafeGetter });
  const storage = storageHelpers.installSafeLocalStorageForTesting();
  expect(unsafeGetter).not.toHaveBeenCalled();
  expect(getSafeLocalStorage()).toBe(storage);
});

it("prepares registered English namespaces before publishing a locale without loading unopened ones", async () => {
  registerCommandPaletteEnglish();
  const page = deferred<{ default: TranslationMap }>();
  const loadHints = vi.fn();
  const catalog = createLazyLocaleCatalog(
    { ...german, commandPalette: { newSessionSettings: "Neue Sitzung" } },
    { commandPalette: () => page.promise, configHints: loadHints },
  );
  manager.registerTranslation("de", catalog);
  const changing = manager.setLocale("de");
  expect(manager.getLocale()).toBe("en");
  expect(loadHints).not.toHaveBeenCalled();
  page.resolve({ default: { commandPalette: { rememberUnavailable: "Erneut verbinden" } } });
  await changing;
  expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
  expect(manager.t(rememberKey)).toBe("Erneut verbinden");
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.translateActive(settingsKey)).toBe("Neue Sitzung");
  expect(manager.translateActive("common.connected")).toBeUndefined();
});

it("keeps late namespace results scoped to their locale and retries a failed namespace", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const page = deferred<{ default: TranslationMap }>();
  const loadPage = vi.fn().mockRejectedValueOnce(offline).mockReturnValueOnce(page.promise);
  manager.registerTranslation("de", createLazyLocaleCatalog(german, { configHints: loadPage }));
  manager.registerTranslation("es", spanish);
  await manager.setLocale("de");
  expect(manager.translateActive("configHints.label")).toBeUndefined();
  await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
  expect(manager.translateActive("configHints.label")).toBeUndefined();
  await manager.setLocale("es");
  subscriber.mockClear();
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
  const first = manager.setLocale("de");
  const second = manager.setLocale("de");
  expect(loadTranslation).toHaveBeenCalledTimes(1);
  firstLoad.reject(offline);
  await Promise.all([first, second]);
  expect(state()).toMatchObject({ locale: "en", requested: "de" });
  expect(subscriber).not.toHaveBeenCalled();
  await retryPendingLocale();
  expect(state()).toMatchObject({ locale: "de", loads: 2 });
  expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
});

it.each(["explicit", "system"] as const)("persists the latest %s request", async (mode) => {
  vi.stubGlobal("navigator", { language: "de-DE" });
  localStorage.setItem("openclaw.i18n.locale", "es");
  const localeLoad = deferred<TranslationMap | null>();
  loadTranslation.mockReturnValueOnce(localeLoad.promise);
  const select = () => manager.setLocale("de");
  const system = () => manager.useSystemLocale();
  const requests = mode === "system" ? [select(), system()] : [system(), select()];
  localeLoad.resolve(german);
  await Promise.all(requests);
  expect(state()).toMatchObject({ locale: "de", stored: mode === "system" ? null : "de" });
  expect(subscriber).toHaveBeenCalledExactlyOnceWith("de");
});

it.each(["explicit", "system"] as const)("keeps %s recovery preference", async (mode) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("navigator", { language: "de-DE" });
  localStorage.setItem("openclaw.i18n.locale", "es");
  const onUnrecoverableLocaleLoad = vi.fn(() => state().stored);
  const importFailure = new Error("stale chunk");
  manager.setLocaleLoadRecovery({
    isUnrecoverableError: (error) => error === importFailure,
    onUnrecoverableLocaleLoad,
  });
  loadTranslation
    .mockRejectedValueOnce(offline)
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
  spanishLoad.resolve(outcome === "failure" ? spanish : Promise.reject(offline));
  await setSpanish;
  germanLoad.resolve(outcome === "failure" ? Promise.reject(offline) : german);
  await setGerman;
  expect(manager.getLocale()).toBe(outcome === "failure" ? "es" : "en");
  await retryPendingLocale();
  expect(state()).toMatchObject({ locale: "es", loads: outcome === "failure" ? 2 : 3 });
  expect(manager.getRequestedLocale()).toBe("es");
});
