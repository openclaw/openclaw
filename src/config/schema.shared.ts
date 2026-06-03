type JsonSchemaObject = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
};

export function cloneSchema<T>(value: T): T {
  return structuredClone(value);
}

export function asSchemaObject(value: unknown): object | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function readSchemaField<K extends keyof JsonSchemaObject>(
  schema: JsonSchemaObject,
  key: K,
): JsonSchemaObject[K] | undefined {
  try {
    return schema[key];
  } catch {
    return undefined;
  }
}

function readObjectKeys(value: Record<string, unknown>): string[] | undefined {
  try {
    return Object.keys(value);
  } catch {
    return undefined;
  }
}

function readObjectEntries<T>(value: Record<string, T>): Array<[string, T]> | undefined {
  try {
    return Object.entries(value);
  } catch {
    return undefined;
  }
}

export function schemaHasChildren(schema: JsonSchemaObject): boolean {
  const properties = readSchemaField(schema, "properties");
  if (properties) {
    const keys = readObjectKeys(properties);
    if (!keys || keys.length > 0) {
      return true;
    }
  }
  const additionalProperties = readSchemaField(schema, "additionalProperties");
  if (additionalProperties && typeof additionalProperties === "object") {
    return true;
  }
  const items = readSchemaField(schema, "items");
  if (Array.isArray(items)) {
    return items.some((entry) => typeof entry === "object" && entry !== null);
  }
  for (const branch of [
    readSchemaField(schema, "oneOf"),
    readSchemaField(schema, "anyOf"),
    readSchemaField(schema, "allOf"),
  ]) {
    if (branch?.some((entry) => entry && typeof entry === "object" && schemaHasChildren(entry))) {
      return true;
    }
  }
  return Boolean(items && typeof items === "object");
}

export function findWildcardHintMatch<T>(params: {
  uiHints: Record<string, T>;
  path: string;
  splitPath: (path: string) => string[];
}): { path: string; hint: T } | null {
  const targetParts = params.splitPath(params.path);
  let bestMatch:
    | {
        path: string;
        hint: T;
        wildcardCount: number;
      }
    | undefined;

  for (const [hintPath, hint] of readObjectEntries(params.uiHints) ?? []) {
    const hintParts = params.splitPath(hintPath);
    if (hintParts.length !== targetParts.length) {
      continue;
    }

    let wildcardCount = 0;
    let matches = true;
    for (let index = 0; index < hintParts.length; index += 1) {
      const hintPart = hintParts[index];
      const targetPart = targetParts[index];
      if (hintPart === targetPart) {
        continue;
      }
      if (hintPart === "*") {
        wildcardCount += 1;
        continue;
      }
      matches = false;
      break;
    }

    if (!matches) {
      continue;
    }
    if (!bestMatch || wildcardCount < bestMatch.wildcardCount) {
      bestMatch = { path: hintPath, hint, wildcardCount };
    }
  }

  return bestMatch ? { path: bestMatch.path, hint: bestMatch.hint } : null;
}
