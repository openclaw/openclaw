export type TranslationMap = { [key: string]: string | TranslationMap };

export type BuiltinLocale = "en" | "zh-CN" | "zh-TW" | "pt-BR" | "de";
export type Locale = string;

export interface I18nConfig {
  locale: Locale;
  fallbackLocale: BuiltinLocale;
  translations: Record<string, TranslationMap>;
}
