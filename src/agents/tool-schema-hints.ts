/** Bounded TypeScript-style hints for model-visible tool input and output schemas. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const MAX_TOOL_SCHEMA_DECLARATION_CHARS = 32_768;

const MAX_COMPACT_INPUT_HINT_CHARS = 300;
// Sized so real multi-branch contracts like web_search's four-way union stay
// promotable with headroom; the quick index independently truncates total bytes.
const MAX_COMPACT_OUTPUT_HINT_CHARS = 800;
const MAX_COMPACT_INPUT_SCHEMA_PROPERTIES = 16;
const MAX_COMPACT_OUTPUT_SCHEMA_PROPERTIES = 22;
const MAX_COMPACT_SCHEMA_PROPERTY_NAME_CHARS = 128;
const MAX_COMPACT_INPUT_DEPTH = 4;
const MAX_COMPACT_OUTPUT_DEPTH = 6;
const MAX_COMPACT_UNION_TYPES = 5;
// Keeps real literal unions such as agents_list's eight runtime sources renderable,
// while the combined literal text remains independently capped below.
const MAX_COMPACT_ENUM_VALUES = 8;
const MAX_COMPACT_ENUM_CHARS = 96;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const NUMERIC_INPUT_BOUNDS = [
  ["minimum", ">="],
  ["maximum", "<="],
  ["exclusiveMinimum", ">"],
  ["exclusiveMaximum", "<"],
] as const;
const UNSUPPORTED_SHAPE_KEYWORDS = [
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "allOf",
  "patternProperties",
  "unevaluatedProperties",
  "dependentSchemas",
  "dependencies",
  "if",
  "then",
  "else",
  "prefixItems",
  "unevaluatedItems",
] as const;

type SchemaHint = {
  text: string;
  complete: boolean;
  /** Some object in this hint exceeded its budget and was reduced to required keys. */
  overflowed?: boolean;
};

type CompactSchemaLimits = {
  maxChars: number;
  maxDepth: number;
  maxProperties: number;
  numericInputConstraints: boolean;
  declaration?: boolean;
  remainingNodes?: { value: number };
  /** Render only required object keys; set once a hint overflows its budget. */
  requiredOnly?: boolean;
};

const INPUT_LIMITS: CompactSchemaLimits = {
  maxChars: MAX_COMPACT_INPUT_HINT_CHARS,
  maxDepth: MAX_COMPACT_INPUT_DEPTH,
  maxProperties: MAX_COMPACT_INPUT_SCHEMA_PROPERTIES,
  numericInputConstraints: true,
};
const OUTPUT_LIMITS: CompactSchemaLimits = {
  maxChars: MAX_COMPACT_OUTPUT_HINT_CHARS,
  maxDepth: MAX_COMPACT_OUTPUT_DEPTH,
  maxProperties: MAX_COMPACT_OUTPUT_SCHEMA_PROPERTIES,
  numericInputConstraints: false,
};

const UNKNOWN_HINT: SchemaHint = { text: "unknown", complete: false };

function completeHint(text: string): SchemaHint {
  return { text, complete: true };
}

function withSupportedShape(schema: Record<string, unknown>, hint: SchemaHint): SchemaHint {
  return UNSUPPORTED_SHAPE_KEYWORDS.some((key) => Object.hasOwn(schema, key))
    ? { ...hint, complete: false }
    : hint;
}

function normalizeNullableSchemaForHint(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(schema, "nullable")) {
    return schema;
  }
  if (typeof schema.nullable !== "boolean") {
    return undefined;
  }
  const types =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type) && schema.type.every((value) => typeof value === "string")
        ? schema.type
        : undefined;
  if (!types) {
    return undefined;
  }
  if (!schema.nullable) {
    return schema;
  }
  // Mirror the validator's AJV-style nullable normalization so promoted
  // hints include every value that output validation can accept.
  return {
    ...schema,
    nullable: false,
    type: [...new Set([...types, "null"])],
  };
}

