export function getSystemLocale(): string {
  // Check environment variable first
  const envLocale = process.env.OPENCLAW_LOCALE || process.env.LANG || process.env.LC_ALL;
  if (envLocale) {
    const normalized = normalizeLocale(envLocale);
    if (normalized) {
      return normalized;
    }
  }

  // Try to detect from OS using Intl API
  try {
    const osLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    const normalized = normalizeLocale(osLocale);
    if (normalized) {
      return normalized;
    }
  } catch {
    // Fall through to default
  }

  return "en";
}

function normalizeLocale(locale: string): string | null {
  const lower = locale.toLowerCase().replace(/_/g, "-");

  // Chinese variants
  if (lower.startsWith("zh-cn") || lower.startsWith("zh-hans")) {
    return "zh-CN";
  }
  if (lower.startsWith("zh-tw") || lower.startsWith("zh-hant") || lower.startsWith("zh-hk")) {
    return "zh-TW";
  }
  if (lower.startsWith("zh")) {
    return "zh-CN"; // Default to Simplified Chinese
  }

  // English variants
  if (lower.startsWith("en")) {
    return "en";
  }

  // Japanese
  if (lower.startsWith("ja")) {
    return "ja";
  }

  // Korean
  if (lower.startsWith("ko")) {
    return "ko";
  }

  // Spanish
  if (lower.startsWith("es")) {
    return "es";
  }

  // French
  if (lower.startsWith("fr")) {
    return "fr";
  }

  // German
  if (lower.startsWith("de")) {
    return "de";
  }

  return null;
}
