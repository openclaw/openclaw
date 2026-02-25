import { en } from "../locales/en.ts";
import type { Locale, TranslationMap } from "./types.ts";

type Subscriber = (locale: Locale) => void;

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ["en", "de", "bs", "zh-CN", "zh-TW", "pt-BR"];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

class I18nManager {
  private locale: Locale = "en";
  private translations: Record<Locale, TranslationMap> = { en } as Record<Locale, TranslationMap>;
  private subscribers: Set<Subscriber> = new Set();

  constructor() {
    this.loadLocale();
  }

  private loadLocale() {
    const saved = localStorage.getItem("activi.i18n.locale");
    if (isSupportedLocale(saved)) {
      this.locale = saved;
    } else {
      const navLang = navigator.language;
      if (navLang.startsWith("zh")) {
        this.locale = navLang === "zh-TW" || navLang === "zh-HK" ? "zh-TW" : "zh-CN";
      } else if (navLang.startsWith("pt")) {
        this.locale = "pt-BR";
      } else if (navLang.startsWith("de")) {
        this.locale = "de";
      } else if (navLang.startsWith("bs") || navLang.startsWith("hr") || navLang.startsWith("sr")) {
        this.locale = "bs";
      } else {
        this.locale = "en"; // Default: English
      }
    }
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public async setLocale(locale: Locale) {
    if (this.locale === locale) {
      return;
    }

    // Lazy load translations if needed
    if (!this.translations[locale]) {
      try {
        let module: Record<string, TranslationMap>;
        if (locale === "zh-CN") {
          module = await import("../locales/zh-CN.ts");
          this.translations[locale] = module.zh_CN;
        } else if (locale === "zh-TW") {
          module = await import("../locales/zh-TW.ts");
          this.translations[locale] = module.zh_TW;
        } else if (locale === "pt-BR") {
          module = await import("../locales/pt-BR.ts");
          this.translations[locale] = module.pt_BR;
        } else if (locale === "de") {
          module = await import("../locales/de.ts");
          this.translations[locale] = module.de;
        } else if (locale === "bs") {
          module = await import("../locales/bs.ts");
          this.translations[locale] = module.bs;
        } else {
          return;
        }
      } catch (e) {
        console.error(`Failed to load locale: ${locale}`, e);
        return;
      }
    }

    this.locale = locale;
    localStorage.setItem("activi.i18n.locale", locale);
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
    let value: unknown = this.translations[this.locale] || this.translations["en"];

    for (const k of keys) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[k];
      } else {
        value = undefined;
        break;
      }
    }

    // Fallback to English
    if (value === undefined && this.locale !== "en") {
      value = this.translations["en"];
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
