import { DEFAULT_LOCALE, type Locale } from "../../../../src/shared/control-ui-locale.ts";
import type { TranslationMap } from "./types.ts";

type LocaleModule = Record<string, TranslationMap>;

const LAZY_LOCALE_REGISTRY = {
  "zh-CN": () => import("../locales/zh-CN.ts"),
  "zh-TW": () => import("../locales/zh-TW.ts"),
  "pt-BR": () => import("../locales/pt-BR.ts"),
  de: () => import("../locales/de.ts"),
  es: () => import("../locales/es.ts"),
  "ja-JP": () => import("../locales/ja-JP.ts"),
  ko: () => import("../locales/ko.ts"),
  fr: () => import("../locales/fr.ts"),
  hi: () => import("../locales/hi.ts"),
  ar: () => import("../locales/ar.ts"),
  it: () => import("../locales/it.ts"),
  tr: () => import("../locales/tr.ts"),
  uk: () => import("../locales/uk.ts"),
  id: () => import("../locales/id.ts"),
  pl: () => import("../locales/pl.ts"),
  th: () => import("../locales/th.ts"),
  vi: () => import("../locales/vi.ts"),
  nl: () => import("../locales/nl.ts"),
  fa: () => import("../locales/fa.ts"),
  ru: () => import("../locales/ru.ts"),
  sv: () => import("../locales/sv.ts"),
  ca: () => import("../locales/ca.ts"),
} satisfies Record<Exclude<Locale, typeof DEFAULT_LOCALE>, () => Promise<LocaleModule>>;

export async function loadLazyLocaleTranslation(locale: Locale): Promise<TranslationMap | null> {
  if (locale === DEFAULT_LOCALE) {
    return null;
  }
  const module: LocaleModule = await LAZY_LOCALE_REGISTRY[locale]();
  return module[locale.replaceAll("-", "_")] ?? null;
}
