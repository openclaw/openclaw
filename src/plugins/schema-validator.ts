import {
  normalizeJsonSchemaForTypeBox,
  normalizeTypeBoxValidationErrors,
  type TypeBoxValidationError,
} from "@openclaw/normalization-core/json-schema";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
// Compiles plugin manifest schemas for validation without runtime loading.
import { Format } from "typebox/format";
import { Compile, type Validator as TypeBoxValidator } from "typebox/schema";
import { Settings } from "typebox/system";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { appendAllowedValuesHint, summarizeAllowedValues } from "../config/allowed-values.js";
import {
  isRuntimeConfigUnknownPath,
  omitRuntimeConfigPaths,
} from "../config/validation-runtime.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  applyJsonSchemaDefaults,
  findJsonSchemaShapeError,
} from "../shared/json-schema-defaults.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { PluginLruCache } from "./plugin-lru-cache.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type CachedValidator = {
  hasDefaults: boolean;
  validate: TypeBoxValidator;
  schema: JsonSchemaValue;
  schemaFingerprint: string;
};

/**
 * JSON Schema document accepted by plugin config and SDK runtime validation.
 * Boolean schemas are valid draft-style schemas and must remain accepted here.
 */
export type JsonSchemaValue = JsonSchemaObject | boolean;

const schemaCache = new PluginLruCache<CachedValidator>(512);
const annotationOnlyFormats = [
  "date-time",
  "date",
  "duration",
  "email",
  "hostname",
  "idn-email",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "iri-reference",
  "iri",
  "json-pointer-uri-fragment",
  "json-pointer",
  "regex",
  "relative-json-pointer",
  "time",
  "uri-reference",
  "uri-template",
  "url",
  "uuid",
] as const;

function fingerprintSchema(schema: JsonSchemaValue): string {
  return JSON.stringify(schema);
}

function schemaHasDefaults(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") {
    return false;
  }
  if (Array.isArray(schema)) {
    return schema.some((item) => schemaHasDefaults(item));
  }
  const record = schema as Record<string, unknown>;
  if (Object.hasOwn(record, "default")) {
    return true;
  }
  return Object.values(record).some((value) => schemaHasDefaults(value));
}

// Transfer only defaults selected by the source; re-evaluating branches on resolved
// strings changes their meaning. Never restore a reference removed by runtime isolation.
function applyValidatedSourceDefaults(
  value: unknown,
  source: unknown,
  defaulted: unknown,
): unknown {
  if (source === undefined) {
    return value === undefined ? defaulted : value;
  }
  const target = asOptionalObjectRecord(value);
  const original = asOptionalObjectRecord(source);
  const hydrated = asOptionalObjectRecord(defaulted);
  if (target && original && hydrated) {
    for (const [key, entry] of Object.entries(hydrated)) {
      if (
        !isBlockedObjectKey(key) &&
        (Object.hasOwn(target, key) || !Object.hasOwn(original, key))
      ) {
        target[key] = applyValidatedSourceDefaults(target[key], original[key], entry);
      }
    }
  }
  return value;
}

function compileSchema(schema: JsonSchemaValue): TypeBoxValidator {
  return withPluginFormatSemantics(() => Compile(normalizeJsonSchemaForTypeBox(schema) as never));
}

function relaxConditionalRequiredKeywords(
  schema: JsonSchemaValue,
  insideConditionalBranch = false,
): JsonSchemaValue {
  if (Array.isArray(schema)) {
    return schema.map((entry) =>
      relaxConditionalRequiredKeywords(entry as JsonSchemaValue, insideConditionalBranch),
    ) as never;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !(insideConditionalBranch && key === "required"))
      .map(([key, value]) => [
        key,
        typeof value === "boolean" || (value && typeof value === "object")
          ? relaxConditionalRequiredKeywords(
              value as JsonSchemaValue,
              insideConditionalBranch || key === "then" || key === "else",
            )
          : value,
      ]),
  ) as JsonSchemaValue;
}

function withPluginFormatSemantics<T>(callback: () => T): T {
  const previousFormats = Format.Entries();
  // Compiled checks capture format functions; interpreted errors read the global registry.
  // Scope both paths without changing other TypeBox consumers.
  Format.Set("uri", (value) => URL.canParse(value));
  for (const format of annotationOnlyFormats) {
    Format.Set(format, () => true);
  }
  try {
    return callback();
  } finally {
    Format.Clear();
    for (const [format, check] of previousFormats) {
      Format.Set(format, check);
    }
  }
}

