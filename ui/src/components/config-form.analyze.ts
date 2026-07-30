// Control UI view renders config form.analyze screen content.
import { pathKey, schemaType, type JsonSchema } from "./config-form.shared.ts";

export type ConfigSchemaAnalysis = {
  schema: JsonSchema | null;
  unsupportedPaths: string[];
};

const META_KEYS = new Set(["title", "description", "default", "nullable", "tags", "x-tags"]);
const RENDERABLE_UNION_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
]);

function isAnySchema(schema: JsonSchema): boolean {
  const keys = Object.keys(schema ?? {}).filter((key) => !META_KEYS.has(key));
  return keys.length === 0;
}

function normalizeEnum(values: unknown[]): { enumValues: unknown[]; nullable: boolean } {
  const filtered = values.filter((value) => value != null);
  const nullable = filtered.length !== values.length;
  return { enumValues: uniqueValues(filtered), nullable };
}

function uniqueValues(values: unknown[]): unknown[] {
  const unique: unknown[] = [];
  for (const value of values) {
    if (!unique.some((existing) => Object.is(existing, value))) {
      unique.push(value);
    }
  }
  return unique;
}

type FiniteUnionValues = {
  values: unknown[];
  nullable: boolean;
};

function isFiniteJsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function equalFiniteJsonScalars(left: unknown, right: unknown): boolean {
  return isFiniteJsonScalar(left) && isFiniteJsonScalar(right) && left === right;
}

function equalJsonSchemaValues(left: unknown, right: unknown): boolean {
  if (isFiniteJsonScalar(left) || isFiniteJsonScalar(right)) {
    return equalFiniteJsonScalars(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => equalJsonSchemaValues(entry, right[index]))
    );
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        equalJsonSchemaValues(value, (right as Record<string, unknown>)[key]),
    )
  );
}

function isJsonSchemaValue(value: unknown): boolean {
  if (isFiniteJsonScalar(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonSchemaValue);
  }
  return (
    typeof value === "object" && value !== null && Object.values(value).every(isJsonSchemaValue)
  );
}

function uniqueJsonSchemaValues(values: unknown[]): unknown[] {
  const unique: unknown[] = [];
  for (const value of values) {
    if (!unique.some((existing) => equalJsonSchemaValues(existing, value))) {
      unique.push(value);
    }
  }
  return unique;
}

function matchesFiniteSchemaType(value: unknown, type: JsonSchema["type"]): boolean {
  if (type === undefined) {
    return true;
  }
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case "null":
        return value === null;
      case "boolean":
        return typeof value === "boolean";
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "object":
        return typeof value === "object" && value !== null && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      default:
        return false;
    }
  });
}

function matchesFiniteSchemaConstraints(value: unknown, schema: JsonSchema): boolean {
  return (
    (matchesFiniteSchemaType(value, schema.type) || (value === null && Boolean(schema.nullable))) &&
    (!Array.isArray(schema.enum) ||
      schema.enum.some((candidate) => equalJsonSchemaValues(candidate, value))) &&
    (!("const" in schema) || equalJsonSchemaValues(schema.const, value))
  );
}

function hasUnsupportedFiniteSchemaAssertions(
  schema: JsonSchema,
  options: { allowUnion: boolean },
): boolean {
  return Object.keys(schema).some(
    (key) =>
      key !== "type" &&
      key !== "enum" &&
      key !== "const" &&
      !(options.allowUnion && (key === "anyOf" || key === "oneOf")) &&
      !META_KEYS.has(key) &&
      key !== "$comment" &&
      key !== "deprecated" &&
      key !== "examples" &&
      key !== "readOnly" &&
      key !== "writeOnly",
  );
}

