import { Compile } from "typebox/compile";
import type { JsonSchemaObject } from "./json-schema.types.js";

type JsonSchemaValue = JsonSchemaObject | boolean;
type LocalRefResolution =
  | { found: true; schema: JsonSchemaValue; resourceRoot: JsonSchemaValue }
  | { found: false };
const schemaResourceIds = new WeakMap<object, number>();
let nextSchemaResourceId = 1;
const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const schemaValueKeywords = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaCombinatorKeywords = new Set(["allOf", "anyOf", "oneOf"]);
const jsonSchemaTypes = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const schemaStringKeywords = new Set([
  "$comment",
  "$id",
  "$schema",
  "$ref",
  "contentEncoding",
  "contentMediaType",
  "description",
  "format",
  "pattern",
  "title",
]);
const schemaNumberKeywords = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
  "multipleOf",
]);
const schemaIntegerKeywords = new Set([
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
]);
const schemaBooleanKeywords = new Set(["deprecated", "readOnly", "uniqueItems", "writeOnly"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function schemaTypeIncludes(schema: Record<string, unknown>, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function schemaResourceRefKey(resourceRoot: JsonSchemaValue, ref: string): string {
  if (!isRecord(resourceRoot)) {
    return `boolean:${String(resourceRoot)}:${ref}`;
  }
  let id = schemaResourceIds.get(resourceRoot);
  if (id === undefined) {
    id = nextSchemaResourceId++;
    schemaResourceIds.set(resourceRoot, id);
  }
  return `schema:${id}:${ref}`;
}

function normalizeSchemaMap(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeJsonSchemaNode(entry)]),
  );
}

function normalizeSchemaDependencies(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isStringArray(entry) ? entry : normalizeJsonSchemaNode(entry),
    ]),
  );
}

function expandJsonSchemaTypeArray(schema: Record<string, unknown>): Record<string, unknown> {
  const { type, ...rest } = schema;
  if (!Array.isArray(type)) {
    return schema;
  }
  return {
    anyOf: type.map((entry) => Object.assign({}, rest, { type: entry })),
  };
}

function normalizeJsonSchemaNode(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeJsonSchemaNode(entry));
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const normalizedSchema = expandJsonSchemaTypeArray(schema);
  return Object.fromEntries(
    Object.entries(normalizedSchema).map(([key, value]) => {
      if (schemaMapKeywords.has(key)) {
        return [key, normalizeSchemaMap(value)];
      }
      if (key === "dependencies") {
        return [key, normalizeSchemaDependencies(value)];
      }
      if (schemaValueKeywords.has(key) || schemaArrayKeywords.has(key)) {
        return [key, normalizeJsonSchemaNode(value)];
      }
      return [key, value];
    }),
  );
}