function renderPrimitive(value: unknown, maxChars: number): string | undefined {
  // Remote schemas can carry huge literals; reject them before serializing.
  if (typeof value === "string" && value.length > maxChars) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  return undefined;
}

function compactLiteralUnion(values: unknown, limits: CompactSchemaLimits): SchemaHint | undefined {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > (limits.declaration ? 256 : MAX_COMPACT_ENUM_VALUES)
  ) {
    return undefined;
  }
  const rendered = values.map((value) =>
    renderPrimitive(value, limits.declaration ? limits.maxChars : MAX_COMPACT_ENUM_CHARS),
  );
  if (rendered.some((value) => value === undefined)) {
    return undefined;
  }
  const result = [...new Set(rendered as string[])].join(" | ");
  return result.length <= (limits.declaration ? limits.maxChars : MAX_COMPACT_ENUM_CHARS)
    ? completeHint(result)
    : undefined;
}

function compactSchemaUnion(
  schema: Record<string, unknown>,
  depth: number,
  limits: CompactSchemaLimits,
): SchemaHint | undefined {
  const hasAnyOf = Object.hasOwn(schema, "anyOf");
  const hasOneOf = Object.hasOwn(schema, "oneOf");
  if (!hasAnyOf && !hasOneOf) {
    return undefined;
  }
  if (hasAnyOf && hasOneOf) {
    return UNKNOWN_HINT;
  }
  const variants = hasAnyOf ? schema.anyOf : schema.oneOf;
  // Bound before any per-variant scan: neither the eight-value literal cap nor
  // the five-variant structural cap can render a larger union, so oversized
  // unions must be rejected in O(1) instead of O(variants).
  if (
    !Array.isArray(variants) ||
    variants.length === 0 ||
    variants.length > (limits.declaration ? 256 : MAX_COMPACT_ENUM_VALUES)
  ) {
    return UNKNOWN_HINT;
  }
  // A union plus a base structural shape is an intersection. This compact
  // renderer cannot preserve that composition, so never promote it as complete.
  if (
    ["const", "enum", "type", "properties", "required", "additionalProperties", "items"].some(
      (key) => Object.hasOwn(schema, key),
    )
  ) {
    return UNKNOWN_HINT;
  }
  const literalVariants = variants.map((variant) => {
    if (
      !isRecord(variant) ||
      !Object.hasOwn(variant, "const") ||
      UNSUPPORTED_SHAPE_KEYWORDS.some((key) => Object.hasOwn(variant, key))
    ) {
      return undefined;
    }
    return variant.const;
  });
  if (literalVariants.every((value) => value !== undefined)) {
    const literalUnion = compactLiteralUnion(literalVariants, limits);
    if (literalUnion) {
      return literalUnion;
    }
  }
  if (variants.length > (limits.declaration ? 256 : MAX_COMPACT_UNION_TYPES)) {
    return UNKNOWN_HINT;
  }
  const rendered = variants.map((variant) => compactSchemaType(variant, depth + 1, limits));
  // Required-only variants are incomplete by design; still name their required keys.
  if (
    rendered.some((hint) => !hint.complete && (!limits.requiredOnly || hint.text === "unknown"))
  ) {
    // An overflowing variant lets the enclosing object retry with required keys only.
    return rendered.some((hint) => hint.overflowed)
      ? { ...UNKNOWN_HINT, overflowed: true }
      : UNKNOWN_HINT;
  }
  return {
    text: [...new Set(rendered.map((hint) => hint.text))].join(" | "),
    complete: rendered.every((hint) => hint.complete),
    overflowed: rendered.some((hint) => hint.overflowed),
  };
}

function insertLexicallyBounded(values: string[], value: string, limit: number): void {
  if (limit <= 0) {
    return;
  }
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] ?? "").localeCompare(value) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low >= limit) {
    return;
  }
  values.splice(low, 0, value);
  if (values.length > limit) {
    values.pop();
  }
}

