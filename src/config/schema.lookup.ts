import type { ConfigSchemaLookupResult as ProtocolConfigSchemaLookupResult } from "../../packages/gateway-protocol/src/schema/config.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import type { ConfigUiHints } from "./schema.hints.js";
import {
  LOOKUP_SCHEMA_COMPOSITION_KEYS,
  lookupSchemaHasChildren,
  resolveLookupSchemaNode,
  type LookupSchemaNode,
} from "./schema.lookup-refs.js";
import {
  asSchemaObject,
  findWildcardHintMatch,
  type ConfigJsonSchemaObject as JsonSchemaObject,
  type ConfigSchemaResponse,
} from "./schema.shared.js";

type JsonSchemaNode = Record<string, unknown>;

const LOOKUP_SCHEMA_STRING_KEYS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "format",
  "pattern",
  "contentEncoding",
  "contentMediaType",
]);
const LOOKUP_SCHEMA_NUMBER_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);
const LOOKUP_SCHEMA_BOOLEAN_KEYS = new Set([
  "additionalProperties",
  "uniqueItems",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const MAX_LOOKUP_PATH_SEGMENTS = 32;
const LOOKUP_SCHEMA_NESTED_FORM_DEPTH = 4;

type ConfigSchemaLookupChild = ProtocolConfigSchemaLookupResult["children"][number];
type ConfigSchemaReloadKind = NonNullable<ProtocolConfigSchemaLookupResult["reloadKind"]>;

type ConfigSchemaReloadMetadata = {
  kind: ConfigSchemaReloadKind;
};

type ConfigSchemaReloadMetadataResolver = (
  path: string,
) => ConfigSchemaReloadMetadata | null | undefined;

type ConfigSchemaLookupResult = Omit<ProtocolConfigSchemaLookupResult, "schema"> & {
  schema: JsonSchemaNode;
};

function normalizeLookupPath(path: string): string {
  return path
    .trim()
    .replace(/\[(\*|\d*)\]/g, (_match, segment: string) => `.${segment || "*"}`)
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.+/g, ".");
}

function splitLookupPath(path: string): string[] {
  const normalized = normalizeLookupPath(path);
  return normalized ? normalized.split(".").filter(Boolean) : [];
}

function resolveItemsSchema(schema: JsonSchemaObject, index?: number): JsonSchemaObject | null {
  if (Array.isArray(schema.items)) {
    const entry =
      index === undefined
        ? schema.items.find((candidate) => typeof candidate === "object" && candidate !== null)
        : schema.items[index];
    return entry && typeof entry === "object" ? entry : null;
  }
  return schema.items && typeof schema.items === "object" ? schema.items : null;
}

function resolveLookupChildSchema(
  node: LookupSchemaNode,
  segment: string,
  seen = new Set<JsonSchemaObject>(),
): LookupSchemaNode | null {
  if (isBlockedObjectKey(segment) || seen.has(node.identity)) {
    return null;
  }
  const { schema, referenceRoot } = node;
  const visited = new Set(seen).add(node.identity);

  const properties = schema.properties;
  if (properties && Object.hasOwn(properties, segment)) {
    const child = asSchemaObject(properties[segment]);
    return child ? resolveLookupSchemaNode(child, referenceRoot) : null;
  }

  const itemIndex = parseConfigPathArrayIndex(segment);
  const items = resolveItemsSchema(schema, itemIndex);
  if ((segment === "*" || itemIndex !== undefined) && items) {
    return resolveLookupSchemaNode(items, referenceRoot);
  }

  for (const key of LOOKUP_SCHEMA_COMPOSITION_KEYS) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      const variantSchema = asSchemaObject(variant);
      const variantNode = variantSchema
        ? resolveLookupSchemaNode(variantSchema, referenceRoot)
        : null;
      const resolved = variantNode ? resolveLookupChildSchema(variantNode, segment, visited) : null;
      if (resolved) {
        return resolved;
      }
    }
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return resolveLookupSchemaNode(schema.additionalProperties, referenceRoot);
  }

  return null;
}

function resolveLookupSchema(
  response: ConfigSchemaResponse,
  parts: readonly string[],
): LookupSchemaNode | null {
  const root = asSchemaObject(response.schema);
  let current = root ? resolveLookupSchemaNode(root) : null;
  for (const segment of parts) {
    if (!current) {
      break;
    }
    current = resolveLookupChildSchema(current, segment);
  }
  return current;
}

type ConfigSchemaPathSegmentKind = "property" | "record-key" | "array-index" | "invalid-record-key";

