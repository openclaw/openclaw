import { getSafeLocalStorage } from "../../local-storage.ts";
import { i18n } from "./translate.ts";
import type { Locale, TranslationMap } from "./types.ts";

type LocaleTranslationLoader = (locale: Locale) => Promise<TranslationMap | null>;
type TranslateTestApi = {
  createI18nManager(loadLocaleTranslation: LocaleTranslationLoader): typeof i18n;
};

function getTestApi(): TranslateTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.i18nManagerTestApi")
  ];
  if (!api) {
    throw new Error("i18n manager test API is unavailable");
  }
  return api as TranslateTestApi;
}

export function createI18nManagerForTesting(
  loadLocaleTranslation: LocaleTranslationLoader,
): typeof i18n {
  return getTestApi().createI18nManager(loadLocaleTranslation);
}

/** Restores locale, preference, and document attributes after a shared-worker test. */
export function captureI18nStateForTesting(): () => Promise<void> {
  const previousLocale = i18n.getLocale();
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  const attributes = (["lang", "dir"] as const).map(
    (name) => [name, root?.getAttribute(name)] as const,
  );
  const storage = getSafeLocalStorage();
  const previousPreference = storage?.getItem("openclaw.i18n.locale") ?? null;

  return async () => {
    await i18n.setLocale(previousLocale);
    // Separate test managers also update the document; the singleton may already
    // have its original locale and skip document synchronization on restoration.
    for (const [name, value] of attributes) {
      if (value == null) {
        root?.removeAttribute(name);
      } else {
        root?.setAttribute(name, value);
      }
    }
    if (previousPreference === null) {
      storage?.removeItem("openclaw.i18n.locale");
    } else {
      storage?.setItem("openclaw.i18n.locale", previousPreference);
    }
  };
}