function validateTypeKeyword(type: unknown, path: string): string | undefined {
  if (typeof type === "string") {
    return jsonSchemaTypes.has(type) ? undefined : `${path}.type: unsupported JSON Schema type`;
  }
  if (Array.isArray(type) && type.length > 0) {
    const invalid = type.find((entry) => typeof entry !== "string" || !jsonSchemaTypes.has(entry));
    return invalid === undefined ? undefined : `${path}.type: unsupported JSON Schema type`;
  }
  return `${path}.type: expected string or non-empty string array`;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalAnchor(
  schema: JsonSchemaValue,
  anchor: string,
  isRoot = true,
): JsonSchemaValue | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  if (!isRoot && typeof schema.$id === "string") {
    return undefined;
  }
  if (schema.$anchor === anchor || schema.$dynamicAnchor === anchor) {
    return schema;
  }
  for (const key of schemaMapKeywords) {
    const value = schema[key];
    if (!isRecord(value)) {
      continue;
    }
    for (const entry of Object.values(value)) {
      const resolved = resolveLocalAnchor(entry as JsonSchemaValue, anchor, false);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  if (isRecord(schema.dependencies)) {
    for (const entry of Object.values(schema.dependencies)) {
      if (isStringArray(entry)) {
        continue;
      }
      const resolved = resolveLocalAnchor(entry as JsonSchemaValue, anchor, false);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  for (const key of schemaValueKeywords) {
    const value = schema[key];
    if (typeof value === "boolean" || isRecord(value)) {
      const resolved = resolveLocalAnchor(value as JsonSchemaValue, anchor, false);
      if (resolved !== undefined) {
        return resolved;
      }
      continue;
    }
    if (key === "items" && Array.isArray(value)) {
      for (const entry of value) {
        const resolved = resolveLocalAnchor(entry as JsonSchemaValue, anchor, false);
        if (resolved !== undefined) {
          return resolved;
        }
      }
    }
  }
  for (const key of schemaArrayKeywords) {
    const value = schema[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      const resolved = resolveLocalAnchor(entry as JsonSchemaValue, anchor, false);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  return undefined;
}

function resolveLocalRef(resourceRoot: JsonSchemaValue, ref: string): LocalRefResolution {
  if (isRecord(resourceRoot) && typeof resourceRoot.$id === "string" && resourceRoot.$id !== "") {
    if (ref === resourceRoot.$id) {
      return { found: true, schema: resourceRoot, resourceRoot };
    }
    if (ref.startsWith(`${resourceRoot.$id}#`)) {
      return resolveLocalRef(resourceRoot, ref.slice(resourceRoot.$id.length));
    }
  }
  if (ref === "#") {
    return { found: true, schema: resourceRoot, resourceRoot };
  }
  if (ref.startsWith("#/")) {
    let current: unknown = resourceRoot;
    let currentResourceRoot = resourceRoot;
    for (const segment of ref.slice(2).split("/").map(decodePointerSegment)) {
      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || index < 0) {
          return { found: false };
        }
        current = current[index];
      } else if (isRecord(current)) {
        current = current[segment];
      } else {
        return { found: false };
      }
      if (isRecord(current) && typeof current.$id === "string") {
        currentResourceRoot = current as JsonSchemaValue;
      }
    }
    return typeof current === "boolean" || isRecord(current)
      ? {
          found: true,
          schema: current as JsonSchemaValue,
          resourceRoot: currentResourceRoot,
        }
      : { found: false };
  }
  if (ref.startsWith("#")) {
    const resolved = resolveLocalAnchor(resourceRoot, decodeURIComponent(ref.slice(1)));
    return resolved === undefined
      ? { found: false }
      : { found: true, schema: resolved, resourceRoot };
  }
  return { found: false };
}

export function normalizeJsonSchemaForTypeBox(schema: JsonSchemaValue): JsonSchemaValue {
  return normalizeJsonSchemaNode(schema) as JsonSchemaValue;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateSchemaKeywordShapes(
  schema: Record<string, unknown>,
  path: string,
): string | undefined {
  for (const key of schemaStringKeywords) {
    const value = schema[key];
    if (value !== undefined && typeof value !== "string") {
      return `${path}.${key}: expected string`;
    }
  }
  for (const key of schemaNumberKeywords) {
    const value = schema[key];
    if (value !== undefined && typeof value !== "number") {
      return `${path}.${key}: expected number`;
    }
  }
  for (const key of schemaIntegerKeywords) {
    const value = schema[key];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || (typeof value === "number" && value < 0))
    ) {
      return `${path}.${key}: expected non-negative integer`;
    }
  }
  for (const key of schemaBooleanKeywords) {
    const value = schema[key];
    if (value !== undefined && typeof value !== "boolean") {
      return `${path}.${key}: expected boolean`;
    }
  }
  if (
    schema.multipleOf !== undefined &&
    typeof schema.multipleOf === "number" &&
    schema.multipleOf <= 0
  ) {
    return `${path}.multipleOf: expected positive number`;
  }
  if (schema.required !== undefined && !isStringArray(schema.required)) {
    return `${path}.required: expected string array`;
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    return `${path}.enum: expected array`;
  }
  for (const key of schemaCombinatorKeywords) {
    const value = schema[key];
    if (Array.isArray(value) && value.length === 0) {
      return `${path}.${key}: expected non-empty schema array`;
    }
  }
  if (schema.dependentRequired !== undefined) {
    if (!isRecord(schema.dependentRequired)) {
      return `${path}.dependentRequired: expected string array map`;
    }
    for (const [key, value] of Object.entries(schema.dependentRequired)) {
      if (!isStringArray(value)) {
        return `${path}.dependentRequired.${key}: expected string array`;
      }
    }
  }
  if (schema.dependencies !== undefined) {
    if (!isRecord(schema.dependencies)) {
      return `${path}.dependencies: expected schema or string array map`;
    }
    for (const [key, value] of Object.entries(schema.dependencies)) {
      if (!isStringArray(value) && typeof value !== "boolean" && !isRecord(value)) {
        return `${path}.dependencies.${key}: expected schema or string array`;
      }
    }
  }
  return undefined;
}

function findJsonSchemaNodeError(
  schema: unknown,
  path: string,
  resourceRoot: JsonSchemaValue,
): string | undefined {
  if (typeof schema === "boolean") {
    return undefined;
  }
  if (!isRecord(schema)) {
    return `${path}: schema must be an object or boolean`;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "type")) {
    const typeError = validateTypeKeyword(schema.type, path);
    if (typeError) {
      return typeError;
    }
  }
  const keywordError = validateSchemaKeywordShapes(schema, path);
  if (keywordError) {
    return keywordError;
  }
  const currentResourceRoot = typeof schema.$id === "string" ? schema : resourceRoot;
  if (typeof schema.$ref === "string") {
    if (!resolveLocalRef(currentResourceRoot, schema.$ref).found) {
      return `${path}.$ref: unresolved local ref`;
    }
  }
  for (const key of schemaMapKeywords) {
    const value = schema[key];
    if (value === undefined) {
      continue;
    }
    if (!isRecord(value)) {
      return `${path}.${key}: expected schema map`;
    }
    for (const [entryKey, entry] of Object.entries(value)) {
      const error = findJsonSchemaNodeError(
        entry,
        `${path}.${key}.${entryKey}`,
        currentResourceRoot,
      );
      if (error) {
        return error;
      }
    }
  }
  if (isRecord(schema.dependencies)) {
    for (const [key, value] of Object.entries(schema.dependencies)) {
      if (isStringArray(value)) {
        continue;
      }
      const error = findJsonSchemaNodeError(
        value,
        `${path}.dependencies.${key}`,
        currentResourceRoot,
      );
      if (error) {
        return error;
      }
    }
  }
  for (const key of schemaValueKeywords) {
    const value = schema[key];
    if (value === undefined || typeof value === "boolean") {
      continue;
    }
    if (Array.isArray(value)) {
      if (key !== "items") {
        return `${path}.${key}: expected schema`;
      }
      for (const [index, entry] of value.entries()) {
        const error = findJsonSchemaNodeError(
          entry,
          `${path}.${key}.${index}`,
          currentResourceRoot,
        );
        if (error) {
          return error;
        }
      }
      continue;
    }
    const error = findJsonSchemaNodeError(value, `${path}.${key}`, currentResourceRoot);
    if (error) {
      return error;
    }
  }
  for (const key of schemaArrayKeywords) {
    const value = schema[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      return `${path}.${key}: expected schema array`;
    }
    for (const [index, entry] of value.entries()) {
      const error = findJsonSchemaNodeError(entry, `${path}.${key}.${index}`, currentResourceRoot);
      if (error) {
        return error;
      }
    }
  }
  return undefined;
}

export function findJsonSchemaShapeError(schema: JsonSchemaValue): string | undefined {
  return findJsonSchemaNodeError(schema, "<schema>", schema);
}

function cloneDefault<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return structuredClone(value);
}

function getDefault(schema: JsonSchemaValue): unknown {
  if (!isRecord(schema) || !Object.prototype.hasOwnProperty.call(schema, "default")) {
    return undefined;
  }
  return cloneDefault(schema.default);
}

function schemaWithResourceContext(
  schema: JsonSchemaValue,
  resourceRoot: JsonSchemaValue,
): JsonSchemaValue {
  if (!isRecord(schema) || !isRecord(resourceRoot)) {
    return schema;
  }
  return {
    ...schema,
    ...(typeof resourceRoot.$id === "string" && schema.$id === undefined
      ? { $id: resourceRoot.$id }
      : {}),
    ...(isRecord(resourceRoot.$defs) ? { $defs: resourceRoot.$defs } : {}),
    ...(isRecord(resourceRoot.definitions) ? { definitions: resourceRoot.definitions } : {}),
  };
}

function inlineLocalRefsForMatch(
  schema: JsonSchemaValue,
  resourceRoot: JsonSchemaValue,
  resolvingRefs = new Set<string>(),
): JsonSchemaValue {
  if (Array.isArray(schema)) {
    return schema.map((entry) =>
      inlineLocalRefsForMatch(entry as JsonSchemaValue, resourceRoot, resolvingRefs),
    ) as unknown as JsonSchemaValue;
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const currentResourceRoot = typeof schema.$id === "string" ? schema : resourceRoot;
  if (isRecord(schema) && typeof schema.$ref === "string") {
    const refKey = schemaResourceRefKey(currentResourceRoot, schema.$ref);
    const target = resolvingRefs.has(refKey)
      ? { found: false as const }
      : resolveLocalRef(currentResourceRoot, schema.$ref);
    if (target.found) {
      const { $ref, ...siblingSchema } = schema;
      resolvingRefs.add(refKey);
      const inlinedTarget = inlineLocalRefsForMatch(
        target.schema,
        target.resourceRoot,
        resolvingRefs,
      );
      resolvingRefs.delete(refKey);
      if (Object.keys(siblingSchema).length === 0) {
        return inlinedTarget;
      }
      return {
        allOf: [
          inlinedTarget,
          inlineLocalRefsForMatch(
            siblingSchema as JsonSchemaValue,
            currentResourceRoot,
            resolvingRefs,
          ),
        ],
      };
    }
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (schemaMapKeywords.has(key) && isRecord(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([entryKey, entry]) => [
              entryKey,
              inlineLocalRefsForMatch(entry as JsonSchemaValue, currentResourceRoot, resolvingRefs),
            ]),
          ),
        ];
      }
      if (key === "dependencies" && isRecord(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([entryKey, entry]) => [
              entryKey,
              isStringArray(entry)
                ? entry
                : inlineLocalRefsForMatch(
                    entry as JsonSchemaValue,
                    currentResourceRoot,
                    resolvingRefs,
                  ),
            ]),
          ),
        ];
      }
      if (schemaValueKeywords.has(key) || schemaArrayKeywords.has(key)) {
        return [
          key,
          inlineLocalRefsForMatch(value as JsonSchemaValue, currentResourceRoot, resolvingRefs),
        ];
      }
      return [key, value];
    }),
  ) as JsonSchemaValue;
}