function compactObjectHint(
  schema: Record<string, unknown>,
  depth: number,
  limits: CompactSchemaLimits,
): SchemaHint {
  if (limits.declaration) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const keys = [...new Set([...Object.keys(properties), ...required])];
    if (
      keys.length > limits.maxProperties ||
      !keys.every(
        (key): key is string =>
          typeof key === "string" && key.length <= MAX_COMPACT_SCHEMA_PROPERTY_NAME_CHARS,
      )
    ) {
      return UNKNOWN_HINT;
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- keys is a private array freshly spread from the Set above.
    const fields = keys.sort().map((key) => {
      const hint = compactSchemaType(properties[key], depth, limits);
      return (
        (IDENTIFIER_RE.test(key) ? key : JSON.stringify(key)) +
        (required.has(key) ? "" : "?") +
        ": " +
        (hint.complete ? hint.text : "unknown")
      );
    });
    // TS index signatures cover named fields too, unlike additionalProperties.
    if (schema.additionalProperties !== false) {
      const extra = compactSchemaType(schema.additionalProperties, depth, limits);
      fields.push(
        "[key: string]: " + (keys.length === 0 && extra.complete ? extra.text : "unknown"),
      );
    }
    return completeHint(fields.length ? "{ " + fields.join("; ") + " }" : "Record<string, never>");
  }
  if (!isRecord(schema.properties)) {
    const requiredValues = Array.isArray(schema.required) ? schema.required : [];
    const required =
      requiredValues.length > limits.maxProperties ||
      requiredValues.some((value) => typeof value === "string");
    return !required && schema.additionalProperties === false
      ? completeHint("{}")
      : { text: "{ ... }", complete: false };
  }

  const properties = schema.properties;
  const requiredValues = Array.isArray(schema.required) ? schema.required : [];
  const invalidRequired =
    requiredValues.length <= limits.maxProperties &&
    requiredValues.some((value) => typeof value !== "string");
  const required = new Set(
    requiredValues
      .slice(0, limits.maxProperties)
      .filter((value): value is string => typeof value === "string"),
  );
  const requiredKeys: string[] = [];
  let missingRequired = false;
  for (const key of required) {
    if (key.length > MAX_COMPACT_SCHEMA_PROPERTY_NAME_CHARS) {
      missingRequired = true;
      continue;
    }
    if (!Object.hasOwn(properties, key)) {
      missingRequired = true;
      continue;
    }
    insertLexicallyBounded(requiredKeys, key, limits.maxProperties);
  }

  const optionalLimit = limits.maxProperties - requiredKeys.length;
  const optionalKeys: string[] = [];
  let optionalCount = 0;
  let oversizedOptionalKey = false;
  // Client tool schemas can be large and are not trusted metadata. Keep only a
  // fixed-size sorted selection instead of materializing and sorting every key.
  for (const key in properties) {
    if (!Object.hasOwn(properties, key) || required.has(key)) {
      continue;
    }
    optionalCount += 1;
    if (key.length > MAX_COMPACT_SCHEMA_PROPERTY_NAME_CHARS) {
      oversizedOptionalKey = true;
      continue;
    }
    insertLexicallyBounded(optionalKeys, key, optionalLimit);
  }

  const requiredOnly = limits.requiredOnly === true;
  const keys = requiredOnly ? requiredKeys : [...requiredKeys, ...optionalKeys];
  const structurallyIncomplete =
    requiredValues.length > limits.maxProperties ||
    invalidRequired ||
    missingRequired ||
    oversizedOptionalKey ||
    optionalCount > optionalLimit;
  const droppedOptional = requiredOnly && optionalCount > 0;
  let omitted =
    structurallyIncomplete ||
    droppedOptional ||
    schema.additionalProperties === true ||
    isRecord(schema.additionalProperties);
  let complete =
    !structurallyIncomplete && !droppedOptional && schema.additionalProperties === false;
  const prefixes = keys.map(
    (key) =>
      `${IDENTIFIER_RE.test(key) ? key : JSON.stringify(key)}${required.has(key) ? "" : "?"}: `,
  );
  const hints = keys.map((key) => compactSchemaType(properties[key], depth, limits));
  let body = keys.map((_key, index) => prefixes[index] + hints[index]!.text).join("; ");
  // The budget includes both braces, their inner spaces and any trailing "; ...".
  const overflowed =
    hints.some((hint) => hint.overflowed) || body.length + 4 + (omitted ? 5 : 0) > limits.maxChars;
  if (!overflowed) {
    complete &&= hints.every((hint) => hint.complete);
  } else {
    // An overflowing hint keeps only required keys, at every level. Each keeps
    // its full type when it fits, else a type shortened to the remaining
    // budget, else a shallow type.
    omitted ||= optionalCount > 0;
    complete = false;
    const requiredLimits = { ...limits, requiredOnly: true };
    const requiredHints = requiredOnly
      ? hints
      : requiredKeys.map((key) => compactSchemaType(properties[key], depth, requiredLimits));
    const parts = requiredKeys.map((_key, index) => prefixes[index] + requiredHints[index]!.text);
    const budget = limits.maxChars - 4 - (omitted ? 5 : 0);
    body = parts.join("; ");
    if (body.length > budget) {
      const shallow = (index: number) => {
        const property = properties[requiredKeys[index]!];
        const type = isRecord(property) ? property.type : undefined;
        const shallowType =
          type === "array"
            ? "Array<...>"
            : type === "object"
              ? "{ ... }"
              : type === "integer"
                ? "number"
                : typeof type === "string" && ["string", "number", "boolean", "null"].includes(type)
                  ? type
                  : "unknown";
        const elided = prefixes[index] + shallowType;
        return parts[index]!.length <= elided.length ? parts[index]! : elided;
      };
      let reserve = 0;
      for (let index = 0; index < requiredKeys.length; index += 1) {
        reserve += shallow(index).length + 2;
      }
      // A partial required list would read as the whole contract.
      if (reserve - 2 > budget) {
        return { text: "{ ... }", complete: false, overflowed: true };
      }
      body = "";
      for (const [index, key] of requiredKeys.entries()) {
        reserve -= shallow(index).length + 2;
        const room = budget - (body ? body.length + 2 : 0) - reserve;
        let part = parts[index]!;
        if (part.length > room) {
          // Leave room for an Array<...> wrapper around a shortened object.
          const typeRoom = room - prefixes[index]!.length - "Array<>".length;
          const shortened =
            typeRoom > 0
              ? prefixes[index] +
                compactSchemaType(properties[key], depth, { ...requiredLimits, maxChars: typeRoom })
                  .text
              : undefined;
          part = shortened && shortened.length <= room ? shortened : shallow(index);
        }
        body = body ? `${body}; ${part}` : part;
      }
    }
  }
  if (!body) {
    return keys.length === 0 && !omitted
      ? { text: "{}", complete }
      : { text: "{ ... }", complete: false, overflowed };
  }
  return {
    text: `{ ${body}${omitted ? "; ..." : ""} }`,
    complete,
    overflowed,
  };
}

