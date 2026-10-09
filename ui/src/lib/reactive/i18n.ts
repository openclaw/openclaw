import type { Locale } from "../../i18n/lib/registry.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { projectSource } from "./projection.ts";

type TranslationSource = {
  getLocale(): Locale;
  t(key: string, params?: Record<string, string>): string;
  subscribe(listener: () => void): () => void;
};

const englishListeners = new Set<() => void>();
const registeredEnglish = new WeakSet<() => unknown>();

/** Solid callers register their lazy English before reading its keys. */
export function registerEnglishCatalog<T>(register: () => T): T {
  const result = register();
  if (!registeredEnglish.has(register)) {
    registeredEnglish.add(register);
    const snapshot = Array.from(englishListeners);
    for (const notify of snapshot) {
      notify();
    }
  }
  return result;
}

/** A revision also invalidates when a catalog changes without a locale change. */
export function projectI18n(source: TranslationSource) {
  const projection = projectSource(source, {
    read: (current) => current,
    subscribe: (current, notify) => {
      const stopLocale = current.subscribe(notify);
      englishListeners.add(notify);
      return () => {
        stopLocale();
        englishListeners.delete(notify);
      };
    },
    equality: "revision",
  });
  return {
    ...projection,
    locale: () => projection.read().getLocale(),
    t: (key: string, params?: Record<string, string>) => projection.read().t(key, params),
  };
}

/** Solid consumers retain t("key") without loading signals in the existing Lit entry. */
const translation = projectI18n(i18n);
export const t = translation.t;
export const getLocale = translation.locale;
export const i18nRevision = translation.revision;