function schemaMatches(
  schema: JsonSchemaValue,
  value: unknown,
  resourceRoot: JsonSchemaValue,
): boolean {
  try {
    const matchSchema = inlineLocalRefsForMatch(schema, resourceRoot);
    return Compile(
      normalizeJsonSchemaForTypeBox(schemaWithResourceContext(matchSchema, resourceRoot)) as never,
    ).Check(value);
  } catch {
    return false;
  }
}

function applyObjectPropertyDefaults(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: JsonSchemaValue,
  resolvingRefs: Set<string>,
  currentResourceRoot: JsonSchemaValue,
): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    const currentValue = value[key];
    const defaultedValue = applySchemaDefaults(
      propertySchema as JsonSchemaValue,
      currentValue,
      root,
      resolvingRefs,
      currentResourceRoot,
    );
    if (defaultedValue !== currentValue || currentValue === undefined) {
      if (defaultedValue !== undefined) {
        value[key] = defaultedValue;
      }
    }
  }
  const patternMatchedKeys = new Set<string>();
  if (isRecord(schema.patternProperties)) {
    for (const [pattern, propertySchema] of Object.entries(schema.patternProperties)) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        continue;
      }
      for (const key of Object.keys(value)) {
        if (!regex.test(key)) {
          continue;
        }
        patternMatchedKeys.add(key);
        value[key] = applySchemaDefaults(
          propertySchema as JsonSchemaValue,
          value[key],
          root,
          resolvingRefs,
          currentResourceRoot,
        );
      }
    }
  }
  if (isRecord(schema.additionalProperties)) {
    const additionalSchema = schema.additionalProperties as JsonSchemaValue;
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key) || patternMatchedKeys.has(key)) {
        continue;
      }
      value[key] = applySchemaDefaults(
        additionalSchema,
        value[key],
        root,
        resolvingRefs,
        currentResourceRoot,
      );
    }
  }
  return value;
}

