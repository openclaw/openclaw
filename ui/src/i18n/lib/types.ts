export type TranslationMap = { [key: string]: string | TranslationMap };

export type Locale =
  | "en"
  | "vi"
  | "zh-CN"
  | "zh-TW"
  | "pt-BR"
  | "de"
  | "es"
  | "ja-JP"
  | "ko"
  | "fr"
  | "tr"
  | "uk"
  | "id"
  | "pl";

export interface I18nConfig {
  locale: Locale;
  fallbackLocale: Locale;
  translations: Record<Locale, TranslationMap>;
}