function countValidationInputNodes(value: unknown): number {
  const pending = [value];
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    count += 1;
    if (current === null || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const entry of Object.values(current)) {
      pending.push(entry);
    }
  }
  return count;
}

function checkSchemaWithCurrentFormats(
  validate: TypeBoxValidator,
  value: unknown,
  runtimePreparation = false,
): { errors: TypeBoxValidationError[] | null; complete: boolean } {
  if (validate.Check(value)) {
    return { errors: null, complete: true };
  }
  const previousLimit = Settings.Get().maxErrors;
  // Recovery needs the whole failing batch, not TypeBox's eight-error display
  // window. Bound collection by input size; complex/truncated batches stay invalid.
  const limit = runtimePreparation
    ? Math.max(previousLimit, (countValidationInputNodes(value) + 1) * 8)
    : previousLimit;
  try {
    if (runtimePreparation) {
      Settings.Set({ maxErrors: limit });
    }
    const errors = validate.Errors(value)[1];
    return {
      errors: normalizeTypeBoxValidationErrors(errors),
      complete: errors.length < limit,
    };
  } finally {
    if (runtimePreparation) {
      Settings.Set({ maxErrors: previousLimit });
    }
  }
}

function isDefaultActivatedConditionalFailure(params: {
  schema: JsonSchemaValue;
  validate: TypeBoxValidator;
  originalValue: unknown;
  defaultedValue: unknown;
}): boolean {
  const relaxedConditionalValidator = compileSchema(
    relaxConditionalRequiredKeywords(params.schema),
  );
  if (checkSchemaWithCurrentFormats(relaxedConditionalValidator, params.defaultedValue).errors) {
    return false;
  }
  return checkSchemaWithCurrentFormats(params.validate, params.originalValue).errors === null;
}

/**
 * Sanitized validation error surfaced to config diagnostics, gateway hooks, and SDK callers.
 * `path`/`message` stay raw for programmatic handling; `text` is terminal-safe display text.
 */
export type JsonSchemaValidationError = {
  path: string;
  message: string;
  text: string;
  additionalProperty?: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};

export function parseJsonSchemaIssuePath(
  path: JsonSchemaValidationError["path"],
): Array<string | number> {
  if (!path || path === "<root>") {
    return [];
  }
  return path.split(".").map((segment) => parseConfigPathArrayIndex(segment) ?? segment);
}

function normalizeErrorPath(instancePath: string | undefined): string {
  const path = instancePath?.replace(/^\//, "").replace(/\//g, ".");
  return path && path.length > 0 ? path : "<root>";
}

function appendPathSegment(path: string, segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) {
    return path;
  }
  if (path === "<root>") {
    return trimmed;
  }
  return `${path}.${trimmed}`;
}

function firstStringParam(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value.find(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
    return first ?? null;
  }
  return null;
}

function resolveMissingProperties(error: TypeBoxValidationError): string[] {
  const properties =
    error.keyword === "required"
      ? error.params?.requiredProperties
      : error.keyword === "dependentRequired" || error.keyword === "dependencies"
        ? error.params?.dependencies
        : undefined;
  // Dependency lists include present fields. Only a failed single-key condition
  // identifies a missing property; larger conditions retain their native message.
  if (!Array.isArray(properties) || (error.keyword !== "required" && properties.length !== 1)) {
    return [];
  }
  return properties.filter((property): property is string => typeof property === "string");
}

function extractAllowedValues(error: TypeBoxValidationError): unknown[] | null {
  if (error.keyword === "enum") {
    const allowedValues = error.params?.allowedValues;
    return Array.isArray(allowedValues) ? allowedValues : null;
  }

  if (error.keyword === "const") {
    const params = error.params;
    if (!params || !Object.hasOwn(params, "allowedValue")) {
      return null;
    }
    return [params.allowedValue];
  }

  return null;
}

function getAllowedValuesSummary(
  error: TypeBoxValidationError,
): ReturnType<typeof summarizeAllowedValues> {
  const allowedValues = extractAllowedValues(error);
  if (!allowedValues) {
    return null;
  }
  return summarizeAllowedValues(allowedValues);
}