function classifyLookupChildSchema(
  node: LookupSchemaNode,
  segment: string,
  seen = new Set<JsonSchemaObject>(),
): ConfigSchemaPathSegmentKind | null {
  if (seen.has(node.identity)) {
    return null;
  }
  const { schema, referenceRoot } = node;
  const visited = new Set(seen).add(node.identity);
  if (schema.properties && Object.hasOwn(schema.properties, segment)) {
    return "property";
  }
  if (parseConfigPathArrayIndex(segment) !== undefined && resolveItemsSchema(schema)) {
    return "array-index";
  }
  for (const key of LOOKUP_SCHEMA_COMPOSITION_KEYS) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      const variantSchema = asSchemaObject(variant);
      const variantNode = variantSchema
        ? resolveLookupSchemaNode(variantSchema, referenceRoot)
        : null;
      const kind = variantNode ? classifyLookupChildSchema(variantNode, segment, visited) : null;
      if (kind) {
        return kind;
      }
    }
  }
  if (schema.additionalProperties === true || typeof schema.additionalProperties === "object") {
    return propertyNameSchemaAllows(schema.propertyNames, segment)
      ? "record-key"
      : "invalid-record-key";
  }
  return null;
}

const PROPERTY_NAME_SCHEMA_KEYS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "anyOf",
  "oneOf",
  "allOf",
]);

function propertyNameSchemaAllows(schema: unknown, value: string): boolean {
  if (schema === undefined || schema === true) {
    return true;
  }
  if (schema === false) {
    return false;
  }
  const object = asSchemaObject(schema);
  if (!object || Object.keys(object).some((key) => !PROPERTY_NAME_SCHEMA_KEYS.has(key))) {
    return false;
  }
  const types = Array.isArray(object.type) ? object.type : [object.type];
  if (object.type !== undefined && !types.includes("string")) {
    return false;
  }
  if (object.const !== undefined && object.const !== value) {
    return false;
  }
  if (Array.isArray(object.enum) && !object.enum.includes(value)) {
    return false;
  }
  if (typeof object.minLength === "number" && value.length < object.minLength) {
    return false;
  }
  if (typeof object.maxLength === "number" && value.length > object.maxLength) {
    return false;
  }
  if (typeof object.pattern === "string") {
    try {
      if (!new RegExp(object.pattern).test(value)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (object.allOf?.some((candidate) => !propertyNameSchemaAllows(candidate, value))) {
    return false;
  }
  if (
    object.anyOf &&
    !object.anyOf.some((candidate) => propertyNameSchemaAllows(candidate, value))
  ) {
    return false;
  }
  if (
    object.oneOf &&
    object.oneOf.filter((candidate) => propertyNameSchemaAllows(candidate, value)).length !== 1
  ) {
    return false;
  }
  return true;
}

/** Classify one already-parsed path segment without losing dots inside record keys. */
export function classifyConfigSchemaPathSegment(
  response: ConfigSchemaResponse,
  parentParts: readonly string[],
  segment: string,
): ConfigSchemaPathSegmentKind | null {
  const current = resolveLookupSchema(response, parentParts);
  return current ? classifyLookupChildSchema(current, segment) : null;
}

function stripSchemaForLookup(
  node: LookupSchemaNode,
  nestedFormDepth = 0,
  seen = new Set<JsonSchemaObject>(),
): JsonSchemaNode {
  if (seen.has(node.identity)) {
    return {};
  }
  const { schema, referenceRoot } = node;
  const visited = new Set(seen).add(node.identity);
  const next: JsonSchemaNode = {};
  const stripChild = (childSchema: JsonSchemaObject) => {
    const child = resolveLookupSchemaNode(childSchema, referenceRoot);
    return child ? stripSchemaForLookup(child, nestedFormDepth + 1, visited) : {};
  };

  for (const [key, value] of Object.entries(schema)) {
    if (LOOKUP_SCHEMA_STRING_KEYS.has(key) && typeof value === "string") {
      next[key] = value;
      continue;
    }
    if (LOOKUP_SCHEMA_NUMBER_KEYS.has(key) && typeof value === "number") {
      next[key] = value;
      continue;
    }
    if (LOOKUP_SCHEMA_BOOLEAN_KEYS.has(key) && typeof value === "boolean") {
      next[key] = value;
      continue;
    }
    if (key === "type") {
      if (typeof value === "string") {
        next[key] = value;
      } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        next[key] = [...value];
      }
      continue;
    }
    if (key === "enum" && Array.isArray(value)) {
      const entries = value.filter(
        (entry) =>
          entry === null ||
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean",
      );
      if (entries.length === value.length) {
        next[key] = [...entries];
      }
      continue;
    }
    if (
      key === "const" &&
      (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
    ) {
      next[key] = value;
    }
  }

  if (
    schema.properties &&
    ((nestedFormDepth > 0 && nestedFormDepth <= LOOKUP_SCHEMA_NESTED_FORM_DEPTH) ||
      (schema.additionalProperties && typeof schema.additionalProperties === "object"))
  ) {
    next.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [key, stripChild(child)]),
    );
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    next.additionalProperties = stripChild(schema.additionalProperties);
  }
  if (Array.isArray(schema.items)) {
    next.items = schema.items.map(stripChild);
  } else if (schema.items && typeof schema.items === "object") {
    next.items = stripChild(schema.items);
  }
  if (nestedFormDepth <= LOOKUP_SCHEMA_NESTED_FORM_DEPTH) {
    for (const key of LOOKUP_SCHEMA_COMPOSITION_KEYS) {
      const variants = schema[key];
      if (!Array.isArray(variants)) {
        continue;
      }
      next[key] = variants
        .filter((variant) => variant && typeof variant === "object")
        .map(stripChild);
    }
  }

  return next;
}

function buildLookupChildren(
  node: LookupSchemaNode,
  path: string,
  uiHints: ConfigUiHints,
  splitPath: (path: string) => string[],
  resolveReloadMetadata?: ConfigSchemaReloadMetadataResolver,
): ConfigSchemaLookupChild[] {
  const { schema, referenceRoot } = node;
  const children: ConfigSchemaLookupChild[] = [];
  const required = new Set(schema.required ?? []);

  const pushChild = (key: string, childSchema: JsonSchemaObject, isRequired: boolean) => {
    const child = resolveLookupSchemaNode(childSchema, referenceRoot);
    if (!child) {
      return;
    }
    const childPath = path ? `${path}.${key}` : key;
    const resolvedHint = findWildcardHintMatch({ uiHints, path: childPath, splitPath });
    const reloadMetadata = resolveReloadMetadata?.(childPath);
    children.push({
      key,
      path: childPath,
      type: child.schema.type,
      required: isRequired,
      hasChildren: lookupSchemaHasChildren(child),
      reloadKind: reloadMetadata?.kind,
      hint: resolvedHint?.hint,
      hintPath: resolvedHint?.path,
    });
  };

  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    pushChild(key, childSchema, required.has(key));
  }

  const wildcardSchema =
    (schema.additionalProperties &&
    typeof schema.additionalProperties === "object" &&
    !Array.isArray(schema.additionalProperties)
      ? schema.additionalProperties
      : null) ?? resolveItemsSchema(schema);
  if (wildcardSchema) {
    pushChild("*", wildcardSchema, false);
  }

  return children;
}

