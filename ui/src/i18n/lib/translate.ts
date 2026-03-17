import { getSafeLocalStorage } from "../../local-storage.ts";
import { en } from "../locales/en.ts";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  loadLazyLocaleTranslation,
  resolveNavigatorLocale,
} from "./registry.ts";
import type { Locale, TranslationMap } from "./types.ts";

type Subscriber = (locale: Locale) => void;

export { SUPPORTED_LOCALES, isSupportedLocale };

class I18nManager {
  private locale: Locale = DEFAULT_LOCALE;
  private translations: Partial<Record<Locale, TranslationMap>> = { [DEFAULT_LOCALE]: en };
  private subscribers: Set<Subscriber> = new Set();

  constructor() {
    this.loadLocale();
  }

  private readStoredLocale(): string | null {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return null;
    }
    try {
      return storage.getItem("openclaw.i18n.locale");
    } catch {
      return null;
    }
  }

  private persistLocale(locale: Locale) {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    try {
      storage.setItem("openclaw.i18n.locale", locale);
    } catch {
      // Ignore storage write failures in private/blocked contexts.
    }
  }

  private resolveInitialLocale(): Locale {
    const saved = this.readStoredLocale();
    if (isSupportedLocale(saved)) {
      return saved;
    }
    const language =
      typeof globalThis.navigator?.language === "string" ? globalThis.navigator.language : null;
    return resolveNavigatorLocale(language ?? "");
  }

  private loadLocale() {
    const initialLocale = this.resolveInitialLocale();
    if (initialLocale === DEFAULT_LOCALE) {
      this.locale = DEFAULT_LOCALE;
      return;
    }
    // Use the normal locale setter so startup locale loading follows the same
    // translation-loading + notify path as manual locale changes.
    void this.setLocale(initialLocale);
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public async setLocale(locale: Locale) {
    const needsTranslationLoad = locale !== DEFAULT_LOCALE && !this.translations[locale];
    if (this.locale === locale && !needsTranslationLoad) {
      return;
    }

    if (needsTranslationLoad) {
      try {
        const translation = await loadLazyLocaleTranslation(locale);
        if (!translation) {
          return;
        }
        this.translations[locale] = translation;
      } catch (e) {
        console.error(`Failed to load locale: ${locale}`, e);
        return;
      }
    }

    this.locale = locale;
    this.persistLocale(locale);
    this.notify();
  }

  public registerTranslation(locale: Locale, map: TranslationMap) {
    this.translations[locale] = map;
  }

  public subscribe(sub: Subscriber) {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private notify() {
    this.subscribers.forEach((sub) => sub(this.locale));
  }

  public t(key: string, params?: Record<string, string>): string {
    const keys = key.split(".");
    let value: unknown = this.translations[this.locale] || this.translations[DEFAULT_LOCALE];

    for (const k of keys) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[k];
      } else {
        value = undefined;
        break;
      }
    }

    // Fallback to English.
    if (value === undefined && this.locale !== DEFAULT_LOCALE) {
      value = this.translations[DEFAULT_LOCALE];
      for (const k of keys) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[k];
        } else {
          value = undefined;
          break;
        }
      }
    }

    if (typeof value !== "string") {
      return key;
    }

    if (params) {
      return value.replace(/\{(\w+)\}/g, (_, k) => params[k] || `{${k}}`);
    }

    return value;
  }
}

export const i18n = new I18nManager();
export const t = (key: string, params?: Record<string, string>) => i18n.t(key, params);

/**
 * Return the CLDR plural category for the current locale.
 *
 * Covers the rules used by every locale shipped today:
 *  - "one"   → exactly 1  (all locales)
 *  - "few"   → 2-4 except 12-14  (Russian and other Slavic locales)
 *  - "other" → everything else
 *
 * See: https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html
 */
function getPluralCategory(locale: Locale, count: number): "one" | "few" | "other" {
  if (locale === "ru") {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) {
      return "one";
    }
    if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
      return "few";
    }
    return "other";
  }
  // All other shipped locales use the simple one/other split.
  return count === 1 ? "one" : "other";
}

/**
 * Pluralisation-aware translation.
 *
 * Given a base key like `"cron.form.fixFields"`, looks up:
 *  - `cron.form.fixFields`        → category "one"   (count = 1)
 *  - `cron.form.fixFieldsFew`     → category "few"   (count = 2-4, Russian)
 *  - `cron.form.fixFieldsPlural`  → category "other" (count ≥ 5 or 0)
 *
 * Falls back gracefully: if "Few" key is missing, uses "Plural".
 */
export function tPlural(baseKey: string, count: number, params?: Record<string, string>): string {
  const locale = i18n.getLocale();
  const category = getPluralCategory(locale, count);
  const merged = { ...params, count: String(count) };

  if (category === "one") {
    return t(baseKey, merged);
  }
  if (category === "few") {
    const fewKey = `${baseKey}Few`;
    const result = t(fewKey, merged);
    // Fall back to Plural if Few key doesn't exist (returns the key itself on miss).
    return result === fewKey ? t(`${baseKey}Plural`, merged) : result;
  }
  return t(`${baseKey}Plural`, merged);
}