function resolveAdditionalProperty(error: TypeBoxValidationError): string | undefined {
  if (error.keyword !== "additionalProperties") {
    return undefined;
  }
  return firstStringParam(error.params?.additionalProperty) ?? undefined;
}

function resolveAdditionalProperties(error: TypeBoxValidationError): string[] {
  if (error.keyword !== "additionalProperties") {
    return [];
  }
  const additionalProperties = error.params?.additionalProperties;
  if (Array.isArray(additionalProperties)) {
    return additionalProperties.filter((entry): entry is string => typeof entry === "string");
  }
  const additionalProperty = error.params?.additionalProperty;
  return typeof additionalProperty === "string" ? [additionalProperty] : [];
}

function formatAdditionalPropertiesMessage(error: TypeBoxValidationError): string | null {
  const additionalProperties = resolveAdditionalProperties(error);
  if (additionalProperties.length === 0) {
    return null;
  }
  const quoted = additionalProperties.map((entry) => `"${entry}"`).join(", ");
  return `must not have additional properties: ${quoted}`;
}

function formatValidationErrors(
  errors: TypeBoxValidationError[] | null | undefined,
): JsonSchemaValidationError[] {
  if (!errors || errors.length === 0) {
    return [{ path: "<root>", message: "invalid config", text: "<root>: invalid config" }];
  }
  const seenDependencyConditions = new Set<string>();
  return errors.flatMap((error) => {
    if (error.keyword === "dependentRequired" || error.keyword === "dependencies") {
      // TypeBox can repeat the same dependency condition once per absent member.
      const condition = JSON.stringify([
        error.keyword,
        error.schemaPath,
        error.instancePath,
        error.params?.property,
        error.params?.dependencies,
      ]);
      if (seenDependencyConditions.has(condition)) {
        return [];
      }
      seenDependencyConditions.add(condition);
    }
    const missingProperties = resolveMissingProperties(error);
    const allowedValuesSummary = getAllowedValuesSummary(error);
    const additionalProperty = resolveAdditionalProperty(error);
    return (missingProperties.length ? missingProperties : [undefined]).map((missingProperty) => {
      const basePath = normalizeErrorPath(error.instancePath);
      const path =
        missingProperty === undefined ? basePath : appendPathSegment(basePath, missingProperty);
      const baseMessage =
        missingProperty === undefined
          ? (formatAdditionalPropertiesMessage(error) ?? error.message ?? "invalid")
          : `must have required property '${missingProperty}'`;
      const message = allowedValuesSummary
        ? appendAllowedValuesHint(baseMessage, allowedValuesSummary)
        : baseMessage;
      const safePath = sanitizeTerminalText(path);
      const safeMessage = sanitizeTerminalText(message);
      const formattedError: JsonSchemaValidationError = {
        path,
        message,
        text: `${safePath}: ${safeMessage}`,
      };
      if (additionalProperty) {
        formattedError.additionalProperty = additionalProperty;
      }
      if (allowedValuesSummary) {
        formattedError.allowedValues = allowedValuesSummary.values;
        formattedError.allowedValuesHiddenCount = allowedValuesSummary.hiddenCount;
      }
      return formattedError;
    });
  });
}

// TypeBox emits raw keys in instance paths, not escaped JSON pointers. Resolve
// against actual own keys and refuse ambiguous paths rather than deleting a sibling.
function resolveTypeBoxInstancePath(value: unknown, path: string): (string | number)[] | undefined {
  const matches: (string | number)[][] = [];
  const visit = (current: unknown, remaining: string, segments: (string | number)[]): void => {
    if (matches.length > 1) {
      return;
    }
    if (remaining === "") {
      matches.push(segments);
      return;
    }
    if (current === null || typeof current !== "object") {
      return;
    }
    // Test possible raw path segments rather than scanning every map entry for
    // every error. Slash-containing keys still participate in ambiguity checks.
    let end = remaining.indexOf("/", 1);
    for (;;) {
      const key = remaining.slice(1, end < 0 ? undefined : end);
      if (Object.hasOwn(current, key)) {
        visit(Reflect.get(current, key), end < 0 ? "" : remaining.slice(end), [
          ...segments,
          Array.isArray(current) ? Number(key) : key,
        ]);
      }
      if (end < 0) {
        break;
      }
      end = remaining.indexOf("/", end + 1);
    }
  };
  visit(value, path, []);
  return matches.length === 1 ? matches[0] : undefined;
}