export function lookupConfigSchema(
  response: ConfigSchemaResponse,
  path: string,
  resolveReloadMetadata?: ConfigSchemaReloadMetadataResolver,
): ConfigSchemaLookupResult | null {
  const wantsRoot = path.trim() === ".";
  const normalizedPath = normalizeLookupPath(path);
  if (!normalizedPath && !wantsRoot) {
    return null;
  }
  const parts = splitLookupPath(normalizedPath);
  if ((!wantsRoot && parts.length === 0) || parts.length > MAX_LOOKUP_PATH_SEGMENTS) {
    return null;
  }

  const current = resolveLookupSchema(response, parts);
  if (!current) {
    return null;
  }

  // Parent and child lookups share path parsing only for this response.
  const hintParts = new Map<string, string[]>();
  const splitHintPath = lookupSchemaHasChildren(current)
    ? (hintPath: string): string[] => {
        let cachedParts = hintParts.get(hintPath);
        if (!cachedParts) {
          cachedParts = splitLookupPath(hintPath);
          hintParts.set(hintPath, cachedParts);
        }
        return cachedParts;
      }
    : splitLookupPath;
  const resolvedHint = findWildcardHintMatch({
    uiHints: response.uiHints,
    path: normalizedPath,
    splitPath: splitHintPath,
  });
  const reloadMetadata = resolveReloadMetadata?.(normalizedPath);
  return {
    path: wantsRoot ? "." : normalizedPath,
    schema: stripSchemaForLookup(current),
    reloadKind: reloadMetadata?.kind,
    hint: resolvedHint?.hint,
    hintPath: resolvedHint?.path,
    children: buildLookupChildren(
      current,
      wantsRoot ? "" : normalizedPath,
      response.uiHints,
      splitHintPath,
      resolveReloadMetadata,
    ),
  };
}
