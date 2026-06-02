/** Recursively removes provider-unsupported JSON Schema keywords while preserving schema shape. */
export function stripUnsupportedSchemaKeywords(
  schema: unknown,
  unsupportedKeywords: ReadonlySet<string>,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupportedKeywords));
  }
  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (unsupportedKeywords.has(key)) {
      continue;
    }
    // Object properties are a map of child schemas, not a schema object itself.
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          stripUnsupportedSchemaKeywords(childValue, unsupportedKeywords),
        ]),
      );
      continue;
    }
    if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? value.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupportedKeywords))
        : stripUnsupportedSchemaKeywords(value, unsupportedKeywords);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      cleaned[key] = value.map((entry) =>
        stripUnsupportedSchemaKeywords(entry, unsupportedKeywords),
      );
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}
