export type TranslationMap = { [key: string]: string | TranslationMap };

export type Locale = "en" | "zh-CN" | "zh-TW" | "pt-BR" | "de" | "es" | "ja" | "fr" | "ru" | "it" | "ar" | "ko" | "hi";

export interface I18nConfig {
  locale: Locale;
  fallbackLocale: Locale;
  translations: Record<Locale, TranslationMap>;
}