// Schema-map entry names belong to the schema vocabulary, not to user record IDs.
const schemaMapKeywords = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
]);

const semanticSchemaKeywords = [
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
  "contains",
  "prefixItems",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

function runtimeSchemaPropertyNames(
  schema: unknown,
  path: readonly (string | number)[],
): string[] | undefined {
  const names: string[] = [];
  let current = schema;
  for (let index = 0; index <= path.length; index += 1) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    // Other branches can declare or depend on a property rejected here. Removing
    // it can satisfy the schema by changing its meaning, even when revalidation passes.
    if (semanticSchemaKeywords.some((keyword) => Object.hasOwn(current, keyword))) {
      return undefined;
    }
    const patterns = asOptionalObjectRecord(Reflect.get(current, "patternProperties"));
    const properties = asOptionalObjectRecord(Reflect.get(current, "properties"));
    // One pattern with no named properties is a record. Multiple independently
    // applied shapes can disagree about whether a member's property is declared.
    if (
      patterns &&
      (Object.keys(patterns).length > 1 || (properties && Object.keys(properties).length > 0))
    ) {
      return undefined;
    }
    if (index === path.length) {
      return names;
    }
    const keyword = path[index];
    if (keyword === undefined) {
      return undefined;
    }
    current = Reflect.get(current, keyword);
    if (typeof keyword !== "string" || !schemaMapKeywords.has(keyword)) {
      continue;
    }
    const name = path[++index];
    if (current === null || typeof current !== "object" || name === undefined) {
      return undefined;
    }
    current = Reflect.get(current, name);
    if (keyword === "properties" && typeof name === "string") {
      names.push(name);
    }
  }
  return names;
}

/**
 * Result of validating manifest-sourced input. `schemaError` on the failure branch tells
 * callers whether the schema itself is unusable (true) versus the value failing a
 * well-formed schema's constraints (false) — callers that report "config missing" vs.
 * "config invalid" need this to avoid telling an operator to fill in config that no
 * value could ever satisfy.
 */
type PluginSchemaValidationResult =
  | { ok: true; value: unknown; ignoredPaths?: (string | number)[][] }
  | { ok: false; errors: JsonSchemaValidationError[]; schemaError: boolean };

/**
 * Validate a value against a schema supplied by a plugin manifest.
 * External manifest schemas are third-party input, so every failure mode becomes
 * a validation result. Bundled schemas stay on the throwing path because a malformed
 * repository-owned schema is a programming error and must stay loud.
 */
export function validatePluginSchemaValue(
  params: Parameters<typeof validateJsonSchemaValue>[0] & {
    origin: PluginOrigin;
    ignoreUnknownProperties?: boolean;
  },
): PluginSchemaValidationResult {
  const { origin, ignoreUnknownProperties, ...validationParams } = params;
  if (origin === "bundled") {
    const result = validateJsonSchemaValueInternal(validationParams, ignoreUnknownProperties);
    return result.ok ? result : { ...result, schemaError: false };
  }
  try {
    const result = validateJsonSchemaValueInternal(validationParams, ignoreUnknownProperties);
    return result.ok ? result : { ...result, schemaError: false };
  } catch (error) {
    // The thrown text can embed raw manifest content (TypeBox echoes a bad regex
    // pattern), and callers log it, so it is sanitized like every other error path.
    const text = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
    return { ok: false, errors: [{ path: "<root>", message: text, text }], schemaError: true };
  }
}

/**
 * Validate a plugin-owned value against a JSON Schema, optionally hydrating schema defaults.
 * Callers can supply a stable cache key; otherwise the schema fingerprint owns cache identity.
 */
export function validateJsonSchemaValue(params: {
  schema: JsonSchemaValue;
  cacheKey?: string;
  value: unknown;
  /** Persisted input paired with this runtime value, before secret resolution. */
  sourceValue?: unknown;
  applyDefaults?: boolean;
  cache?: boolean;
}): { ok: true; value: unknown } | { ok: false; errors: JsonSchemaValidationError[] } {
  return validateJsonSchemaValueInternal(params);
}