function applyObjectDependencyDefaults(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: JsonSchemaValue,
  resolvingRefs: Set<string>,
  currentResourceRoot: JsonSchemaValue,
): Record<string, unknown> {
  let nextValue = value;
  if (isRecord(schema.dependencies)) {
    for (const [key, dependencySchema] of Object.entries(schema.dependencies)) {
      if (
        !Object.prototype.hasOwnProperty.call(nextValue, key) ||
        isStringArray(dependencySchema)
      ) {
        continue;
      }
      nextValue = applySchemaDefaults(
        dependencySchema as JsonSchemaValue,
        nextValue,
        root,
        resolvingRefs,
        currentResourceRoot,
      ) as Record<string, unknown>;
    }
  }
  if (isRecord(schema.dependentSchemas)) {
    for (const [key, dependentSchema] of Object.entries(schema.dependentSchemas)) {
      if (!Object.prototype.hasOwnProperty.call(nextValue, key)) {
        continue;
      }
      nextValue = applySchemaDefaults(
        dependentSchema as JsonSchemaValue,
        nextValue,
        root,
        resolvingRefs,
        currentResourceRoot,
      ) as Record<string, unknown>;
    }
  }
  return nextValue;
}

function applyObjectConditionalDefaults(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: JsonSchemaValue,
  resolvingRefs: Set<string>,
  currentResourceRoot: JsonSchemaValue,
): Record<string, unknown> {
  if (!(typeof schema.if === "boolean" || isRecord(schema.if))) {
    return value;
  }
  const branch = schemaMatches(schema.if as JsonSchemaValue, value, currentResourceRoot)
    ? schema.then
    : schema.else;
  if (!(typeof branch === "boolean" || isRecord(branch))) {
    return value;
  }
  return applySchemaDefaults(
    branch as JsonSchemaValue,
    value,
    root,
    resolvingRefs,
    currentResourceRoot,
  ) as Record<string, unknown>;
}

