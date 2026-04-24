import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import { appendAllowedValuesHint, summarizeAllowedValues } from "../config/allowed-values.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";

const require = createRequire(import.meta.url);
type AjvLike = {
  addFormat: (
    name: string,
    format:
      | RegExp
      | {
          type?: string;
          validate: (value: string) => boolean;
        },
  ) => AjvLike;
  compile: (schema: JsonSchemaObject) => ValidateFunction;
};

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

type AjvMode = "default" | "defaults";
type AjvVariant = "draft07" | "draft2020";
type AjvSingletonKey = `${AjvMode}:${AjvVariant}`;

const ajvSingletons = new Map<AjvSingletonKey, AjvLike>();

function loadAjvCtor(variant: AjvVariant): new (opts?: object) => AjvLike {
  const mod =
    variant === "draft2020"
      ? (require("ajv/dist/2020") as { default?: new (opts?: object) => AjvLike })
      : (require("ajv") as { default?: new (opts?: object) => AjvLike });
  return typeof mod.default === "function"
    ? mod.default
    : (mod as unknown as new (opts?: object) => AjvLike);
}

function getAjv(mode: AjvMode, variant: AjvVariant = "draft07"): AjvLike {
  const key: AjvSingletonKey = `${mode}:${variant}`;
  const cached = ajvSingletons.get(key);
  if (cached) {
    return cached;
  }
  const AjvCtor = loadAjvCtor(variant);
  const instance = new AjvCtor({
    allErrors: true,
    strict: false,
    removeAdditional: false,
    ...(mode === "defaults" ? { useDefaults: true } : {}),
  });
  instance.addFormat("uri", {
    type: "string",
    validate: (value: string) => {
      // Accept absolute URIs so generated config schemas can keep JSON Schema
      // `format: "uri"` without noisy AJV warnings during validation/build.
      return URL.canParse(value);
    },
  });
  ajvSingletons.set(key, instance);
  return instance;
}

function resolveAjvVariant(schema: JsonSchemaObject): AjvVariant {
  return (schema as { $schema?: unknown }).$schema === DRAFT_2020_12 ? "draft2020" : "draft07";
}

type CachedValidator = {
  validate: ValidateFunction;
  schema: JsonSchemaObject;
};

const schemaCache = new Map<string, CachedValidator>();

function cloneValidationValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return structuredClone(value);
}

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
  schema: JsonSchemaObject;
  cacheKey: string;
  value: unknown;
  applyDefaults?: boolean;
}): { ok: true; value: unknown } | { ok: false; errors: JsonSchemaValidationError[] } {
  const cacheKey = params.applyDefaults ? `${params.cacheKey}::defaults` : params.cacheKey;
  let cached = schemaCache.get(cacheKey);
  if (!cached || cached.schema !== params.schema) {
    const mode: AjvMode = params.applyDefaults ? "defaults" : "default";
    const variant = resolveAjvVariant(params.schema);
    const validate = getAjv(mode, variant).compile(params.schema);
    cached = { validate, schema: params.schema };
    schemaCache.set(cacheKey, cached);
  }

  const value = params.applyDefaults ? cloneValidationValue(params.value) : params.value;
  const ok = cached.validate(value);
  if (ok) {
    return { ok: true, value };
  }
  return { ok: false, errors: formatAjvErrors(cached.validate.errors) };
}
