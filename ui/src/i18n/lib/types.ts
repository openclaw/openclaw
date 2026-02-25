export type TranslationMap = { [key: string]: string | TranslationMap };

export type Locale = "en" | "de" | "bs" | "zh-CN" | "zh-TW" | "pt-BR";

export interface I18nConfig {
  locale: Locale;
  fallbackLocale: Locale;
  translations: Record<Locale, TranslationMap>;
}