function countSchemaNodes(schema: JsonSchemaValue, seen = new Set<object>()): number {
  if (typeof schema === "boolean" || !isRecord(schema) || seen.has(schema)) {
    return 1;
  }
  seen.add(schema);
  let count = 1;
  for (const key of schemaMapKeywords) {
    const value = schema[key];
    if (!isRecord(value)) {
      continue;
    }
    for (const entry of Object.values(value)) {
      count += countSchemaNodes(entry as JsonSchemaValue, seen);
    }
  }
  if (isRecord(schema.dependencies)) {
    for (const entry of Object.values(schema.dependencies)) {
      if (!isStringArray(entry)) {
        count += countSchemaNodes(entry as JsonSchemaValue, seen);
      }
    }
  }
  for (const key of schemaValueKeywords) {
    const value = schema[key];
    if (typeof value === "boolean" || isRecord(value)) {
      count += countSchemaNodes(value as JsonSchemaValue, seen);
      continue;
    }
    if (key === "items" && Array.isArray(value)) {
      for (const entry of value) {
        count += countSchemaNodes(entry as JsonSchemaValue, seen);
      }
    }
  }
  for (const key of schemaArrayKeywords) {
    const value = schema[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      count += countSchemaNodes(entry as JsonSchemaValue, seen);
    }
  }
  return count;
}