function finiteUnionValues(
  schema: JsonSchema,
  variants: JsonSchema[],
  options: { exclusive: boolean },
): FiniteUnionValues | null {
  if (hasUnsupportedFiniteSchemaAssertions(schema, { allowUnion: true })) {
    return null;
  }
  const branches: unknown[][] = [];
  for (const variant of variants) {
    // Assertion keywords such as `not` can narrow a boolean or enum branch.
    // Decline those variants rather than offering values the Gateway rejects.
    if (hasUnsupportedFiniteSchemaAssertions(variant, { allowUnion: false })) {
      return null;
    }
    let branch: unknown[];
    if (Array.isArray(variant.enum)) {
      if (variant.enum.some((value) => !isJsonSchemaValue(value))) {
        return null;
      }
      branch = variant.enum.filter((value) => matchesFiniteSchemaConstraints(value, variant));
    } else if ("const" in variant) {
      if (!isJsonSchemaValue(variant.const)) {
        return null;
      }
      branch = matchesFiniteSchemaConstraints(variant.const, variant) ? [variant.const] : [];
    } else if (variant.type === "null") {
      branch = [null];
    } else if (variant.type === "boolean") {
      branch = [true, false];
    } else {
      return null;
    }
    if (
      variant.nullable &&
      !branch.some((value) => value === null) &&
      matchesFiniteSchemaConstraints(null, variant)
    ) {
      branch.push(null);
    }
    branches.push(uniqueJsonSchemaValues(branch));
  }

  const values = uniqueJsonSchemaValues(branches.flat()).filter(
    (value) =>
      matchesFiniteSchemaConstraints(value, schema) &&
      (!options.exclusive ||
        branches.filter((branch) =>
          branch.some((candidate) => equalJsonSchemaValues(candidate, value)),
        ).length === 1),
  );
  return {
    values: values.filter((value) => value !== null),
    nullable: values.some((value) => value === null),
  };
}

export function analyzeConfigSchema(raw: unknown): ConfigSchemaAnalysis {
  if (!raw || typeof raw !== "object") {
    return { schema: null, unsupportedPaths: ["<root>"] };
  }
  return normalizeSchemaNode(raw as JsonSchema, []);
}

function normalizeSchemaNode(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis {
  const unsupported = new Set<string>();
  const normalized: JsonSchema = { ...schema };
  const pathLabel = pathKey(path) || "<root>";

  if (schema.anyOf || schema.oneOf || schema.allOf) {
    const union = normalizeUnion(schema, path);
    if (union) {
      return union;
    }
    return { schema, unsupportedPaths: [pathLabel] };
  }

  const nullable = Array.isArray(schema.type) && schema.type.includes("null");
  const type =
    schemaType(schema) ?? (schema.properties || schema.additionalProperties ? "object" : undefined);
  normalized.type = type ?? schema.type;
  normalized.nullable = nullable || schema.nullable;

  if (normalized.enum) {
    const { enumValues, nullable: enumNullable } = normalizeEnum(normalized.enum);
    normalized.enum = enumValues;
    if (enumNullable) {
      normalized.nullable = true;
    }
    if (enumValues.length === 0) {
      unsupported.add(pathLabel);
    }
  }

  if (type === "object") {
    const properties = schema.properties ?? {};
    const normalizedProps: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(properties)) {
      const res = normalizeSchemaNode(value, [...path, key]);
      if (res.schema) {
        normalizedProps[key] = res.schema;
      }
      for (const entry of res.unsupportedPaths) {
        unsupported.add(entry);
      }
    }
    normalized.properties = normalizedProps;

    if (schema.additionalProperties === true) {
      // Treat `true` as an untyped map schema so dynamic object keys can still be edited.
      normalized.additionalProperties = {};
    } else if (schema.additionalProperties === false) {
      normalized.additionalProperties = false;
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      if (!isAnySchema(schema.additionalProperties)) {
        const res = normalizeSchemaNode(schema.additionalProperties, [...path, "*"]);
        normalized.additionalProperties = res.schema ?? schema.additionalProperties;
        if (res.unsupportedPaths.length > 0) {
          unsupported.add(pathLabel);
        }
      }
    }
  } else if (type === "array") {
    const itemsSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    if (!itemsSchema) {
      unsupported.add(pathLabel);
    } else {
      const res = normalizeSchemaNode(itemsSchema, [...path, "*"]);
      normalized.items = res.schema ?? itemsSchema;
      if (res.unsupportedPaths.length > 0) {
        unsupported.add(pathLabel);
      }
    }
  } else if (
    type !== "string" &&
    type !== "number" &&
    type !== "integer" &&
    type !== "boolean" &&
    !normalized.enum
  ) {
    unsupported.add(pathLabel);
  }

  return {
    schema: normalized,
    unsupportedPaths: Array.from(unsupported),
  };
}

function isSecretRefVariant(entry: JsonSchema): boolean {
  if (schemaType(entry) !== "object") {
    return false;
  }
  const source = entry.properties?.source;
  const provider = entry.properties?.provider;
  const id = entry.properties?.id;
  if (!source || !provider || !id) {
    return false;
  }
  return (
    typeof source.const === "string" &&
    schemaType(provider) === "string" &&
    schemaType(id) === "string"
  );
}

