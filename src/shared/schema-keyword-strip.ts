type ReadableSchemaEntry = { readonly readable: true; readonly value: unknown };
type UnreadableSchemaEntry = { readonly readable: false };
type ReadableSchemaObjectEntry = ReadableSchemaEntry & { readonly key: string };
type UnreadableSchemaObjectEntry = UnreadableSchemaEntry & { readonly key: string };

const MAX_SCHEMA_ARRAY_ENTRIES = 10_000;
const SCHEMA_VALUE_KEYS = new Set([
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "propertyNames",
  "then",
]);

function unreadableSchemaFieldFallback(key: string): unknown {
  if (key === "properties") {
    return {};
  }
  if (key === "anyOf" || key === "oneOf" || key === "allOf") {
    return [];
  }
  return SCHEMA_VALUE_KEYS.has(key) ? {} : undefined;
}

function readArrayEntries(
  array: readonly unknown[],
): Array<ReadableSchemaEntry | UnreadableSchemaEntry> | undefined {
  try {
    const length = array.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SCHEMA_ARRAY_ENTRIES) {
      return undefined;
    }
    const entries: Array<ReadableSchemaEntry | UnreadableSchemaEntry> = [];
    let index = 0;
    while (index < length) {
      try {
        entries.push({ readable: true, value: array[index] });
      } catch {
        entries.push({ readable: false });
      }
      index += 1;
    }
    return entries;
  } catch {
    return undefined;
  }
}

function readObjectEntries(
  value: object,
): Array<ReadableSchemaObjectEntry | UnreadableSchemaObjectEntry> | undefined {
  try {
    return Object.keys(value as Record<string, unknown>).map((key) => {
      try {
        return { key, readable: true, value: (value as Record<string, unknown>)[key] };
      } catch {
        return { key, readable: false };
      }
    });
  } catch {
    return undefined;
  }
}

function stripUnsupportedSchemaKeywordArray(
  schema: readonly unknown[],
  unsupportedKeywords: ReadonlySet<string>,
): unknown[] {
  return (
    readArrayEntries(schema)?.map((entry) =>
      entry.readable ? stripUnsupportedSchemaKeywords(entry.value, unsupportedKeywords) : {},
    ) ?? []
  );
}

function stripUnsupportedSchemaKeywordMap(
  value: object,
  unsupportedKeywords: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(
    readObjectEntries(value)?.map((entry) => [
      entry.key,
      entry.readable ? stripUnsupportedSchemaKeywords(entry.value, unsupportedKeywords) : {},
    ]) ?? [],
  );
}

export function stripUnsupportedSchemaKeywords(
  schema: unknown,
  unsupportedKeywords: ReadonlySet<string>,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return stripUnsupportedSchemaKeywordArray(schema, unsupportedKeywords);
  }
  const entries = readObjectEntries(schema);
  if (!entries) {
    return {};
  }
  const cleaned: Record<string, unknown> = {};
  for (const entry of entries) {
    const key = entry.key;
    if (unsupportedKeywords.has(key)) {
      continue;
    }
    if (!entry.readable) {
      const fallback = unreadableSchemaFieldFallback(key);
      if (fallback !== undefined) {
        cleaned[key] = fallback;
      }
      continue;
    }
    const value = entry.value;
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = stripUnsupportedSchemaKeywordMap(value, unsupportedKeywords);
      continue;
    }
    if (key === "items" && value && typeof value === "object") {
      cleaned[key] = Array.isArray(value)
        ? stripUnsupportedSchemaKeywordArray(value, unsupportedKeywords)
        : stripUnsupportedSchemaKeywords(value, unsupportedKeywords);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      cleaned[key] = stripUnsupportedSchemaKeywordArray(value, unsupportedKeywords);
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}