function compactSchemaType(
  schema: unknown,
  depth = 0,
  limits: CompactSchemaLimits = INPUT_LIMITS,
): SchemaHint {
  if (limits.remainingNodes && --limits.remainingNodes.value < 0) {
    return UNKNOWN_HINT;
  }
  if (!isRecord(schema)) {
    return limits.declaration && schema === false ? completeHint("never") : UNKNOWN_HINT;
  }
  if (limits.declaration && UNSUPPORTED_SHAPE_KEYWORDS.some((key) => Object.hasOwn(schema, key))) {
    return UNKNOWN_HINT;
  }
  // An empty schema is JSON Schema's top type: it accepts any value, so
  // `unknown` is its exact rendering, not a truncation. Without this, one
  // opaque leaf (Type.Unknown/Type.Any) demotes an otherwise-exact contract.
  if (Object.keys(schema).length === 0) {
    return completeHint("unknown");
  }
  if (depth >= limits.maxDepth) {
    return UNKNOWN_HINT;
  }
  const normalizedNullableSchema = normalizeNullableSchemaForHint(schema);
  if (!normalizedNullableSchema) {
    return UNKNOWN_HINT;
  }
  if (normalizedNullableSchema !== schema) {
    return compactSchemaType(normalizedNullableSchema, depth, limits);
  }
  const finish = (hint: SchemaHint) => withSupportedShape(schema, hint);

  const schemaUnion = compactSchemaUnion(schema, depth, limits);
  if (schemaUnion) {
    return finish(schemaUnion);
  }
  const literal = renderPrimitive(schema.const, limits.maxChars);
  if (literal !== undefined) {
    return finish(completeHint(literal));
  }
  const enumUnion = compactLiteralUnion(schema.enum, limits);
  if (enumUnion) {
    return finish(enumUnion);
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    if (
      type.length === 0 ||
      type.length > MAX_COMPACT_UNION_TYPES ||
      !type.every((value): value is string => typeof value === "string")
    ) {
      return UNKNOWN_HINT;
    }
    const rendered = type.map((value) =>
      compactSchemaType({ ...schema, type: value }, depth + 1, limits),
    );
    if (rendered.some((hint) => !hint.complete)) {
      return UNKNOWN_HINT;
    }
    return finish(completeHint([...new Set(rendered.map((hint) => hint.text))].join(" | ")));
  }
  if (type === "integer" || type === "number") {
    if (!limits.numericInputConstraints) {
      return finish(completeHint("number"));
    }
    // Inputs need valid argument ranges; output hints retain their existing shapes.
    const constraints = type === "integer" ? ["integer"] : [];
    for (const [key, operator] of NUMERIC_INPUT_BOUNDS) {
      const bound = schema[key];
      if (bound === undefined) {
        continue;
      }
      if (typeof bound !== "number" || !Number.isFinite(bound)) {
        return UNKNOWN_HINT;
      }
      constraints.push(`${operator} ${bound}`);
    }
    return finish(
      completeHint(`number${constraints.length > 0 ? ` /* ${constraints.join(", ")} */` : ""}`),
    );
  }
  if (type === "array") {
    const itemHint = compactSchemaType(schema.items, depth + 1, limits);
    return finish({
      text: `Array<${itemHint.text}>`,
      complete: itemHint.complete,
      overflowed: itemHint.overflowed,
    });
  }
  if (type === "object") {
    return finish(compactObjectHint(schema, depth + 1, limits));
  }
  if (type === "string" || type === "boolean" || type === "null") {
    return finish(completeHint(type));
  }
  return UNKNOWN_HINT;
}

