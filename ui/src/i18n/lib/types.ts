export type TranslationMap = { [key: string]: string | TranslationMap };

export type Locale = "en" | "vi";

export interface I18nConfig {
  locale: Locale;
  fallbackLocale: Locale;
  translations: Record<Locale, TranslationMap>;
}
