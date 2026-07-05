// Control UI type declarations define types contracts.
export type TranslationMap = { [key: string]: string | TranslationMap };

export type Locale =
  | "en"
  | "zh-CN"
  | "zh-TW"
  | "pt-BR"
  | "de"
  | "es"
  | "ja-JP"
  | "ko"
  | "fr"
<<<<<<< HEAD
  | "hi"
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  | "ar"
  | "it"
  | "tr"
  | "uk"
  | "id"
  | "pl"
  | "th"
  | "vi"
  | "nl"
<<<<<<< HEAD
  | "fa"
  | "ru";
=======
  | "fa";

export interface I18nConfig {
  locale: Locale;
  fallbackLocale: Locale;
  translations: Record<Locale, TranslationMap>;
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
