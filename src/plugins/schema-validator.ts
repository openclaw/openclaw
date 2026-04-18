import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import { appendAllowedValuesHint, summarizeAllowedValues } from "../config/allowed-values.js";
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
  compile: (schema: Record<string, unknown>) => ValidateFunction;
};

type AjvDialect = "draft-07" | "2020";
type AjvMode = "default" | "defaults";

// Per-draft dispatch: route explicitly draft-07/06/04-tagged schemas to the
// default Ajv class, which supports tuple-form `items: [schema, ...]` and
// `additionalItems`. The MCP TypeScript SDK ships these by default — it wraps
// `zod-to-json-schema` with no target option, so `z.tuple(...)` emits tuple
// items and the output is tagged `$schema: draft-07`. Unlabeled schemas go to
// Ajv2020: pydantic v2 omits `$schema` but uses 2020-12 semantics (`prefixItems`,
// `unevaluatedProperties`, `$dynamicRef`), and routing those through a draft-07
// Ajv silently drops the 2020-12-only keywords under `strict: false` — the exact
// bug class this PR fixes. Explicit 2020-12 tags also go to Ajv2020.
const DRAFT_07_SCHEMA_URIS: readonly string[] = [
  "http://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-06/schema",
  "http://json-schema.org/draft-04/schema",
];

function detectAjvDialect(schema: Record<string, unknown>): AjvDialect {
  const schemaUri = typeof schema.$schema === "string" ? schema.$schema : "";
  for (const draft07Uri of DRAFT_07_SCHEMA_URIS) {
    if (schemaUri.startsWith(draft07Uri)) {
      return "draft-07";
    }
  }
  return "2020";
}

const ajvSingletons = new Map<string, AjvLike>();

function getAjv(dialect: AjvDialect, mode: AjvMode): AjvLike {
  const cacheKey = `${dialect}::${mode}`;
  const cached = ajvSingletons.get(cacheKey);
  if (cached) {
    return cached;
  }
  const modulePath = dialect === "2020" ? "ajv/dist/2020.js" : "ajv";
  const ajvModule = require(modulePath) as { default?: new (opts?: object) => AjvLike };
  const AjvCtor =
    typeof ajvModule.default === "function"
      ? ajvModule.default
      : (ajvModule as unknown as new (opts?: object) => AjvLike);
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
  ajvSingletons.set(cacheKey, instance);
  return instance;
}

type CachedValidator = {
  validate: ValidateFunction;
  schema: Record<string, unknown>;
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
  schema: Record<string, unknown>;
  cacheKey: string;
  value: unknown;
  applyDefaults?: boolean;
}): { ok: true; value: unknown } | { ok: false; errors: JsonSchemaValidationError[] } {
  const cacheKey = params.applyDefaults ? `${params.cacheKey}::defaults` : params.cacheKey;
  let cached = schemaCache.get(cacheKey);
  if (!cached || cached.schema !== params.schema) {
    const dialect = detectAjvDialect(params.schema);
    const mode: AjvMode = params.applyDefaults ? "defaults" : "default";
    const validate = getAjv(dialect, mode).compile(params.schema);
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
