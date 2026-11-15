import { isRecord, isStringArray } from "@openclaw/normalization-core/record-coerce";

const schemaCombinatorKeywords = new Set(["allOf", "anyOf", "oneOf"]);
const jsonSchemaTypes = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const schemaStringKeywords = new Set([
  "$anchor",
  "$comment",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$schema",
  "$ref",
  "contentEncoding",
  "contentMediaType",
  "description",
  "format",
  "pattern",
  "title",
]);
const schemaNumberKeywords = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
  "multipleOf",
]);
const schemaIntegerKeywords = new Set([
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
]);
const schemaBooleanKeywords = new Set(["deprecated", "readOnly", "uniqueItems", "writeOnly"]);
const schemaKeywordGroups = [
  [schemaStringKeywords, "string"],
  [schemaNumberKeywords, "number"],
  [schemaIntegerKeywords, "non-negative integer"],
  [schemaBooleanKeywords, "boolean"],
] as const;
export function validateTypeKeyword(type: unknown, path: string): string | undefined {
  if (typeof type === "string") {
    return jsonSchemaTypes.has(type) ? undefined : `${path}.type: unsupported JSON Schema type`;
  }
  if (Array.isArray(type) && type.length > 0) {
    for (const entry of type) {
      if (typeof entry !== "string" || !jsonSchemaTypes.has(entry)) {
        return `${path}.type: unsupported JSON Schema type`;
      }
    }
    return new Set(type).size === type.length
      ? undefined
      : `${path}.type: expected unique JSON Schema types`;
  }
  return `${path}.type: expected string or non-empty string array`;
}

function hasDuplicateJsonValues(values: unknown[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

export function validateSchemaKeywordShapes(
  schema: Record<string, unknown>,
  path: string,
): string | undefined {
  for (const [keywords, expected] of schemaKeywordGroups) {
    for (const key of keywords) {
      const value = schema[key];
      if (
        value !== undefined &&
        (expected === "non-negative integer"
          ? !Number.isInteger(value) || (typeof value === "number" && value < 0)
          : typeof value !== expected)
      ) {
        return `${path}.${key}: expected ${expected}`;
      }
    }
  }
  if (
    schema.multipleOf !== undefined &&
    typeof schema.multipleOf === "number" &&
    schema.multipleOf <= 0
  ) {
    return `${path}.multipleOf: expected positive number`;
  }
  if (schema.required !== undefined) {
    if (!isStringArray(schema.required)) {
      return `${path}.required: expected string array`;
    }
    if (new Set(schema.required).size !== schema.required.length) {
      return `${path}.required: expected unique string array`;
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) {
      return `${path}.enum: expected array`;
    }
    if (schema.enum.length === 0 || hasDuplicateJsonValues(schema.enum)) {
      return `${path}.enum: expected non-empty array with unique values`;
    }
  }
  for (const key of schemaCombinatorKeywords) {
    const value = schema[key];
    if (Array.isArray(value) && value.length === 0) {
      return `${path}.${key}: expected non-empty schema array`;
    }
  }
  if (schema.dependentRequired !== undefined) {
    if (!isRecord(schema.dependentRequired)) {
      return `${path}.dependentRequired: expected string array map`;
    }
    for (const [key, value] of Object.entries(schema.dependentRequired)) {
      if (!isStringArray(value)) {
        return `${path}.dependentRequired.${key}: expected string array`;
      }
    }
  }
  if (schema.dependencies !== undefined) {
    if (!isRecord(schema.dependencies)) {
      return `${path}.dependencies: expected schema or string array map`;
    }
    for (const [key, value] of Object.entries(schema.dependencies)) {
      if (!isStringArray(value) && typeof value !== "boolean" && !isRecord(value)) {
        return `${path}.dependencies.${key}: expected schema or string array`;
      }
    }
  }
  return undefined;
}
