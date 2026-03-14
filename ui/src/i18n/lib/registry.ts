import type { Locale, TranslationMap } from "./types.ts";

type LazyLocale = Exclude<Locale, "en">;
type LocaleModule = Record<string, TranslationMap>;

type LazyLocaleRegistration = {
  exportName: string;
  loader: () => Promise<LocaleModule>;
};

export const DEFAULT_LOCALE: Locale = "en";

const LAZY_LOCALES: readonly LazyLocale[] = [
  "zh-CN", "zh-TW", "pt-BR", "de", "es", "ja", "fr", "ru", "it", "ar", "ko", "hi",
];

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
  es: {
    exportName: "es",
    loader: () => import("../locales/es.ts"),
  },
  ja: {
    exportName: "ja",
    loader: () => import("../locales/ja.ts"),
  },
  fr: {
    exportName: "fr",
    loader: () => import("../locales/fr.ts"),
  },
  ru: {
    exportName: "ru",
    loader: () => import("../locales/ru.ts"),
  },
  it: {
    exportName: "it",
    loader: () => import("../locales/it.ts"),
  },
  ar: {
    exportName: "ar",
    loader: () => import("../locales/ar.ts"),
  },
  ko: {
    exportName: "ko",
    loader: () => import("../locales/ko.ts"),
  },
  hi: {
    exportName: "hi",
    loader: () => import("../locales/hi.ts"),
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
  if (navLang.startsWith("es")) {
    return "es";
  }
  if (navLang.startsWith("ja")) {
    return "ja";
  }
  if (navLang.startsWith("fr")) {
    return "fr";
  }
  if (navLang.startsWith("ru")) {
    return "ru";
  }
  if (navLang.startsWith("it")) {
    return "it";
  }
  if (navLang.startsWith("ar")) {
    return "ar";
  }
  if (navLang.startsWith("ko")) {
    return "ko";
  }
  if (navLang.startsWith("hi")) {
    return "hi";
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
