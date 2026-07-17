// Control UI i18n module implements translate behavior.
import {
  createCatalogSnapshot,
  createLocalizationContext,
  getLocaleDirection,
  renderLocalizedMessage,
  resolveLocalizationContext,
  type CatalogSnapshot,
  type LocalizationContext,
  type OpenClawLocale,
} from "@openclaw/localization-core";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { en } from "../locales/en.ts";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  loadLazyLocaleTranslation,
} from "./registry.ts";
import type { Locale, TranslationMap } from "./types.ts";

type Subscriber = (locale: Locale) => void;

export { SUPPORTED_LOCALES, isSupportedLocale };

export class I18nManager {
  private locale: Locale = DEFAULT_LOCALE;
  private translations: Partial<Record<Locale, TranslationMap>> = { [DEFAULT_LOCALE]: en };
  private context: LocalizationContext = createLocalizationContext({
    locale: DEFAULT_LOCALE,
    source: "english-default",
    audience: "user",
    supportedLocales: SUPPORTED_LOCALES,
  });
  private snapshot: CatalogSnapshot = createCatalogSnapshot({
    catalogRevision: "control-ui:0",
    catalogs: { [DEFAULT_LOCALE]: flattenTranslationMap(en) },
  });
  private catalogRevision = 0;
  private localeRequestId = 0;
  private subscribers: Set<Subscriber> = new Set();

  constructor(
    private readonly loadTranslation: (
      locale: Locale,
    ) => Promise<TranslationMap | null> = loadLazyLocaleTranslation,
  ) {
    this.applyDocumentLocale(DEFAULT_LOCALE);
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

  private resolveInitialContext(): LocalizationContext {
    const saved = this.readStoredLocale();
    const languages =
      Array.isArray(globalThis.navigator?.languages) &&
      globalThis.navigator.languages.every((language) => typeof language === "string")
        ? globalThis.navigator.languages
        : [];
    const language =
      typeof globalThis.navigator?.language === "string" ? globalThis.navigator.language : null;
    const result = resolveLocalizationContext({
      audience: "user",
      surfacePreference: saved,
      platform: [...languages, language],
      supportedLocales: SUPPORTED_LOCALES,
    });
    if (saved && result.findings.some((finding) => finding.source === "surface-preference")) {
      this.removeStoredLocale();
    }
    return result.context;
  }

  private removeStoredLocale() {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    try {
      storage.removeItem("openclaw.i18n.locale");
    } catch {
      // Ignore storage failures in private/blocked contexts.
    }
  }

  private loadLocale() {
    const initialContext = this.resolveInitialContext();
    if (initialContext.locale === DEFAULT_LOCALE) {
      this.locale = DEFAULT_LOCALE;
      this.context = initialContext;
      return;
    }
    // Use the normal locale setter so startup locale loading follows the same
    // translation-loading + notify path as manual locale changes.
    void this.setLocaleFromSource(initialContext.locale as Locale, initialContext.source);
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public async setLocale(locale: Locale) {
    return this.setLocaleFromSource(locale, "surface-preference");
  }

  private async setLocaleFromSource(
    locale: Locale,
    source: LocalizationContext["source"],
  ): Promise<void> {
    const requestId = ++this.localeRequestId;
    const needsTranslationLoad = locale !== DEFAULT_LOCALE && !this.translations[locale];
    if (this.locale === locale && !needsTranslationLoad) {
      this.context = createLocalizationContext({
        locale,
        source,
        audience: "user",
        supportedLocales: SUPPORTED_LOCALES,
      });
      this.applyDocumentLocale(locale);
      this.persistLocale(locale);
      return;
    }

    if (needsTranslationLoad) {
      try {
        const translation = await this.loadTranslation(locale);
        if (!translation) {
          return;
        }
        this.translations[locale] = translation;
        this.rebuildSnapshot();
      } catch (e) {
        console.error(`Failed to load locale: ${locale}`, e);
        return;
      }
    }

    if (requestId !== this.localeRequestId) {
      return;
    }
    this.locale = locale;
    this.context = createLocalizationContext({
      locale,
      source,
      audience: "user",
      supportedLocales: SUPPORTED_LOCALES,
    });
    this.applyDocumentLocale(locale);
    this.persistLocale(locale);
    this.notify();
  }

  public registerTranslation(locale: Locale, map: TranslationMap) {
    this.translations[locale] = map;
    this.rebuildSnapshot();
  }

  public subscribe(sub: Subscriber) {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private notify() {
    this.subscribers.forEach((sub) => sub(this.locale));
  }

  public t(key: string, params?: Record<string, string>): string {
    const snapshot = this.snapshot;
    const context = this.context;
    const fallback = (snapshot.catalogs.en?.[key] as string | undefined) ?? key;
    return renderLocalizedMessage(snapshot, context, { key, params, fallback });
  }

  private rebuildSnapshot() {
    const catalogs = Object.fromEntries(
      Object.entries(this.translations).map(([locale, map]) => [
        locale,
        flattenTranslationMap(map),
      ]),
    ) as Partial<Record<OpenClawLocale, ReturnType<typeof flattenTranslationMap>>>;
    this.snapshot = createCatalogSnapshot({
      catalogRevision: `control-ui:${++this.catalogRevision}`,
      catalogs,
    });
  }

  private applyDocumentLocale(locale: Locale) {
    if (typeof document === "undefined") {
      return;
    }
    document.documentElement.lang = locale;
    document.documentElement.dir = getLocaleDirection(locale);
  }
}

function flattenTranslationMap(
  map: TranslationMap,
  prefix = "",
  output: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(map)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      output[path] = value;
    } else {
      flattenTranslationMap(value, path, output);
    }
  }
  return output;
}

export const i18n = new I18nManager();
export const t = (key: string, params?: Record<string, string>) => i18n.t(key, params);
