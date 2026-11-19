import type { Locale } from "../../../../src/shared/control-ui-locale.ts";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import { i18n } from "../../i18n/lib/translate.ts";
import { projectSource } from "./projection.ts";

const englishListeners = createChangeListeners({ snapshot: true });
const registeredEnglish = new WeakSet<() => unknown>();

/** Each lazy catalog installs once, before its consumers read its keys. */
export function registerEnglishCatalog(register: () => void): void {
  if (registeredEnglish.has(register)) {
    return;
  }
  register();
  registeredEnglish.add(register);
  englishListeners.publish();
}

/** A revision also invalidates when a catalog changes without a locale change. */
export function projectI18n(source: {
  getLocale(): Locale;
  t(key: string, params?: Record<string, string>): string;
  subscribe(listener: () => void): () => void;
}) {
  const projection = projectSource(source, {
    read: (current) => current,
    subscribe: (current, notify) => {
      const stopLocale = current.subscribe(notify);
      const stopEnglish = englishListeners.subscribe(notify);
      return () => {
        stopLocale();
        stopEnglish();
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
/** Plain owners observe both locale changes and newly registered lazy English catalogs. */
export const subscribeI18n = translation.subscribe;