function isSecretRefUnion(entry: JsonSchema): boolean {
  const variants = entry.oneOf ?? entry.anyOf;
  if (!variants || variants.length === 0) {
    return false;
  }
  return variants.every((variant) => isSecretRefVariant(variant));
}

function normalizeSecretInputUnion(
  schema: JsonSchema,
  path: Array<string | number>,
  remaining: JsonSchema[],
  nullable: boolean,
): ConfigSchemaAnalysis | null {
  const stringIndex = remaining.findIndex((entry) => schemaType(entry) === "string");
  if (stringIndex < 0) {
    return null;
  }
  const nonString = remaining.filter((_, index) => index !== stringIndex);
  const secretRefSchema = nonString[0];
  const stringSchema = remaining[stringIndex];
  if (nonString.length !== 1 || !secretRefSchema || !stringSchema) {
    return null;
  }
  if (!isSecretRefUnion(secretRefSchema)) {
    return null;
  }
  return normalizeSchemaNode(
    {
      ...schema,
      ...stringSchema,
      nullable: nullable || stringSchema.nullable,
      anyOf: undefined,
      oneOf: undefined,
      allOf: undefined,
    },
    path,
  );
}

function normalizeUnion(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis | null {
  if (schema.allOf || (schema.anyOf && schema.oneOf)) {
    return null;
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (!union) {
    return null;
  }

  const literals: unknown[] = [];
  const remaining: JsonSchema[] = [];
  let nullable = false;

  for (const entry of union) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    if (Array.isArray(entry.enum)) {
      const { enumValues, nullable: enumNullable } = normalizeEnum(entry.enum);
      literals.push(...enumValues);
      if (enumNullable) {
        nullable = true;
      }
      continue;
    }
    if ("const" in entry) {
      if (entry.const == null) {
        nullable = true;
        continue;
      }
      literals.push(entry.const);
      continue;
    }
    if (schemaType(entry) === "null") {
      nullable = true;
      continue;
    }
    remaining.push(entry);
  }

  // Config secrets accept either a raw key string or a structured secret ref object.
  // The form only supports editing the string path for now.
  const secretInput = normalizeSecretInputUnion(schema, path, remaining, nullable);
  if (secretInput) {
    return secretInput;
  }

  // Boolean branches are finite, too. Keep their two values alongside literal
  // modes so generated settings such as true | false | "auto" remain editable.
  const finiteValues =
    literals.length > 0 || nullable
      ? finiteUnionValues(schema, union, { exclusive: Boolean(schema.oneOf) })
      : null;
  if (finiteValues && (finiteValues.values.length > 0 || finiteValues.nullable)) {
    return {
      schema: {
        ...schema,
        enum: finiteValues.values,
        nullable: finiteValues.nullable,
        anyOf: undefined,
        oneOf: undefined,
        allOf: undefined,
      },
      unsupportedPaths: [],
    };
  }

  if (remaining.length === 1) {
    const remainingSchema = remaining[0];
    if (!remainingSchema) {
      return null;
    }
    // Parent assertions can eliminate literal branches entirely. Only live
    // branches can overlap or prevent a broad primitive from being editable.
    const compatibleLiterals = literals.filter(
      (value) => isJsonSchemaValue(value) && matchesFiniteSchemaConstraints(value, schema),
    );
    if (
      literals.length > 0 &&
      (literals.some((value) => !isJsonSchemaValue(value)) ||
        (Boolean(schema.oneOf) && compatibleLiterals.length > 0) ||
        (compatibleLiterals.length > 0 && remainingSchema.type === undefined) ||
        hasUnsupportedFiniteSchemaAssertions(schema, { allowUnion: true }) ||
        hasUnsupportedFiniteSchemaAssertions(remainingSchema, { allowUnion: false }) ||
        !compatibleLiterals.every((value) =>
          matchesFiniteSchemaConstraints(value, remainingSchema),
        ))
    ) {
      return null;
    }
    return normalizeSchemaNode(
      {
        ...schema,
        ...remainingSchema,
        nullable: nullable || remainingSchema.nullable,
        anyOf: undefined,
        oneOf: undefined,
        allOf: undefined,
      },
      path,
    );
  }

  if (
    remaining.length > 0 &&
    literals.length === 0 &&
    remaining.every((entry) => {
      const type = schemaType(entry);
      return Boolean(type) && RENDERABLE_UNION_TYPES.has(String(type));
    })
  ) {
    return {
      schema: {
        ...schema,
        nullable,
      },
      unsupportedPaths: [],
    };
  }

  return null;
}
