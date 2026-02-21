import { en } from "./locales/en.js";
import { zh_TW } from "./locales/zh-TW.js";

export type LanguageCode = "en" | "zh-TW";

const translations: Record<LanguageCode, any> = {
  en,
  "zh-TW": zh_TW,
};

let currentLanguage: LanguageCode = "en";

export function setLanguage(lang: string | undefined | null) {
  if (!lang) return;
  const l = lang.toLowerCase();
  if (l.includes("zh-tw") || l.includes("hant") || l === "tw") {
    currentLanguage = "zh-TW";
  } else {
    currentLanguage = "en";
  }
}

export function getLanguage(): LanguageCode {
  return currentLanguage;
}

export function t(key: string, replacements?: Record<string, string>, lang?: LanguageCode): string {
  const targetLang = lang ?? currentLanguage;
  const parts = key.split(".");
  let value: any = translations[targetLang];

  for (const part of parts) {
    value = value?.[part];
  }

  if (typeof value !== "string" && targetLang !== "en") {
    // Fallback to English
    value = translations.en;
    for (const part of parts) {
      value = value?.[part];
    }
  }

  if (typeof value !== "string") {
    return key;
  }

  if (replacements) {
    let result = value;
    for (const [k, v] of Object.entries(replacements)) {
      result = result.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
    return result;
  }

  return value;
}
