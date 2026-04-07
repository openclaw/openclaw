import { normalizeOptionalString } from "./string-coerce.js";

export function normalizeStringEntries(list?: ReadonlyArray<unknown>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

export function normalizeStringEntriesLower(list?: ReadonlyArray<unknown>) {
  return normalizeStringEntries(list).map((entry) => entry.toLowerCase());
}

export function normalizeTrimmedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const normalized = normalizeOptionalString(entry);
    return normalized ? [normalized] : [];
  });
}

export function normalizeOptionalTrimmedStringList(value: unknown): string[] | undefined {
  const normalized = normalizeTrimmedStringList(value);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeArrayBackedTrimmedStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return normalizeTrimmedStringList(value);
}

export function normalizeSingleOrTrimmedStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeTrimmedStringList(value);
  }
  const normalized = normalizeOptionalString(value);
  return normalized ? [normalized] : [];
}

export function normalizeCsvOrLooseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeHyphenSlug(raw?: string | null) {
  const trimmed = normalizeOptionalString(raw)?.toLowerCase() ?? "";
  if (!trimmed) {
    return "";
  }
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9#@._+-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

export function normalizeAtHashSlug(raw?: string | null) {
  const trimmed = normalizeOptionalString(raw)?.toLowerCase() ?? "";
  if (!trimmed) {
    return "";
  }
  const withoutPrefix = trimmed.replace(/^[@#]+/, "");
  const dashed = withoutPrefix.replace(/[\s_]+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}
