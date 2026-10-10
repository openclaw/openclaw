import { DEFAULT_LOCALE, type Locale } from "../../i18n/lib/registry.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import type { TranslationMap } from "../../i18n/lib/types.ts";
import { projectSource } from "./projection.ts";

type TranslationSource = {
  getLocale(): Locale;
  t(key: string, params?: Record<string, string>): string;
  registerTranslation(locale: Locale, map: TranslationMap): void;
  subscribe(listener: () => void): () => void;
};

const catalogListeners = new WeakMap<object, Set<() => void>>();
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

/** Delegate catalog writes to their owner, then invalidate that owner's projections. */
export function registerLocaleCatalog(
  source: TranslationSource,
  locale: Locale,
  map: TranslationMap,
): void {
  source.registerTranslation(locale, map);
  if (locale === source.getLocale() || locale === DEFAULT_LOCALE) {
    const snapshot = Array.from(catalogListeners.get(source) ?? []);
    for (const notify of snapshot) {
      notify();
    }
  }
}

/** A revision also invalidates when a catalog changes without a locale change. */
export function projectI18n(source: TranslationSource) {
  const projection = projectSource(source, {
    read: (current) => current,
    subscribe: (current, notify) => {
      const stopLocale = current.subscribe(notify);
      const listeners = catalogListeners.get(current) ?? new Set<() => void>();
      catalogListeners.set(current, listeners);
      listeners.add(notify);
      englishListeners.add(notify);
      return () => {
        stopLocale();
        listeners.delete(notify);
        englishListeners.delete(notify);
        if (listeners.size === 0) {
          catalogListeners.delete(current);
        }
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
export const t = projectI18n(i18n).t;
