import { isRecord } from "../utils.js";

export function setConfigPathCreate<T extends Record<string, unknown>>(
  target: T,
  pathSegments: string[],
  value: unknown,
): T {
  if (pathSegments.length === 0) {
    throw new Error("Cannot set empty config path");
  }
  let cursor: Record<string, unknown> = target;
  for (const segment of pathSegments.slice(0, -1)) {
    const current = cursor[segment];
    if (!isRecord(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[pathSegments[pathSegments.length - 1]] = value;
  return target;
}

export function mergeConfigObjectValue(existing: unknown, next: unknown): unknown {
  if (!isRecord(existing) || !isRecord(next)) {
    return structuredClone(next);
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(next)) {
    merged[key] = mergeConfigObjectValue(merged[key], value);
  }
  return merged;
}

export function mergeConfigPathCreate<T extends Record<string, unknown>>(
  target: T,
  pathSegments: string[],
  value: unknown,
): T {
  if (pathSegments.length === 0) {
    throw new Error("Cannot merge empty config path");
  }
  let cursor: Record<string, unknown> = target;
  for (const segment of pathSegments.slice(0, -1)) {
    const current = cursor[segment];
    if (!isRecord(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const key = pathSegments[pathSegments.length - 1];
  cursor[key] = mergeConfigObjectValue(cursor[key], value);
  return target;
}
