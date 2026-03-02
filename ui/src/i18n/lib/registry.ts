import type { Locale, TranslationMap } from "./types.ts";

type LazyLocale = Exclude<Locale, "en">;
type LocaleModule = Record<string, TranslationMap>;

type LazyLocaleRegistration = {
  exportName: string;
  loader: () => Promise<LocaleModule>;
};

export const DEFAULT_LOCALE: Locale = "en";

const LAZY_LOCALES: readonly LazyLocale[] = ["zh-CN", "zh-TW", "pt-BR", "de"];

const LAZY_LOCALE_REGISTRY: Record<LazyLocale, LazyLocaleRegistration> = {
  "zh-CN": {
    exportName: "zh_CN",
    loader: () => import("../locales/zh-CN.ts"),
  },
  "zh-TW": {
    exportName: "zh_TW",
    loader: () => import("../locales/zh-TW.ts"),
  },
  "pt-BR": {
    exportName: "pt_BR",
    loader: () => import("../locales/pt-BR.ts"),
  },
  de: {
    exportName: "de",
    loader: () => import("../locales/de.ts"),
  },
};

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = [DEFAULT_LOCALE, ...LAZY_LOCALES];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

function isLazyLocale(locale: Locale): locale is LazyLocale {
  return LAZY_LOCALES.includes(locale as LazyLocale);
}

export function resolveNavigatorLocale(navLang: string): Locale {
  if (navLang.startsWith("zh")) {
    return navLang === "zh-TW" || navLang === "zh-HK" ? "zh-TW" : "zh-CN";
  }
  if (navLang.startsWith("pt")) {
    return "pt-BR";
  }
  if (navLang.startsWith("de")) {
    return "de";
  }
  return DEFAULT_LOCALE;
}

export async function loadLazyLocaleTranslation(locale: Locale): Promise<TranslationMap | null> {
  if (!isLazyLocale(locale)) {
    return null;
  }
  const registration = LAZY_LOCALE_REGISTRY[locale];
  const module = await registration.loader();
  return module[registration.exportName] ?? null;
}
