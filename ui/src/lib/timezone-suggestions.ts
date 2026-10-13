import {
  normalizeSortedUniqueTrimmedStringList,
  normalizeUniqueTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";

function resolveBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "";
  }
}

function resolveSupportedTimezones(): string[] {
  try {
    return Intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export function resolveTimezoneSuggestions(
  configuredTimezones: string[],
  browserTimezone = resolveBrowserTimezone(),
  supportedTimezones = resolveSupportedTimezones(),
): string[] {
  return normalizeUniqueTrimmedStringList([
    browserTimezone,
    "UTC",
    ...configuredTimezones,
    ...normalizeSortedUniqueTrimmedStringList(supportedTimezones),
  ]);
}
