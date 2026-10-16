export const DEFAULT_LOCALE = "en";

export const SUPPORTED_LOCALES = [
  DEFAULT_LOCALE,
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "de",
  "es",
  "ja-JP",
  "ko",
  "fr",
  "hi",
  "ar",
  "it",
  "tr",
  "uk",
  "id",
  "pl",
  "th",
  "vi",
  "nl",
  "fa",
  "ru",
  "sv",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const RTL_LOCALES: readonly Locale[] = ["ar", "fa"];

// Ordered, serializable policy shared with the standalone public reader. Script
// subtags take precedence over regions, including Hant before Hans when both occur.
export const LOCALE_MATCH_RULES: ReadonlyArray<readonly [string, Locale]> = [
  ["^zh.*-hant(?:-|$)", "zh-TW"],
  ["^zh.*-hans(?:-|$)", "zh-CN"],
  ["^zh.*-(?:tw|hk|mo)(?:-|$)", "zh-TW"],
  ["^zh", "zh-CN"],
  ...SUPPORTED_LOCALES.filter((locale) => locale !== "en" && !locale.startsWith("zh")).map(
    (locale): readonly [string, Locale] => ["^" + locale.split("-")[0]!.toLowerCase(), locale],
  ),
];
const navigatorLocaleRules = LOCALE_MATCH_RULES.map(
  ([source, locale]) => [new RegExp(source), locale] as const,
);

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return SUPPORTED_LOCALES.some((locale) => locale === value);
}

export function resolveNavigatorLocale(browserLanguage: string): Locale {
  const language = browserLanguage.toLowerCase();
  return navigatorLocaleRules.find(([pattern]) => pattern.test(language))?.[1] ?? DEFAULT_LOCALE;
}
