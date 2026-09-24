import { isDeepStrictEqual } from "node:util";
import { validatePluginSchemaValue } from "../plugins/schema-validator.js";

type SchemaValidationParams = Parameters<typeof validatePluginSchemaValue>[0] & {
  cacheKey: string;
};
type SchemaValidationResult = ReturnType<typeof validatePluginSchemaValue>;

export type PreparedPluginSchemaValidations = Map<
  string,
  {
    schema: SchemaValidationParams["schema"];
    origin: SchemaValidationParams["origin"];
    ignoreUnknownProperties: SchemaValidationParams["ignoreUnknownProperties"];
    input: unknown;
    result: SchemaValidationResult;
  }
>;

/** Raw and runtime documents share validation only when their actual schema inputs match. */
export function validatePreparedPluginSchemaValue(
  params: SchemaValidationParams,
  prepared?: PreparedPluginSchemaValidations,
): SchemaValidationResult {
  if (!prepared) {
    return validatePluginSchemaValue(params);
  }
  const previous = prepared.get(params.cacheKey);
  if (
    previous &&
    (previous.schema === params.schema || isDeepStrictEqual(previous.schema, params.schema)) &&
    previous.origin === params.origin &&
    (previous.ignoreUnknownProperties === params.ignoreUnknownProperties ||
      (previous.result.ok && !previous.result.ignoredPaths?.length)) &&
    isDeepStrictEqual(previous.input, params.value)
  ) {
    return structuredClone(previous.result);
  }
  const input = structuredClone(params.value);
  const result = validatePluginSchemaValue(params);
  prepared.set(params.cacheKey, {
    schema: params.schema,
    origin: params.origin,
    ignoreUnknownProperties: params.ignoreUnknownProperties,
    input,
    result: structuredClone(result),
  });
  return result;
}
