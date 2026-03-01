import { en } from "../locales/en.ts";
import type { BuiltinLocale, Locale, TranslationMap } from "./types.ts";

type Subscriber = (locale: Locale) => void;
type RuntimeLocaleLoader = (locale: string) => Promise<TranslationMap | null | undefined>;
const AUTO_LITERAL_NAMESPACE = "auto";

export const BUILTIN_LOCALES: ReadonlyArray<BuiltinLocale> = [
  "en",
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "de",
];
export const SUPPORTED_LOCALES = BUILTIN_LOCALES;

let runtimeLocaleLoader: RuntimeLocaleLoader | null = null;

function decodeBase64UrlUtf8(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function canonicalizeLocale(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return Intl.getCanonicalLocales(trimmed)[0] ?? null;
  } catch {
    return null;
  }
}

export function isBuiltinLocale(value: string | null | undefined): value is BuiltinLocale {
  const canonical = canonicalizeLocale(value);
  return canonical !== null && BUILTIN_LOCALES.includes(canonical as BuiltinLocale);
}

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return canonicalizeLocale(value) !== null;
}

export function registerRuntimeLocaleLoader(loader: RuntimeLocaleLoader | null) {
  runtimeLocaleLoader = loader;
}

async function loadBuiltinLocaleMap(locale: BuiltinLocale): Promise<TranslationMap | null> {
  try {
    if (locale === "en") {
      return en;
    }
    let module: Record<string, TranslationMap>;
    if (locale === "zh-CN") {
      module = await import("../locales/zh-CN.ts");
      return module.zh_CN;
    }
    if (locale === "zh-TW") {
      module = await import("../locales/zh-TW.ts");
      return module.zh_TW;
    }
    if (locale === "pt-BR") {
      module = await import("../locales/pt-BR.ts");
      return module.pt_BR;
    }
    if (locale === "de") {
      module = await import("../locales/de.ts");
      return module.de;
    }
    return null;
  } catch (e) {
    console.error(`Failed to load locale: ${locale}`, e);
    return null;
  }
}

class I18nManager {
  private locale: Locale = "en";
  private translations: Record<string, TranslationMap> = { en };
  private subscribers: Set<Subscriber> = new Set();
  private literalTranslationCache = new Map<string, Map<string, string>>();

  constructor() {
    this.loadLocale();
  }

  private resolveInitialLocale(): Locale {
    const saved = canonicalizeLocale(localStorage.getItem("openclaw.i18n.locale"));
    if (saved) {
      return saved;
    }
    const navLang = canonicalizeLocale(navigator.language);
    if (navLang?.startsWith("zh")) {
      return navLang === "zh-TW" || navLang === "zh-HK" ? "zh-TW" : "zh-CN";
    }
    if (navLang?.startsWith("pt")) {
      return "pt-BR";
    }
    if (navLang?.startsWith("de")) {
      return "de";
    }
    return "en";
  }

  private loadLocale() {
    const initialLocale = this.resolveInitialLocale();
    if (initialLocale === "en") {
      this.locale = "en";
      return;
    }
    void this.setLocale(initialLocale);
  }

  public getLocale(): Locale {
    return this.locale;
  }

  public async setLocale(locale: Locale) {
    const normalized = canonicalizeLocale(locale) ?? "en";
    const needsTranslationLoad = !this.translations[normalized];
    if (this.locale === normalized && !needsTranslationLoad) {
      return;
    }

    if (needsTranslationLoad) {
      if (isBuiltinLocale(normalized)) {
        const map = await loadBuiltinLocaleMap(normalized);
        if (!map) {
          return;
        }
        this.translations[normalized] = map;
        this.literalTranslationCache.delete(normalized);
      } else if (runtimeLocaleLoader) {
        try {
          const map = await runtimeLocaleLoader(normalized);
          if (map) {
            this.translations[normalized] = map;
            this.literalTranslationCache.delete(normalized);
          }
        } catch (err) {
          console.error(`Failed to load runtime locale: ${normalized}`, err);
        }
      }
    }

    this.locale = normalized;
    localStorage.setItem("openclaw.i18n.locale", normalized);
    this.notify();
  }

  public registerTranslation(locale: Locale, map: TranslationMap) {
    const normalized = canonicalizeLocale(locale) ?? locale;
    this.translations[normalized] = map;
    this.literalTranslationCache.delete(normalized);
    if (this.locale === normalized) {
      this.notify();
    }
  }

  private getAutoLiteralNode(locale: Locale): Record<string, string> | null {
    const translation = this.translations[locale];
    if (!translation) {
      return null;
    }
    const auto = (translation as Record<string, unknown>)[AUTO_LITERAL_NAMESPACE];
    if (!auto || typeof auto !== "object" || Array.isArray(auto)) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(auto as Record<string, unknown>)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return out;
  }

  private buildLiteralTranslationMap(locale: Locale): Map<string, string> {
    const cached = this.literalTranslationCache.get(locale);
    if (cached) {
      return cached;
    }
    const out = new Map<string, string>();
    const autoMap = this.getAutoLiteralNode(locale);
    if (autoMap) {
      for (const [encodedKey, translated] of Object.entries(autoMap)) {
        const source = decodeBase64UrlUtf8(encodedKey);
        if (!source) {
          continue;
        }
        if (!translated || translated === source) {
          continue;
        }
        out.set(source, translated);
      }
    }
    this.literalTranslationCache.set(locale, out);
    return out;
  }

  public hasLiteralTranslations(locale: Locale = this.locale): boolean {
    return this.buildLiteralTranslationMap(locale).size > 0;
  }

  public translateLiteral(input: string): string | null {
    const map = this.buildLiteralTranslationMap(this.locale);
    return map.get(input) ?? null;
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
    let value: unknown = this.translations[this.locale] || this.translations.en;

    for (const k of keys) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[k];
      } else {
        value = undefined;
        break;
      }
    }

    if (value === undefined && this.locale !== "en") {
      value = this.translations.en;
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
export const hasLiteralTranslations = (locale?: Locale) => i18n.hasLiteralTranslations(locale);
export const translateLiteral = (input: string) => i18n.translateLiteral(input);
