import { zhCN } from "./locales/zh-CN.js";
import { zhTW } from "./locales/zh-TW.js";

function detectLocale(): string {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale.startsWith("zh-Hant") || locale === "zh-TW" || locale === "zh-HK" || locale === "zh-MO") return "zh-TW";
    if (locale.startsWith("zh-Hans")) return "zh-CN";
    if (locale.startsWith("zh")) return "zh-CN";
  } catch {
    // Ignore errors from locale detection
  }
  return "en";
}

const currentLocale = detectLocale();

const translations: Record<string, Record<string, string>> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

export function t(key: string): string {
  if (currentLocale === "en") return key;
  const localeMap = translations[currentLocale];
  if (!localeMap) return key;
  return localeMap[key] ?? key;
}