function validateJsonSchemaValueInternal(
  params: Parameters<typeof validateJsonSchemaValue>[0],
  ignoreUnknownProperties = false,
):
  | { ok: true; value: unknown; ignoredPaths?: (string | number)[][] }
  | { ok: false; errors: JsonSchemaValidationError[] } {
  const schemaKey = params.cacheKey ?? fingerprintSchema(params.schema);
  const cacheKey = params.applyDefaults ? `${schemaKey}::defaults` : schemaKey;
  let cached = params.cache === false ? undefined : schemaCache.get(cacheKey);
  if (!cached || cached.schema !== params.schema) {
    const schemaError = findJsonSchemaShapeError(params.schema);
    if (schemaError) {
      throw new Error(sanitizeTerminalText(`invalid schema: ${schemaError}`));
    }
  }
  const schemaFingerprint =
    !cached || cached.schema !== params.schema ? fingerprintSchema(params.schema) : undefined;
  if (
    !cached ||
    (cached.schema !== params.schema && cached.schemaFingerprint !== schemaFingerprint)
  ) {
    const validate = compileSchema(params.schema);
    cached = {
      hasDefaults: params.applyDefaults ? schemaHasDefaults(params.schema) : false,
      validate,
      schema: params.schema,
      schemaFingerprint: schemaFingerprint ?? fingerprintSchema(params.schema),
    };
    if (params.cache !== false) {
      schemaCache.set(cacheKey, cached);
    }
  } else if (cached.schema !== params.schema) {
    cached.schema = params.schema;
  }

  return withPluginFormatSemantics(() => {
    const originalValue = params.sourceValue === undefined ? params.value : params.sourceValue;
    let value =
      params.applyDefaults && cached.hasDefaults
        ? applyJsonSchemaDefaults(params.schema, structuredClone(originalValue))
        : originalValue;
    let ignoredPaths: (string | number)[][] = [];
    const checked = checkSchemaWithCurrentFormats(cached.validate, value, ignoreUnknownProperties);
    let errors = checked.errors;
    if (
      ignoreUnknownProperties &&
      checked.complete &&
      params.sourceValue === undefined &&
      errors?.length &&
      errors.every((error) => error.keyword === "additionalProperties")
    ) {
      // Do not reinterpret union/conditional/required failures as harmless extras.
      const schema = normalizeJsonSchemaForTypeBox(cached.schema);
      const paths = errors.flatMap((error) => {
        const schemaPath = resolveTypeBoxInstancePath(schema, (error.schemaPath ?? "#").slice(1));
        const propertyNames = schemaPath && runtimeSchemaPropertyNames(schema, schemaPath);
        const owner = schemaPath?.reduce<unknown>(
          (current, key) =>
            current !== null && typeof current === "object" ? Reflect.get(current, key) : undefined,
          schema,
        );
        // A schema-valued additionalProperties reports failing record entries too.
        // Only false marks extras; never omit an entire configured owner as recovery.
        if (
          !schemaPath ||
          !propertyNames ||
          asOptionalObjectRecord(owner)?.additionalProperties !== false ||
          !isRuntimeConfigUnknownPath(propertyNames)
        ) {
          return [];
        }
        const parent = resolveTypeBoxInstancePath(value, error.instancePath ?? "");
        return parent ? resolveAdditionalProperties(error).map((key) => parent.concat(key)) : [];
      });
      if (paths.length > 0) {
        ignoredPaths = paths;
        const projected = omitRuntimeConfigPaths(originalValue, paths);
        value =
          params.applyDefaults && cached.hasDefaults
            ? applyJsonSchemaDefaults(params.schema, projected)
            : projected;
        errors = checkSchemaWithCurrentFormats(cached.validate, value).errors;
      }
    }
    // Defaults may activate a required-only conditional failure in otherwise valid source.
    if (
      errors &&
      !(
        params.applyDefaults &&
        value !== originalValue &&
        isDefaultActivatedConditionalFailure({
          schema: params.schema,
          validate: cached.validate,
          originalValue,
          defaultedValue: value,
        })
      )
    ) {
      return { ok: false, errors: formatValidationErrors(errors) };
    }
    if (originalValue === params.value) {
      return { ok: true, value, ...(ignoredPaths.length ? { ignoredPaths } : {}) };
    }
    return {
      ok: true,
      value:
        value === originalValue
          ? params.value
          : applyValidatedSourceDefaults(structuredClone(params.value), originalValue, value),
    };
  });
}
