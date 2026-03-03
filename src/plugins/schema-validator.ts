import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";

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

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return ["invalid config"];
  }
  return errors.map((error) => {
    const path = error.instancePath?.replace(/^\//, "").replace(/\//g, ".") || "<root>";
    const message = error.message ?? "invalid";
    return `${path}: ${message}`;
  });
}

export function validateJsonSchemaValue(params: {
  schema: Record<string, unknown>;
  cacheKey: string;
  value: unknown;
}): { ok: true } | { ok: false; errors: string[] } {
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
