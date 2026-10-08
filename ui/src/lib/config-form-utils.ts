import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigUiHint, ConfigUiHints } from "../api/types.ts";
import { configHintTranslationKey } from "../i18n/lib/config-hint-translation.ts";
import { translateActive } from "../i18n/lib/translate.ts";

export function isEnvPlaceholder(value: string): boolean {
  return /^\$\{[^}]*\}$/.test(value.trim());
}

export function isSensitiveLeafValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0 && !isEnvPlaceholder(value);
  }
  return value !== undefined && value !== null;
}

export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  tags?: string[];
  "x-tags"?: string[];
  properties?: Record<string, JsonSchema>;
  propertyNames?: JsonSchema | boolean;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalItems?: JsonSchema | boolean;
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  enumIncludesNull?: boolean;
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema | boolean;
  nullable?: boolean;
};

export function schemaType(schema: JsonSchema): string | undefined {
  if (!schema) {
    return undefined;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.find((type) => type !== "null") ?? schema.type[0];
  }
  return schema.type;
}

export function schemaMayAcceptString(schema: JsonSchema): boolean {
  const declaredTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (declaredTypes.length > 0 && !declaredTypes.includes("string")) {
    return false;
  }
  if (schema.const !== undefined && typeof schema.const !== "string") {
    return false;
  }
  if (schema.enum && !schema.enum.some((entry) => typeof entry === "string")) {
    return false;
  }
  if (schema.allOf && !schema.allOf.every(schemaMayAcceptString)) {
    return false;
  }
  if (schema.anyOf && !schema.anyOf.some(schemaMayAcceptString)) {
    return false;
  }
  return !schema.oneOf || schema.oneOf.some(schemaMayAcceptString);
}

export function pathKey(path: Array<string | number>): string {
  return path.filter((segment) => typeof segment === "string").join(".");
}

const wildcardHintCache = new WeakMap<ConfigUiHints, Array<[string[], ConfigUiHint]>>();

type ResolvedConfigUiHint = {
  hint: ConfigUiHint;
  hintPath: string;
};

function resolveHintForPath(
  path: Array<string | number>,
  hints: ConfigUiHints,
): ResolvedConfigUiHint | undefined {
  const directPath = pathKey(path);
  const direct = hints[directPath];
  if (direct) {
    return { hint: direct, hintPath: directPath };
  }
  const segments = path.map(String);
  let wildcardHints = wildcardHintCache.get(hints);
  if (!wildcardHints) {
    wildcardHints = Object.entries(hints).flatMap(([hintKey, hint]) =>
      hintKey.includes("*") ? [[hintKey.split("."), hint]] : [],
    );
    wildcardHintCache.set(hints, wildcardHints);
  }
  for (const [hintSegments, hint] of wildcardHints) {
    if (
      hintSegments.length === segments.length &&
      hintSegments.every((segment, index) => segment === "*" || segment === segments[index])
    ) {
      return { hint, hintPath: hintSegments.join(".") };
    }
  }
  return undefined;
}

export function hintForPath(path: Array<string | number>, hints: ConfigUiHints) {
  return resolveHintForPath(path, hints)?.hint;
}

export function localizedHintForPath(path: Array<string | number>, hints: ConfigUiHints) {
  const resolved = resolveHintForPath(path, hints);
  if (!resolved) {
    return undefined;
  }
  const { hint, hintPath } = resolved;
  return {
    ...hint,
    label: hint.label
      ? (translateActive(configHintTranslationKey(hintPath, "label", hint.label)) ?? hint.label)
      : hint.label,
    help: hint.help
      ? (translateActive(configHintTranslationKey(hintPath, "help", hint.help)) ?? hint.help)
      : hint.help,
  };
}

export function humanize(raw: string) {
  return raw
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/^./, (m) => m.toUpperCase());
}

export function serializeConfigForm(form: Record<string, unknown>): string {
  return `${JSON.stringify(form, null, 2).trimEnd()}\n`;
}

export const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

/** True when a form subtree still carries server-redacted secret placeholders. */
export function containsRedactedSentinel(value: unknown): boolean {
  const children = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  return value === REDACTED_SENTINEL || children.some(containsRedactedSentinel);
}
function pruneEmptyConfigValue(value: unknown, originalValue: unknown): unknown {
  if (Array.isArray(value)) {
    const originalItems = Array.isArray(originalValue) ? originalValue : [];
    return value.map((item, index) => pruneEmptyConfigValue(item, originalItems[index]));
  }
  if (!isRecord(value)) {
    return value;
  }
  const original = isRecord(originalValue) ? originalValue : null;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const existed = original !== null && Object.hasOwn(original, key);
    const pruned = pruneEmptyConfigValue(item, existed ? original[key] : undefined);
    if (!existed && isRecord(pruned) && Object.keys(pruned).length === 0) {
      continue;
    }
    next[key] = pruned;
  }
  return next;
}

/** Prune newly empty objects without removing authored empties or array positions. */
export function pruneEmptyConfigForm(
  form: Record<string, unknown>,
  original: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!original) {
    return form;
  }
  const pruned = pruneEmptyConfigValue(form, original);
  return isRecord(pruned) ? pruned : form;
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isForbiddenKey(key: string | number): boolean {
  return typeof key === "string" && FORBIDDEN_KEYS.has(key);
}

type PathContainer = {
  current: Record<string | number, unknown>;
  lastKey: string | number;
};

function resolvePathContainer(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  createMissing: boolean,
): PathContainer | null {
  if (path.length === 0 || path.some(isForbiddenKey)) {
    return null;
  }

  let current: unknown = obj;
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (
      key === undefined ||
      typeof current !== "object" ||
      current === null ||
      (typeof key === "number" && !Array.isArray(current))
    ) {
      return null;
    }
    const record = current as Record<string | number, unknown>;
    if (i === path.length - 1) {
      return { current: record, lastKey: key };
    }
    let child = record[key];
    if (child == null) {
      if (!createMissing) {
        return null;
      }
      child = typeof nextKey === "number" ? [] : {};
      record[key] = child;
    }
    current = child;
  }

  return null;
}

export function setPathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  value: unknown,
) {
  const container = resolvePathContainer(obj, path, true);
  if (container) {
    container.current[container.lastKey] = value;
  }
}

export function removePathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
) {
  const container = resolvePathContainer(obj, path, false);
  if (!container) {
    return;
  }

  if (typeof container.lastKey === "number" && Array.isArray(container.current)) {
    container.current.splice(container.lastKey, 1);
  } else {
    delete container.current[container.lastKey];
  }
}