/** Full bounded declaration from the same schema as the compact hints.
 * Unsupported shapes remain unknown; runtime validation still owns constraints.
 */
export function toolSchemaDeclaration(schema: unknown): string {
  const limits: CompactSchemaLimits = {
    maxChars: MAX_TOOL_SCHEMA_DECLARATION_CHARS,
    maxDepth: 12,
    maxProperties: 256,
    numericInputConstraints: true,
    declaration: true,
    remainingNodes: { value: 4096 },
  };
  const hint = compactSchemaType(schema, 0, limits);
  return hint.complete && hint.text.length <= limits.maxChars ? hint.text : "unknown";
}

/** Compact one tool input schema. Unknown inputs remain explicit for safe describe fallback. */
export function compactToolInputHint(schema: unknown): string {
  if (!isRecord(schema)) {
    return "unknown";
  }
  const hint =
    schema.type === "object"
      ? compactObjectHint(schema, 0, INPUT_LIMITS)
      : compactSchemaType(schema, 0, INPUT_LIMITS);
  return hint.text.length <= INPUT_LIMITS.maxChars ? hint.text : "unknown";
}

/** Compact one trusted output schema. Omit incomplete hints instead of inviting field guesses. */
export function compactToolOutputHint(schema: unknown): string | undefined {
  const hint = compactSchemaType(schema, 0, OUTPUT_LIMITS);
  return hint.complete && hint.text.length <= OUTPUT_LIMITS.maxChars ? hint.text : undefined;
}
