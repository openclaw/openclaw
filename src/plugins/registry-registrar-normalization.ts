import { normalizePluginHostHookId } from "./host-hooks.js";

export function normalizeHostHookString(value: unknown): string {
  return typeof value === "string" ? normalizePluginHostHookId(value) : "";
}

export function normalizeOptionalHostHookString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeHostHookStringList(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value.map((item) => normalizeOptionalHostHookString(item));
  return normalized.some((item) => !item) ? null : (normalized as string[]);
}
