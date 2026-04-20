import { lowercasePreservingWhitespace } from "./shared/string-coerce.js";
import { normalizeOptionalString } from "./shared/string-coerce.js";
import { asFiniteNumber, asInteger } from "./shared/number-coercion.js";

function toSnakeCaseKey(key: string): string {
  const snakeKey = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return lowercasePreservingWhitespace(snakeKey);
}

function toCamelCaseKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function resolveSnakeCaseParamKey(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  if (Object.hasOwn(params, key)) {
    return key;
  }
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
    return snakeKey;
  }
  return undefined;
}

export function readSnakeCaseParamRaw(params: Record<string, unknown>, key: string): unknown {
  const resolvedKey = resolveSnakeCaseParamKey(params, key);
  if (resolvedKey) {
    return params[resolvedKey];
  }
  return undefined;
}

export function resolveCamelCaseParamKey(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  if (Object.hasOwn(params, key)) {
    return key;
  }
  const camelKey = toCamelCaseKey(key);
  if (camelKey !== key && Object.hasOwn(params, camelKey)) {
    return camelKey;
  }
  return undefined;
}

export function readCamelCaseParamRaw(params: Record<string, unknown>, key: string): unknown {
  const resolvedKey = resolveCamelCaseParamKey(params, key);
  if (resolvedKey) {
    return params[resolvedKey];
  }
  return undefined;
}

export function readSnakeCaseParamString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = readSnakeCaseParamRaw(params, key);
  return normalizeOptionalString(value);
}

export function readCamelCaseParamString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = readCamelCaseParamRaw(params, key);
  return normalizeOptionalString(value);
}

export function readSnakeCaseParamNumber(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readSnakeCaseParamRaw(params, key);
  return asFiniteNumber(value);
}

export function readCamelCaseParamNumber(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readCamelCaseParamRaw(params, key);
  return asFiniteNumber(value);
}

export function readSnakeCaseParamInteger(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readSnakeCaseParamRaw(params, key);
  return asInteger(value);
}

export function readCamelCaseParamInteger(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = readCamelCaseParamRaw(params, key);
  return asInteger(value);
}

export function readSnakeCaseParamBoolean(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = readSnakeCaseParamRaw(params, key);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
      return true;
    }
    if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
      return false;
    }
  }
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  return undefined;
}

export function readCamelCaseParamBoolean(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = readCamelCaseParamRaw(params, key);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
      return true;
    }
    if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
      return false;
    }
  }
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  return undefined;
}

export function readSnakeCaseParamArray(
  params: Record<string, unknown>,
  key: string,
): unknown[] | undefined {
  const value = readSnakeCaseParamRaw(params, key);
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // ignore parse errors
    }
  }
  return undefined;
}

export function readCamelCaseParamArray(
  params: Record<string, unknown>,
  key: string,
): unknown[] | undefined {
  const value = readCamelCaseParamRaw(params, key);
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // ignore parse errors
    }
  }
  return undefined;
}

export function readSnakeCaseParamObject(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = readSnakeCaseParamRaw(params, key);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse errors
    }
  }
  return undefined;
}

export function readCamelCaseParamObject(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = readCamelCaseParamRaw(params, key);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse errors
    }
  }
  return undefined;
}