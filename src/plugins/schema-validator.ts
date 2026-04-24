import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import {
  appendAllowedValuesHint,
  summarizeAllowedValues,
} from "../config/allowed-values.js";
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
  addMetaSchema: (schema: object, key?: string) => AjvLike;
  getSchema: (keyRef: string) => ValidateFunction | undefined;
};
const ajvSingletons = new Map<"default" | "defaults", AjvLike>();

function getAjv(mode: "default" | "defaults"): AjvLike {
  const cached = ajvSingletons.get(mode);
  if (cached) {
    return cached;
  }
  // Use `ajv/dist/2020` so draft-2020-12 tool schemas from newer MCP servers
  // (e.g. Playwright MCP >= 1.53, which emits `$schema:
  // https://json-schema.org/draft/2020-12/schema`) compile instead of throwing
  // `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`.
  // The 2020 entrypoint registers draft-2020-12 but does not include draft-07
  // by default, so we add the older meta-schemas back for tool authors who
  // still emit draft-07 / draft-06 `$schema` values.
  const ajvModule = require("ajv/dist/2020") as {
    default?: new (opts?: object) => AjvLike;
  };
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
  registerLegacyMetaSchemas(instance);
  ajvSingletons.set(mode, instance);
  return instance;
}

// draft-07 / draft-06 meta-schemas ship with ajv but are *not* auto-registered
// on the `ajv/dist/2020` entrypoint. Register them here so tool schemas that
// still declare `$schema: "http://json-schema.org/draft-07/schema#"` (a very
// common case for older MCP servers and handwritten plugin schemas) continue
// to validate without changes. addMetaSchema is idempotent — we guard with
// getSchema so re-runs across multiple Ajv instances don't throw "schema with
// key or id already exists".
function registerLegacyMetaSchemas(instance: AjvLike): void {
  for (const path of [
    "ajv/dist/refs/json-schema-draft-07.json",
    "ajv/dist/refs/json-schema-draft-06.json",
  ]) {
    try {
      const meta = require(path) as { $id?: string; id?: string };
      const key = meta.$id ?? meta.id;
      if (key && !instance.getSchema(key)) {
        instance.addMetaSchema(meta);
      }
    } catch {
      // Meta schema not present in this ajv install — fine; 2020 tools still work.
    }
  }
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
  const missingProperty = (error.params as { missingProperty?: unknown })
    .missingProperty;
  return typeof missingProperty === "string" && missingProperty.trim()
    ? missingProperty
    : null;
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
    const allowedValues = (error.params as { allowedValues?: unknown })
      .allowedValues;
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

function getAjvAllowedValuesSummary(
  error: ErrorObject,
): ReturnType<typeof summarizeAllowedValues> {
  const allowedValues = extractAllowedValues(error);
  if (!allowedValues) {
    return null;
  }
  return summarizeAllowedValues(allowedValues);
}

function formatAjvErrors(
  errors: ErrorObject[] | null | undefined,
): JsonSchemaValidationError[] {
  if (!errors || errors.length === 0) {
    return [
      {
        path: "<root>",
        message: "invalid config",
        text: "<root>: invalid config",
      },
    ];
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
}):
  | { ok: true; value: unknown }
  | { ok: false; errors: JsonSchemaValidationError[] } {
  const cacheKey = params.applyDefaults
    ? `${params.cacheKey}::defaults`
    : params.cacheKey;
  let cached = schemaCache.get(cacheKey);
  if (!cached || cached.schema !== params.schema) {
    const validate = getAjv(
      params.applyDefaults ? "defaults" : "default",
    ).compile(params.schema);
    cached = { validate, schema: params.schema };
    schemaCache.set(cacheKey, cached);
  }

  const value = params.applyDefaults
    ? cloneValidationValue(params.value)
    : params.value;
  const ok = cached.validate(value);
  if (ok) {
    return { ok: true, value };
  }
  return { ok: false, errors: formatAjvErrors(cached.validate.errors) };
}
