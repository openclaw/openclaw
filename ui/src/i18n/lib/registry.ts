import type { Locale, TranslationMap } from "./types.ts";

type LazyLocale = Exclude<Locale, "en">;
type LocaleModule = Record<string, TranslationMap>;

type LazyLocaleRegistration = {
  exportName: string;
  loader: () => Promise<LocaleModule>;
};

export const DEFAULT_LOCALE: Locale = "en";
export const DEFAULT_APP_LOCALE: Locale = "vi";

const LAZY_LOCALES: readonly LazyLocale[] = new Set(["vi"]);

const LAZY_LOCALE_REGISTRY: Record<LazyLocale, LazyLocaleRegistration> = {
  vi: {
    exportName: "vi",
    loader: () => import("../locales/vi.ts"),
  },
};

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = [DEFAULT_APP_LOCALE, DEFAULT_LOCALE];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

function isLazyLocale(locale: Locale): locale is LazyLocale {
  return LAZY_LOCALES.has(locale as LazyLocale);
}

export function resolveNavigatorLocale(navLang: string): Locale {
  if (navLang.startsWith("vi")) {
    return "vi";
  }
  if (navLang.startsWith("en")) {
    return "en";
  }
  return DEFAULT_APP_LOCALE;
}

export async function loadLazyLocaleTranslation(locale: Locale): Promise<TranslationMap | null> {
  if (!isLazyLocale(locale)) {
    return null;
  }
  const registration = LAZY_LOCALE_REGISTRY[locale];
  const module = await registration.loader();
  return module[registration.exportName] ?? null;
}
