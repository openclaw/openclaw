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
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const existed = original !== null && Object.hasOwn(original, key);
      const pruned = pruneEmptyConfigValue(item, existed ? original[key] : undefined);
      if (!existed && isRecord(pruned) && Object.keys(pruned).length === 0) {
        return [];
      }
      return [[key, pruned]];
    }),
  );
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

type PathPatchMode = "copy" | "set" | "remove";

type PathPatchResult = { ok: true; value: unknown } | { ok: false };

function patchPathValue(
  current: unknown,
  path: Array<string | number>,
  index: number,
  replacement: unknown,
  mode: PathPatchMode,
): PathPatchResult {
  const segment = path[index];
  if (segment === undefined) {
    return { ok: false };
  }
  const last = index === path.length - 1;
  const remove = mode === "remove" || (mode === "copy" && replacement === undefined);
  if (mode === "remove" && current == null) {
    return { ok: false };
  }

  if (typeof segment === "number") {
    if (current != null && !Array.isArray(current)) {
      return { ok: false };
    }
    const next = Array.isArray(current) ? (mode === "copy" ? [...current] : current) : [];
    if (last) {
      if (remove) {
        next.splice(segment, 1);
      } else {
        next[segment] = replacement;
      }
      return { ok: true, value: next };
    }
    const child = patchPathValue(
      Object.hasOwn(next, segment) ? next[segment] : undefined,
      path,
      index + 1,
      replacement,
      mode,
    );
    if (!child.ok) {
      return child;
    }
    next[segment] = child.value;
    return { ok: true, value: next };
  }

  if (current != null && (typeof current !== "object" || Array.isArray(current))) {
    return { ok: false };
  }
  const record = current as Record<string, unknown> | null | undefined;
  const next = record ? (mode === "copy" ? { ...record } : record) : {};
  const child = last
    ? { ok: true as const, value: replacement }
    : patchPathValue(
        Object.hasOwn(next, segment) ? next[segment] : undefined,
        path,
        index + 1,
        replacement,
        mode,
      );
  if (!child.ok) {
    return child;
  }
  if (last && remove) {
    delete next[segment];
  } else {
    Object.defineProperty(next, segment, {
      value: child.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { ok: true, value: next };
}

export function copyWithPathPatch(
  current: unknown,
  path: Array<string | number>,
  replacement: unknown,
): PathPatchResult {
  if (path.length === 0) {
    return { ok: true, value: replacement };
  }
  return patchPathValue(current, path, 0, replacement, "copy");
}

export function setPathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  value: unknown,
) {
  patchPathValue(obj, path, 0, value, "set");
}

export function removePathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
) {
  patchPathValue(obj, path, 0, undefined, "remove");
}
