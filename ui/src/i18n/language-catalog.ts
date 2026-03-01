import { canonicalizeLocale } from "./index.ts";

export type LanguageCatalogEntry = {
  locale: string;
  label: string;
};

export const LANGUAGE_CATALOG: ReadonlyArray<LanguageCatalogEntry> = [
  { locale: "ar", label: "Arabic" },
  { locale: "bg", label: "Bulgarian" },
  { locale: "bn", label: "Bengali" },
  { locale: "cs", label: "Czech" },
  { locale: "da", label: "Danish" },
  { locale: "de", label: "German" },
  { locale: "el", label: "Greek" },
  { locale: "en", label: "English" },
  { locale: "en-GB", label: "English (United Kingdom)" },
  { locale: "en-US", label: "English (United States)" },
  { locale: "es", label: "Spanish" },
  { locale: "es-419", label: "Spanish (Latin America)" },
  { locale: "et", label: "Estonian" },
  { locale: "fa", label: "Persian" },
  { locale: "fi", label: "Finnish" },
  { locale: "fr", label: "French" },
  { locale: "he", label: "Hebrew" },
  { locale: "hi", label: "Hindi" },
  { locale: "hr", label: "Croatian" },
  { locale: "hu", label: "Hungarian" },
  { locale: "id", label: "Indonesian" },
  { locale: "it", label: "Italian" },
  { locale: "ja", label: "Japanese" },
  { locale: "ko", label: "Korean" },
  { locale: "lt", label: "Lithuanian" },
  { locale: "lv", label: "Latvian" },
  { locale: "ms", label: "Malay" },
  { locale: "nl", label: "Dutch" },
  { locale: "no", label: "Norwegian" },
  { locale: "pl", label: "Polish" },
  { locale: "pt-BR", label: "Portuguese (Brazil)" },
  { locale: "pt-PT", label: "Portuguese (Portugal)" },
  { locale: "ro", label: "Romanian" },
  { locale: "ru", label: "Russian" },
  { locale: "sk", label: "Slovak" },
  { locale: "sl", label: "Slovenian" },
  { locale: "sr", label: "Serbian" },
  { locale: "sv", label: "Swedish" },
  { locale: "ta", label: "Tamil" },
  { locale: "th", label: "Thai" },
  { locale: "tr", label: "Turkish" },
  { locale: "uk", label: "Ukrainian" },
  { locale: "vi", label: "Vietnamese" },
  { locale: "zh-CN", label: "Chinese (Simplified)" },
  { locale: "zh-TW", label: "Chinese (Traditional)" },
];

const LANGUAGE_LABELS = new Map<string, string>(
  LANGUAGE_CATALOG.map((entry) => [canonicalizeLocale(entry.locale) ?? entry.locale, entry.label]),
);

let languageDisplayNames: Intl.DisplayNames | null = null;
let regionDisplayNames: Intl.DisplayNames | null = null;

function getLanguageDisplayNames(): Intl.DisplayNames | null {
  try {
    languageDisplayNames ??= new Intl.DisplayNames(undefined, { type: "language" });
    return languageDisplayNames;
  } catch {
    return null;
  }
}

function getRegionDisplayNames(): Intl.DisplayNames | null {
  try {
    regionDisplayNames ??= new Intl.DisplayNames(undefined, { type: "region" });
    return regionDisplayNames;
  } catch {
    return null;
  }
}

export function resolveLanguageLabel(localeRaw: string): string {
  const locale = canonicalizeLocale(localeRaw) ?? localeRaw.trim();
  if (!locale) {
    return "";
  }
  const catalogLabel = LANGUAGE_LABELS.get(locale);
  if (catalogLabel) {
    return catalogLabel;
  }
  try {
    const parsed = new Intl.Locale(locale);
    const languageLabel = getLanguageDisplayNames()?.of(parsed.language) ?? parsed.language;
    if (parsed.region) {
      const regionLabel = getRegionDisplayNames()?.of(parsed.region) ?? parsed.region;
      return `${languageLabel} (${regionLabel})`;
    }
    return languageLabel || locale;
  } catch {
    return locale;
  }
}

export function searchLanguageCatalog(queryRaw: string): LanguageCatalogEntry[] {
  const query = queryRaw.trim().toLowerCase();
  if (!query) {
    return [...LANGUAGE_CATALOG];
  }
  return LANGUAGE_CATALOG.filter((entry) => {
    return entry.locale.toLowerCase().includes(query) || entry.label.toLowerCase().includes(query);
  });
}
