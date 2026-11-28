import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const SCHEMA_ANNOTATION_KEYS = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "example",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

/** Keeps only the keys that document a property, dropping every constraint. */
export function schemaAnnotationsOnly(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => SCHEMA_ANNOTATION_KEYS.has(key)),
  );
}

/** Const and enum constrain the same value, so retain their intersection. */
export function readLiteralSchemaValues(schema: Record<string, unknown>): unknown[] | undefined {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (Object.hasOwn(schema, "const")) {
    if (!enumValues) {
      return [schema.const];
    }
    return enumValues.some((value) => isDeepStrictEqual(value, schema.const)) ? [schema.const] : [];
  }
  return enumValues;
}

function readLiteralValidationConstraints(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).filter(
      ([key]) => key !== "const" && key !== "enum" && !SCHEMA_ANNOTATION_KEYS.has(key),
    ),
  );
}

/** TypeBox emits a union of literals as anyOf; pool its members like one literal schema. */
function collapseLiteralUnion(schema: Record<string, unknown>): Record<string, unknown> {
  const { anyOf, ...annotations } = schema;
  if (
    !Array.isArray(anyOf) ||
    Object.keys(annotations).some((key) => !SCHEMA_ANNOTATION_KEYS.has(key))
  ) {
    return schema;
  }
  let pooled: Record<string, unknown> | undefined;
  for (const variant of anyOf) {
    if (!isRecord(variant) || readLiteralSchemaValues(variant) === undefined) {
      return schema;
    }
    pooled = pooled ? mergeLiteralSchemas(pooled, variant) : variant;
    if (!pooled) {
      return schema;
    }
  }
  return pooled ? { ...pooled, ...annotations } : schema;
}

/** Pools property literals only when every non-annotation constraint agrees. */
export function mergeLiteralSchemas(
  existingSchema: Record<string, unknown>,
  incomingSchema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const existing = collapseLiteralUnion(existingSchema);
  const incoming = collapseLiteralUnion(incomingSchema);
  const existingValues = readLiteralSchemaValues(existing);
  const incomingValues = readLiteralSchemaValues(incoming);
  if (existingValues === undefined || incomingValues === undefined) {
    return undefined;
  }
  const existingConstraints = readLiteralValidationConstraints(existing);
  const incomingConstraints = readLiteralValidationConstraints(incoming);
  if (!isDeepStrictEqual(existingConstraints, incomingConstraints)) {
    return undefined;
  }
  const combined = [...existingValues, ...incomingValues];
  const values = combined.filter(
    (value, index) =>
      combined.findIndex((candidate) => isDeepStrictEqual(candidate, value)) === index,
  );
  if (values.length === 0) {
    return undefined;
  }
  const merged: Record<string, unknown> = { ...existing, enum: values };
  delete merged.const;
  return merged;
}