function applyObjectApplicatorDefaults(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: JsonSchemaValue,
  resolvingRefs: Set<string>,
  currentResourceRoot: JsonSchemaValue,
): Record<string, unknown> {
  let nextValue = value;
  const maxIterations = countSchemaNodes(schema);
  for (let index = 0; index < maxIterations; index++) {
    const before = JSON.stringify(nextValue);
    nextValue = applyObjectPropertyDefaults(
      schema,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
    );
    nextValue = applyObjectDependencyDefaults(
      schema,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
    );
    nextValue = applyObjectConditionalDefaults(
      schema,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
    );
    nextValue = applyObjectPropertyDefaults(
      schema,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
    );
    nextValue = applyObjectDependencyDefaults(
      schema,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
    );
    if (JSON.stringify(nextValue) === before) {
      break;
    }
  }
  return nextValue;
}

function applySchemaDefaults(
  schema: JsonSchemaValue,
  value: unknown,
  root = schema,
  resolvingRefs = new Set<string>(),
  resourceRoot = root,
): unknown {
  if (value === undefined) {
    const defaultValue = getDefault(schema);
    if (defaultValue !== undefined) {
      return defaultValue;
    }
  }
  if (!isRecord(schema)) {
    return value;
  }

  const currentResourceRoot = typeof schema.$id === "string" ? schema : resourceRoot;
  let nextValue = value;
  const refKey =
    typeof schema.$ref === "string"
      ? schemaResourceRefKey(currentResourceRoot, schema.$ref)
      : undefined;
  if (typeof schema.$ref === "string" && refKey !== undefined && !resolvingRefs.has(refKey)) {
    const target = resolveLocalRef(currentResourceRoot, schema.$ref);
    if (target.found) {
      resolvingRefs.add(refKey);
      nextValue = applySchemaDefaults(
        target.schema,
        nextValue,
        root,
        resolvingRefs,
        target.resourceRoot,
      );
      resolvingRefs.delete(refKey);
    }
  }

  const composedSchemas = [...(Array.isArray(schema.allOf) ? schema.allOf : [])];
  for (const branch of composedSchemas) {
    nextValue = applySchemaDefaults(
      branch as JsonSchemaValue,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
    );
  }

  const hasObjectApplicators =
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties) ||
    isRecord(schema.additionalProperties) ||
    isRecord(schema.dependencies) ||
    isRecord(schema.dependentSchemas) ||
    typeof schema.if === "boolean" ||
    isRecord(schema.if);
  if ((schemaTypeIncludes(schema, "object") || hasObjectApplicators) && isRecord(nextValue)) {
    nextValue = applyObjectApplicatorDefaults(
      schema,
      nextValue,
      root,
      resolvingRefs,
      currentResourceRoot,
    );
    return nextValue;
  }

  if (
    (schemaTypeIncludes(schema, "array") || schema.items !== undefined) &&
    Array.isArray(nextValue)
  ) {
    if (Array.isArray(schema.items)) {
      const tupleSchemas = schema.items as unknown[];
      return nextValue.map((item, index) => {
        const itemSchema = tupleSchemas[index];
        return itemSchema === undefined
          ? item
          : applySchemaDefaults(
              itemSchema as JsonSchemaValue,
              item,
              root,
              resolvingRefs,
              currentResourceRoot,
            );
      });
    }
    if (!isRecord(schema.items)) {
      return nextValue;
    }
    return nextValue.map((item) =>
      applySchemaDefaults(
        schema.items as JsonSchemaValue,
        item,
        root,
        resolvingRefs,
        currentResourceRoot,
      ),
    );
  }

  return nextValue;
}

export function applyJsonSchemaDefaults<T>(schema: JsonSchemaValue, value: T): T {
  return applySchemaDefaults(schema, value) as T;
}
