import {
  normalizeTrimmedStringList,
  normalizeUniqueTrimmedStringList,
  sortUniqueStrings,
} from "@openclaw/normalization-core/string-normalization";

export function normalizeConfiguredSafeBins(entries: unknown): string[] {
  return sortUniqueStrings(normalizeTrimmedStringList(entries).map((entry) => entry.toLowerCase()));
}

export function normalizeConfiguredTrustedSafeBinDirs(entries: unknown): string[] {
  return normalizeUniqueTrimmedStringList(entries);
}
