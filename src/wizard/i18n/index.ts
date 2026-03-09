import { en, zhCN, type HatchTranslations } from "./hatch.js";

type Locale = "en" | "zh-CN";

const translations: Record<Locale, HatchTranslations> = {
  en,
  "zh-CN": zhCN,
};

let currentLocale: Locale = "en";

export function detectLocale(): Locale {
  const lang = process.env.LANG || process.env.LC_ALL || "";
  if (lang.startsWith("zh")) {
    return "zh-CN";
  }
  return "en";
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t(key: string, params?: Record<string, string>): string {
  const keys = key.split(".");
  let value: any = translations[currentLocale];

  for (const k of keys) {
    value = value?.[k];
  }

  if (typeof value !== "string") {
    return key;
  }

  if (params) {
    return value.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  }

  return value;
}
