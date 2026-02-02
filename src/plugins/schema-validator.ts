import AjvPkg, { type ErrorObject, type ValidateFunction } from "ajv";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

type CachedValidator = {
  validate: ValidateFunction;
  schema: Record<string, unknown>;
};

/**
 * Maximum number of compiled validators to cache.
 * Each entry holds a compiled AJV validator (a few KB).  500 entries is
 * more than enough for any realistic plugin set while bounding memory.
 */
const MAX_SCHEMA_CACHE_SIZE = 500;

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
    // Evict the oldest entry when at capacity (FIFO via Map insertion order).
    if (!schemaCache.has(params.cacheKey) && schemaCache.size >= MAX_SCHEMA_CACHE_SIZE) {
      const oldest = schemaCache.keys().next().value as string | undefined;
      if (oldest) {
        schemaCache.delete(oldest);
      }
    }
    const validate = ajv.compile(params.schema);
    cached = { validate, schema: params.schema };
    schemaCache.set(params.cacheKey, cached);
  }

  const ok = cached.validate(params.value);
  if (ok) {
    return { ok: true };
  }
  return { ok: false, errors: formatAjvErrors(cached.validate.errors) };
}
