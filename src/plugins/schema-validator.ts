import type { ErrorObject, ValidateFunction } from "ajv";
import { createRequire } from "node:module";
import { appendAllowedValuesHint, summarizeAllowedValues } from "../config/allowed-values.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";

const require = createRequire(import.meta.url);
type AjvLike = {
  compile: (schema: Record<string, unknown>) => ValidateFunction;
};
let ajvSingleton: AjvLike | null = null;

function getAjv(): AjvLike {
  if (ajvSingleton) {
    return ajvSingleton;
  }
  const ajvModule = require("ajv") as { default?: new (opts?: object) => AjvLike };
  const AjvCtor =
    typeof ajvModule.default === "function"
      ? ajvModule.default
      : (ajvModule as unknown as new (opts?: object) => AjvLike);
  ajvSingleton = new AjvCtor({
    allErrors: true,
    strict: false,
    removeAdditional: false,
  });
  return ajvSingleton;
}

type CachedValidator = {
  validate: ValidateFunction;
  schema: Record<string, unknown>;
};

const schemaCache = new Map<string, CachedValidator>();

export type JsonSchemaValidationError = {
  path: string;
  message: string;
  text: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};

function normalizeAjvPath(instancePath: string | undefined): string {
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

function resolveMissingProperty(error: ErrorObject): string | null {
  if (
    error.keyword !== "required" &&
    error.keyword !== "dependentRequired" &&
    error.keyword !== "dependencies"
  ) {
    return null;
  }
  const missingProperty = (error.params as { missingProperty?: unknown }).missingProperty;
  return typeof missingProperty === "string" && missingProperty.trim() ? missingProperty : null;
}

function resolveAjvErrorPath(error: ErrorObject): string {
  const basePath = normalizeAjvPath(error.instancePath);
  const missingProperty = resolveMissingProperty(error);
  if (!missingProperty) {
    return basePath;
  }
  return appendPathSegment(basePath, missingProperty);
}

function extractAllowedValues(error: ErrorObject): unknown[] | null {
  if (error.keyword === "enum") {
    const allowedValues = (error.params as { allowedValues?: unknown }).allowedValues;
    return Array.isArray(allowedValues) ? allowedValues : null;
  }

  if (error.keyword === "const") {
    const params = error.params as { allowedValue?: unknown };
    if (!Object.prototype.hasOwnProperty.call(params, "allowedValue")) {
      return null;
    }
    return [params.allowedValue];
  }

  return null;
}

function getAjvAllowedValuesSummary(error: ErrorObject): ReturnType<typeof summarizeAllowedValues> {
  const allowedValues = extractAllowedValues(error);
  if (!allowedValues) {
    return null;
  }
  return summarizeAllowedValues(allowedValues);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): JsonSchemaValidationError[] {
  if (!errors || errors.length === 0) {
    return [{ path: "<root>", message: "invalid config", text: "<root>: invalid config" }];
  }
  return errors.map((error) => {
    const path = resolveAjvErrorPath(error);
    const baseMessage = error.message ?? "invalid";
    const allowedValuesSummary = getAjvAllowedValuesSummary(error);
    const message = allowedValuesSummary
      ? appendAllowedValuesHint(baseMessage, allowedValuesSummary)
      : baseMessage;
    const safePath = sanitizeTerminalText(path);
    const safeMessage = sanitizeTerminalText(message);
    return {
      path,
      message,
      text: `${safePath}: ${safeMessage}`,
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
  schema: Record<string, unknown>;
  cacheKey: string;
  value: unknown;
}): { ok: true } | { ok: false; errors: JsonSchemaValidationError[] } {
  let cached = schemaCache.get(params.cacheKey);
  if (!cached || cached.schema !== params.schema) {
    const validate = getAjv().compile(params.schema);
    cached = { validate, schema: params.schema };
    schemaCache.set(params.cacheKey, cached);
  }

  const ok = cached.validate(params.value);
  if (ok) {
    return { ok: true };
  }
  return { ok: false, errors: formatAjvErrors(cached.validate.errors) };
}
