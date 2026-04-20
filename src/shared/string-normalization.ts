import { normalizeOptionalLowercaseString, normalizeOptionalString } from "./string-coerce.js";

export function normalizeStringEntries(list?: ReadonlyArray<unknown>) {
  return (list ?? []).map((entry) => normalizeOptionalString(String(entry)) ?? "").filter(Boolean);
}

export function normalizeStringEntriesLower(list?: ReadonlyArray<unknown>) {
  return normalizeStringEntries(list).map((entry) => normalizeOptionalLowercaseString(entry) ?? "");
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
    return normalizeStringEntries(value);
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
  const trimmed = normalizeOptionalLowercaseString(raw) ?? "";
  if (!trimmed) {
    return "";
  }
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9#@._+-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

export function normalizeAtHashSlug(raw?: string | null) {
  const trimmed = normalizeOptionalLowercaseString(raw) ?? "";
  if (!trimmed) {
    return "";
  }
  const withoutPrefix = trimmed.replace(/^[@#]+/, "");
  const dashed = withoutPrefix.replace(/[\s_]+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

export function truncateString(str: string, maxLength: number, suffix: string = "..."): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - suffix.length) + suffix;
}

export function truncateStringAtWord(str: string, maxLength: number, suffix: string = "..."): string {
  if (str.length <= maxLength) {
    return str;
  }
  const truncated = str.slice(0, maxLength - suffix.length);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + suffix;
}

export function stripWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

export function removeAccents(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function startsWithIgnoreCase(str: string, prefix: string): boolean {
  return str.toLowerCase().startsWith(prefix.toLowerCase());
}

export function endsWithIgnoreCase(str: string, suffix: string): boolean {
  return str.toLowerCase().endsWith(suffix.toLowerCase());
}

export function includesIgnoreCase(str: string, substring: string): boolean {
  return str.toLowerCase().includes(substring.toLowerCase());
}

export function reverseString(str: string): string {
  return str.split("").reverse().join("");
}

export function repeatString(str: string, count: number): string {
  return str.repeat(count);
}

export function padStartString(str: string, targetLength: number, padString: string = " "): string {
  return str.padStart(targetLength, padString);
}

export function padEndString(str: string, targetLength: number, padString: string = " "): string {
  return str.padEnd(targetLength, padString);
}

export function camelCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)?/g, (_, char) => (char ? char.toUpperCase() : ""))
    .replace(/^[A-Z]/, (char) => char.toLowerCase());
}

export function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function snakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export function pascalCase(str: string): string {
  const camel = camelCase(str);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

export function countWords(str: string): number {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

export function countCharacters(str: string, char: string): number {
  return (str.match(new RegExp(char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
}

export function isPalindrome(str: string): boolean {
  const cleaned = str.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === cleaned.split("").reverse().join("");
}

export function maskString(str: string, visibleStart: number = 4, visibleEnd: number = 4, maskChar: string = "*"): string {
  if (str.length <= visibleStart + visibleEnd) {
    return str;
  }
  return str.slice(0, visibleStart) + maskChar.repeat(str.length - visibleStart - visibleEnd) + str.slice(-visibleEnd);
}

export function generateRandomString(length: number, chars: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function toKebabCaseToTitleCase(str: string): string {
  return str
    .split("-")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function toSnakeCaseToTitleCase(str: string): string {
  return str
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
