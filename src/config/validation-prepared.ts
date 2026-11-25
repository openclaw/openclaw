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

let registryValidations = new WeakMap<
  PluginManifestRegistry,
  LruCache<PreparedPluginSchemaValidation>
>();

export function preparePluginSchemaValidations(registry?: PluginManifestRegistry) {
  const previous = registry && registryValidations.get(registry);
  const next = new LruCache<PreparedPluginSchemaValidation>(512);
  return {
    previous,
    next,
    publish() {
      // Successful revisions retire removed slots; rejected candidates never retain settings.
      if (registry) {
        registryValidations.set(registry, next);
      } else {
        // An empty revision needs no metadata discovery to invalidate prior settings.
        registryValidations = new WeakMap();
      }
    },
  };
}

export type PreparedPluginSchemaValidations = ReturnType<typeof preparePluginSchemaValidations>;

/** Reuse unchanged schema inputs across config revisions and raw/runtime documents. */
export function validatePreparedPluginSchemaValue(
  params: SchemaValidationParams,
  prepared: PreparedPluginSchemaValidations,
): SchemaValidationResult {
  const previous = prepared.next.get(params.cacheKey) ?? prepared.previous?.peek(params.cacheKey);
  if (
    previous &&
    isDeepStrictEqual(previous.schema, params.schema) &&
    previous.origin === params.origin &&
    previous.applyDefaults === Boolean(params.applyDefaults) &&
    isDeepStrictEqual(previous.input, params.value)
  ) {
    prepared.next.set(params.cacheKey, previous);
    return structuredClone(previous.result);
  }
  const input = structuredClone(params.value);
  const result = validatePluginSchemaValue(params);
  prepared.next.set(params.cacheKey, {
    schema: structuredClone(params.schema),
    origin: params.origin,
    input,
    applyDefaults: Boolean(params.applyDefaults),
    result: structuredClone(result),
  });
  return result;
}
