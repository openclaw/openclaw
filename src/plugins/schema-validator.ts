import { Compile, type Validator as TypeBoxValidator } from "typebox/compile";
import { Format } from "typebox/format";
import { appendAllowedValuesHint, summarizeAllowedValues } from "../config/allowed-values.js";
import {
  applyJsonSchemaDefaults,
  findJsonSchemaShapeError,
  normalizeJsonSchemaForTypeBox,
} from "../shared/json-schema-defaults.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { PluginLruCache } from "./plugin-cache-primitives.js";

type TypeBoxValidationError = {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  params?: Record<string, unknown>;
  message?: string;
};

type CachedValidator = {
  hasDefaults: boolean;
  validate: TypeBoxValidator;
  schema: JsonSchemaValue;
  schemaFingerprint: string;
};

export type JsonSchemaValue = JsonSchemaObject | boolean;

const schemaCache = new PluginLruCache<CachedValidator>(512);

for (const format of [
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
]) {
  Format.Set(format, () => true);
}
Format.Set("uri", (value) => URL.canParse(value));

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
  if (Object.prototype.hasOwnProperty.call(record, "default")) {
    return true;
  }
  return Object.values(record).some((value) => schemaHasDefaults(value));
}

function cloneValidationValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return structuredClone(value);
}

function compileSchema(schema: JsonSchemaValue): TypeBoxValidator {
  return Compile(normalizeJsonSchemaForTypeBox(schema) as never);
}

function checkSchema(validate: TypeBoxValidator, value: unknown): TypeBoxValidationError[] | null {
  if (validate.Check(value)) {
    return null;
  }
  return [...validate.Errors(value)] as TypeBoxValidationError[];
}

function isDefaultConditionalBranchFlip(
  validate: TypeBoxValidator,
  originalValue: unknown,
  errors: TypeBoxValidationError[],
): boolean {
  const hasOnlyBranchFlipErrors = errors.every((error) => {
    if (error.keyword === "if") {
      return true;
    }
    return (
      error.keyword === "required" &&
      typeof error.schemaPath === "string" &&
      /^#\/(?:then|else)(?:\/|$)/.test(error.schemaPath)
    );
  });
  return (
    hasOnlyBranchFlipErrors &&
    errors.some((error) => error.keyword === "if") &&
    checkSchema(validate, originalValue) === null
  );
}

function checkDefaultedSchema(
  validate: TypeBoxValidator,
  originalValue: unknown,
  value: unknown,
): TypeBoxValidationError[] | null {
  const errors = checkSchema(validate, value);
  if (!errors) {
    return null;
  }
  return isDefaultConditionalBranchFlip(validate, originalValue, errors) ? null : errors;
}

export type JsonSchemaValidationError = {
  path: string;
  message: string;
  text: string;
  additionalProperty?: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};

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

function resolveMissingProperty(error: TypeBoxValidationError): string | null {
  if (
    error.keyword !== "required" &&
    error.keyword !== "dependentRequired" &&
    error.keyword !== "dependencies"
  ) {
    return null;
  }
  return (
    firstStringParam(error.params?.missingProperty) ??
    firstStringParam(error.params?.requiredProperties) ??
    firstStringParam(error.params?.dependencies)
  );
}

function resolveValidationErrorPath(error: TypeBoxValidationError): string {
  const basePath = normalizeErrorPath(error.instancePath);
  const missingProperty = resolveMissingProperty(error);
  if (!missingProperty) {
    return basePath;
  }
  return appendPathSegment(basePath, missingProperty);
}

function extractAllowedValues(error: TypeBoxValidationError): unknown[] | null {
  if (error.keyword === "enum") {
    const allowedValues = error.params?.allowedValues;
    return Array.isArray(allowedValues) ? allowedValues : null;
  }

  if (error.keyword === "const") {
    const params = error.params;
    if (!params || !Object.prototype.hasOwnProperty.call(params, "allowedValue")) {
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
  return (
    firstStringParam(error.params?.additionalProperty) ??
    firstStringParam(error.params?.additionalProperties) ??
    undefined
  );
}

function formatValidationErrors(
  errors: TypeBoxValidationError[] | null | undefined,
): JsonSchemaValidationError[] {
  if (!errors || errors.length === 0) {
    return [{ path: "<root>", message: "invalid config", text: "<root>: invalid config" }];
  }
  return errors.map((error) => {
    const path = resolveValidationErrorPath(error);
    const baseMessage = error.message ?? "invalid";
    const allowedValuesSummary = getAllowedValuesSummary(error);
    const additionalProperty = resolveAdditionalProperty(error);
    const message = allowedValuesSummary
      ? appendAllowedValuesHint(baseMessage, allowedValuesSummary)
      : baseMessage;
    const safePath = sanitizeTerminalText(path);
    const safeMessage = sanitizeTerminalText(message);
    return {
      path,
      message,
      text: `${safePath}: ${safeMessage}`,
      ...(additionalProperty ? { additionalProperty } : {}),
      ...(allowedValuesSummary
        ? {
            allowedValues: allowedValuesSummary.values,
            allowedValuesHiddenCount: allowedValuesSummary.hiddenCount,
          }
        : {}),
    };
  });
}

export function validateJsonSchemaValue(params: {
  schema: JsonSchemaValue;
  cacheKey: string;
  value: unknown;
  applyDefaults?: boolean;
  cache?: boolean;
}): { ok: true; value: unknown } | { ok: false; errors: JsonSchemaValidationError[] } {
  const schemaError = findJsonSchemaShapeError(params.schema);
  if (schemaError) {
    throw new Error(sanitizeTerminalText(`invalid schema: ${schemaError}`));
  }

  const useCache = params.cache !== false;
  if (!useCache) {
    const validate = compileSchema(params.schema);
    const value =
      params.applyDefaults && schemaHasDefaults(params.schema)
        ? applyJsonSchemaDefaults(params.schema, cloneValidationValue(params.value))
        : params.value;
    const errors =
      params.applyDefaults && schemaHasDefaults(params.schema)
        ? checkDefaultedSchema(validate, params.value, value)
        : checkSchema(validate, value);
    if (!errors) {
      return { ok: true, value };
    }
    return { ok: false, errors: formatValidationErrors(errors) };
  }

  const cacheKey = params.applyDefaults ? `${params.cacheKey}::defaults` : params.cacheKey;
  let cached = schemaCache.get(cacheKey);
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
    schemaCache.set(cacheKey, cached);
  } else if (cached.schema !== params.schema) {
    cached.schema = params.schema;
  }

  const value =
    params.applyDefaults && cached.hasDefaults
      ? applyJsonSchemaDefaults(params.schema, cloneValidationValue(params.value))
      : params.value;
  const errors =
    params.applyDefaults && cached.hasDefaults
      ? checkDefaultedSchema(cached.validate, params.value, value)
      : checkSchema(cached.validate, value);
  if (!errors) {
    return { ok: true, value };
  }
  return { ok: false, errors: formatValidationErrors(errors) };
}
