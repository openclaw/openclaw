import { isDeepStrictEqual } from "node:util";
import { LruCache } from "../infra/lru-cache.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validatePluginSchemaValue } from "../plugins/schema-validator.js";

type SchemaValidationParams = Pick<
  Parameters<typeof validatePluginSchemaValue>[0],
  "schema" | "origin" | "value" | "applyDefaults"
> & {
  cacheKey: string;
};
type SchemaValidationResult = ReturnType<typeof validatePluginSchemaValue>;

type PreparedPluginSchemaValidation = {
  schema: SchemaValidationParams["schema"];
  origin: SchemaValidationParams["origin"];
  input: unknown;
  applyDefaults: boolean;
  result: SchemaValidationResult;
};

// Registry replacement retires its results; each slot retains only its latest input.
const registryValidations = new WeakMap<
  PluginManifestRegistry,
  LruCache<PreparedPluginSchemaValidation>
>();

/** Reuse unchanged schema inputs across config revisions and raw/runtime documents. */
export function validatePreparedPluginSchemaValue(
  params: SchemaValidationParams,
  registry: PluginManifestRegistry,
): SchemaValidationResult {
  let prepared = registryValidations.get(registry);
  if (!prepared) {
    prepared = new LruCache(512);
    registryValidations.set(registry, prepared);
  }
  const previous = prepared.get(params.cacheKey);
  if (
    previous &&
    isDeepStrictEqual(previous.schema, params.schema) &&
    previous.origin === params.origin &&
    previous.applyDefaults === Boolean(params.applyDefaults) &&
    isDeepStrictEqual(previous.input, params.value)
  ) {
    return structuredClone(previous.result);
  }
  const input = structuredClone(params.value);
  const result = validatePluginSchemaValue(params);
  prepared.set(params.cacheKey, {
    schema: structuredClone(params.schema),
    origin: params.origin,
    input,
    applyDefaults: Boolean(params.applyDefaults),
    result: structuredClone(result),
  });
  return result;
}
