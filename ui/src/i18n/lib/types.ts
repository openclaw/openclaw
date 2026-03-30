export type TranslationMap = { [key: string]: string | TranslationMap };

export type Locale = "en" | "ko-KR" | "zh-CN" | "zh-TW" | "pt-BR" | "de" | "es";

export interface I18nConfig {
  locale: Locale;
  fallbackLocale: Locale;
  translations: Record<Locale, TranslationMap>;
}
