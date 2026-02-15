export function cloneConfigObject<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function serializeConfigForm(form: Record<string, unknown>): string {
  return `${JSON.stringify(form, null, 2).trimEnd()}\n`;
}

export function setPathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  value: unknown,
) {
  if (path.length === 0) {
    return;
  }
  let current: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (typeof key === "number") {
      if (!Array.isArray(current)) {
        return;
      }
      if (current[key] == null) {
        current[key] = typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
      }
      current = current[key] as Record<string, unknown> | unknown[];
    } else {
      if (typeof current !== "object" || current == null) {
        return;
      }
      const record = current as Record<string, unknown>;
      if (record[key] == null) {
        record[key] = typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
      }
      current = record[key] as Record<string, unknown> | unknown[];
    }
  }
  const lastKey = path[path.length - 1];
  if (typeof lastKey === "number") {
    if (Array.isArray(current)) {
      current[lastKey] = value;
    }
    return;
  }
  if (typeof current === "object" && current != null) {
    (current as Record<string, unknown>)[lastKey] = value;
  }
}

export function removePathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
) {
  if (path.length === 0) {
    return;
  }
  let current: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (typeof key === "number") {
      if (!Array.isArray(current)) {
        return;
      }
      current = current[key] as Record<string, unknown> | unknown[];
    } else {
      if (typeof current !== "object" || current == null) {
        return;
      }
      current = (current as Record<string, unknown>)[key] as Record<string, unknown> | unknown[];
    }
    if (current == null) {
      return;
    }
  }
  const lastKey = path[path.length - 1];
  if (typeof lastKey === "number") {
    if (Array.isArray(current)) {
      current.splice(lastKey, 1);
    }
    return;
  }
  if (typeof current === "object" && current != null) {
    delete (current as Record<string, unknown>)[lastKey];
  }
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  [key: string]: unknown;
};

export function getSchemaForPath(schema: unknown, path: Array<string | number>): JsonSchema | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  let current = schema as JsonSchema;

  for (const segment of path) {
    if (typeof segment === "number") {
      const items = current.items;
      if (!items) {
        return null;
      }
      current = Array.isArray(items) ? (items[0] ?? null) : items;
      if (!current) {
        return null;
      }
    } else {
      const properties = current.properties;
      if (!properties || !properties[segment]) {
        return null;
      }
      current = properties[segment];
    }
  }

  return current;
}

export function getSchemaType(schema: JsonSchema | null): string | null {
  if (!schema) {
    return null;
  }

  if (typeof schema.type === "string") {
    return schema.type;
  }

  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((t) => t !== "null");
    return nonNull.length > 0 ? nonNull[0] : null;
  }

  const variants = schema.anyOf ?? schema.oneOf;
  if (variants && Array.isArray(variants)) {
    const nonNull = variants.filter(
      (v) => v.type !== "null" && (!Array.isArray(v.type) || !v.type.includes("null")),
    );
    if (nonNull.length > 0) {
      return getSchemaType(nonNull[0]);
    }
  }

  return null;
}

export function coerceValueToSchema(value: unknown, schema: JsonSchema | null): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  const schemaType = getSchemaType(schema);

  if (schemaType === "number" || schemaType === "integer") {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") {
        return undefined;
      }
      const parsed = Number(trimmed);
      if (Number.isNaN(parsed)) {
        return value;
      }
      if (schemaType === "integer" && !Number.isInteger(parsed)) {
        return value;
      }
      return parsed;
    }
    if (typeof value === "number") {
      return value;
    }
  }

  if (schemaType === "boolean") {
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (lower === "true") {
        return true;
      }
      if (lower === "false") {
        return false;
      }
    }
    if (typeof value === "boolean") {
      return value;
    }
  }

  return value;
}
