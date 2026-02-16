import type { Locale, TranslationMap } from "./types";
import { en } from "../locales/en";

type Subscriber = (locale: Locale) => void;

class I18nManager {
  private locale: Locale = "en";
  private translations: Record<Locale, TranslationMap> = { en } as Record<Locale, TranslationMap>;
  private subscribers: Set<Subscriber> = new Set();

  constructor() {
    this.loadLocale();
  }

  private loadLocale() {
    const saved = localStorage.getItem("openclaw.i18n.locale") as Locale;
    if (saved && ["en", "zh-CN", "zh-TW", "pt-BR"].includes(saved)) {
      this.locale = saved;
    } else {
      const navLang = navigator.language;
      if (navLang.startsWith("zh")) {
        this.locale = navLang === "zh-TW" || navLang === "zh-HK" ? "zh-TW" : "zh-CN";
      } else if (navLang.startsWith("pt")) {
        this.locale = "pt-BR";
      } else {
        this.locale = "en";
      }
    }
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public async setLocale(locale: Locale) {
    if (this.locale === locale) return;

    // Lazy load translations if needed
    if (!this.translations[locale]) {
      try {
        let module;
        if (locale === "zh-CN") {
          module = await import("../locales/zh-CN");
        } else if (locale === "zh-TW") {
          module = await import("../locales/zh-TW");
        } else if (locale === "pt-BR") {
          module = await import("../locales/pt-BR");
        } else {
          return;
        }
        this.translations[locale] = module[locale.replace("-", "_")];
      } catch (e) {
        console.error(`Failed to load locale: ${locale}`, e);
        return;
      }
    }

    this.locale = locale;
    localStorage.setItem("openclaw.i18n.locale", locale);
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
    let value: any = this.translations[this.locale] || this.translations["en"];

    for (const k of keys) {
      if (value && typeof value === "object") {
        value = value[k];
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
          value = value[k];
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
