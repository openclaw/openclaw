import { isDeepStrictEqual } from "node:util";
import {
  cleanSchemaForGemini,
  cleanSchemaForLlamacppGbnf,
  findLlamacppGbnfSchemaViolations,
  findOpenAIStrictSchemaViolations,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
  normalizeOpenAIStrictCompatSchema,
  stripUnsupportedSchemaKeywords,
} from "@openclaw/ai/internal/tool-schema";
// Provider tool helpers expose shared tool-call payload contracts for provider plugins.
import type { TSchema } from "typebox";
import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderToolSchemaDiagnostic,
} from "./plugin-entry.js";

export {
  normalizeOpenAIStrictCompatSchema,
  cleanSchemaForGemini,
  cleanSchemaForLlamacppGbnf,
  findLlamacppGbnfSchemaViolations,
  findOpenAIStrictSchemaViolations,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
  stripUnsupportedSchemaKeywords,
};

/**
 * Finds unsupported JSON-schema keywords and reports their nested schema paths.
 */
export function findUnsupportedSchemaKeywords(
  /** JSON schema node to inspect. */
  schema: unknown,
  /** Dot/bracket path prefix used in returned diagnostics. */
  path: string,
  /** Schema keywords unsupported by the target provider family. */
  unsupportedKeywords: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  type Visit =
    | { kind: "schema"; schema: unknown; path: string }
    | { kind: "violation"; path: string }
    | { kind: "leave"; schema: object };
  const pending: Visit[] = [{ kind: "schema", schema, path }];
  const active = new WeakSet<object>();
  for (let visit = pending.pop(); visit; visit = pending.pop()) {
    if (visit.kind === "violation") {
      violations.push(visit.path);
      continue;
    }
    if (visit.kind === "leave") {
      active.delete(visit.schema);
      continue;
    }
    const node = visit.schema;
    if (!node || typeof node !== "object") {
      continue;
    }
    if (active.has(node)) {
      throw new TypeError("Cannot inspect a circular tool schema");
    }
    active.add(node);
    pending.push({ kind: "leave", schema: node });
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index--) {
        pending.push({ kind: "schema", schema: node[index], path: `${visit.path}[${index}]` });
      }
      continue;
    }
    const record = node as Record<string, unknown>;
    // Reverse scheduling preserves properties-first, depth-first diagnostic order.
    for (const [key, value] of Object.entries(record).toReversed()) {
      if (key === "properties") {
        continue;
      }
      const childPath = `${visit.path}.${key}`;
      pending.push({ kind: "schema", schema: value, path: childPath });
      if (unsupportedKeywords.has(key)) {
        pending.push({ kind: "violation", path: childPath });
      }
    }
    const properties = record.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, value] of Object.entries(properties).toReversed()) {
        pending.push({ kind: "schema", schema: value, path: `${visit.path}.properties.${key}` });
      }
    }
  }
  return violations;
}

function normalizeToolSchemasIfChanged(
  ctx: ProviderNormalizeToolSchemasContext,
  normalizeSchema: (schema: unknown) => unknown,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    const parameters = normalizeSchema(tool.parameters);
    return parameters === tool.parameters
      ? tool
      : {
          ...tool,
          parameters: parameters as TSchema,
        };
  });
}

function inspectUnsupportedToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
  unsupportedKeywords: ReadonlySet<string>,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const violations = findUnsupportedSchemaKeywords(
      tool.parameters,
      `${tool.name}.parameters`,
      unsupportedKeywords,
    );
    if (violations.length === 0) {
      return [];
    }
    return [{ toolName: tool.name, toolIndex, violations }];
  });
}

/**
 * Rewrites tool schemas into Gemini-compatible JSON schema before provider dispatch.
 */
export function normalizeGeminiToolSchemas(
  /** Provider tool-schema normalization context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: cleanSchemaForGemini(tool.parameters),
    };
  });
}

/**
 * Reports Gemini-incompatible schema keywords without mutating tool definitions.
 */
export function inspectGeminiToolSchemas(
  /** Provider tool-schema inspection context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return inspectUnsupportedToolSchemas(ctx, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS);
}

/** Rewrites tool schemas into the JSON Schema subset accepted by llama.cpp GBNF. */
export function normalizeLlamacppGbnfToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return normalizeToolSchemasIfChanged(ctx, cleanSchemaForLlamacppGbnf);
}

/** Reports tool-schema constraints that llama.cpp GBNF cannot compile. */
export function inspectLlamacppGbnfToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const violations = findLlamacppGbnfSchemaViolations(tool.parameters, `${tool.name}.parameters`);
    return violations.length > 0 ? [{ toolName: tool.name, toolIndex, violations }] : [];
  });
}

/**
 * Rewrites OpenAI-native tool schemas to satisfy strict object-schema requirements.
 */
export function normalizeOpenAIToolSchemas(
  /** Provider tool-schema normalization context used to detect native OpenAI strict routes. */
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  if (!shouldApplyOpenAIToolCompat(ctx)) {
    return ctx.tools;
  }
  return ctx.tools.map((tool) => {
    if (tool.parameters == null) {
      return {
        ...tool,
        parameters: normalizeOpenAIStrictCompatSchema({}),
      };
    }
    if (typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: normalizeOpenAIStrictCompatSchema(tool.parameters),
    };
  });
}

function shouldApplyOpenAIToolCompat(ctx: ProviderNormalizeToolSchemasContext): boolean {
  const provider = (ctx.model?.provider ?? ctx.provider ?? "").trim().toLowerCase();
  const api = (ctx.model?.api ?? ctx.modelApi ?? "").trim().toLowerCase();
  const baseUrl = (ctx.model?.baseUrl ?? "").trim().toLowerCase();

  if (provider === "openai") {
    if (api === "openai-responses") {
      // Strict-schema normalization is only safe for the native OpenAI endpoint;
      // OpenAI-compatible proxies may accept broader schemas or define their own rules.
      return !baseUrl || isOpenAIResponsesBaseUrl(baseUrl);
    }
    return (
      api === "openai-chatgpt-responses" &&
      // Codex/ChatGPT Responses uses the same strict object-schema contract as native
      // OpenAI Responses, but only on the known first-party backend URLs.
      (!baseUrl || isOpenAIResponsesBaseUrl(baseUrl) || isOpenAICodexBaseUrl(baseUrl))
    );
  }
  return false;
}

function isOpenAIResponsesBaseUrl(baseUrl: string): boolean {
  return /^https:\/\/api\.openai\.com(?:\/v1)?(?:\/|$)/i.test(baseUrl);
}

function isOpenAICodexBaseUrl(baseUrl: string): boolean {
  return /^https:\/\/chatgpt\.com\/backend-api(?:\/|$)/i.test(baseUrl);
}

/**
 * Reports OpenAI strict-schema diagnostics for transports that enforce them before dispatch.
 */
export function inspectOpenAIToolSchemas(
  /** Provider tool-schema inspection context used to detect native OpenAI strict routes. */
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  if (!shouldApplyOpenAIToolCompat(ctx)) {
    return [];
  }
  // Native OpenAI transports fall back to `strict: false` when any tool schema is not
  // strict-compatible, so these findings are expected for optional-heavy tool schemas.
  return [];
}

/**
 * DeepSeek rejects union keywords in tool schemas.
 */
export const DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["anyOf", "oneOf"]);

function isNullSchemaVariant(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const record = schema as Record<string, unknown>;
  if (record.type === "null") {
    return true;
  }
  if (Array.isArray(record.type) && record.type.length === 1 && record.type[0] === "null") {
    return true;
  }
  if ("const" in record && record.const === null) {
    return true;
  }
  return Array.isArray(record.enum) && record.enum.length === 1 && record.enum[0] === null;
}

function normalizeDeepSeekSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const normalized = new WeakMap<object, unknown>();
  const active = new WeakSet<object>();
  const pending = [{ schema, leave: false }];
  const readNormalized = (value: unknown): unknown =>
    value && typeof value === "object" ? normalized.get(value) : value;
  for (let visit = pending.pop(); visit; visit = pending.pop()) {
    const node = visit.schema;
    if (visit.leave) {
      normalized.set(node, normalizeDeepSeekSchemaNode(node, readNormalized));
      active.delete(node);
      continue;
    }
    if (normalized.has(node)) {
      continue;
    }
    if (active.has(node)) {
      throw new TypeError("Cannot normalize a circular tool schema");
    }
    active.add(node);
    pending.push({ schema: node, leave: true });
    const children = Array.isArray(node) ? node : Object.values(node);
    for (let index = children.length - 1; index >= 0; index--) {
      const child: unknown = children[index];
      if (child && typeof child === "object") {
        pending.push({ schema: child, leave: false });
      }
    }
  }
  return normalized.get(schema);
}

// Children are completed first so union reduction keeps the existing copy-on-write contract.
function normalizeDeepSeekSchemaNode(
  schema: object,
  readNormalized: (value: unknown) => unknown,
): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = readNormalized(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  const record = schema as Record<string, unknown>;
  const unionKey = Array.isArray(record.anyOf)
    ? "anyOf"
    : Array.isArray(record.oneOf)
      ? "oneOf"
      : undefined;

  let changed = unionKey !== undefined;
  const normalized = Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== unionKey)
      .map(([key, value]) => {
        const next = readNormalized(value);
        changed ||= next !== value;
        return [key, next];
      }),
  );

  if (!unionKey) {
    return changed ? normalized : schema;
  }

  const variants = record[unionKey] as unknown[];
  const normalizedVariants = variants.map(readNormalized);
  const nonNullVariants = normalizedVariants.filter((entry) => !isNullSchemaVariant(entry));
  const hasNullVariant =
    nonNullVariants.length < normalizedVariants.length ||
    nonNullVariants.some((entry) => {
      if (
        !isObjectSchemaVariant(entry) ||
        !Array.isArray(entry.type) ||
        !entry.type.includes("null")
      ) {
        return false;
      }
      const literals = readLiteralSchemaValues(entry);
      return literals === undefined || literals.includes(null);
    });

  // Preserve string-const unions as a flat string enum so DeepSeek tool
  // callers still see every allowed literal. Without this, a Typebox
  // `Type.Union([Type.Literal("a"), Type.Literal("b"), ...])` collapses to
  // only the first const and the model can never pick any other value.
  if (nonNullVariants.length > 1 && nonNullVariants.every((entry) => isStringConstVariant(entry))) {
    const enumValues = nonNullVariants.map((entry) => (entry as { const: string }).const);
    const merged: Record<string, unknown> = {
      ...normalized,
      type: "string",
      enum: enumValues,
    };
    if (hasNullVariant) {
      merged.nullable = true;
    }
    return merged;
  }

  // Selecting the first object would make valid later branches fail local validation.
  const selected =
    nonNullVariants.length > 1 && nonNullVariants.every(isObjectSchemaVariant)
      ? (flattenObjectVariants(nonNullVariants) ?? nonNullVariants[0])
      : (nonNullVariants[0] ?? normalizedVariants[0]);
  if (!isSchemaRecord(selected)) {
    return normalized;
  }

  const nullableObject =
    hasNullVariant && nonNullVariants.length > 0 && nonNullVariants.every(isObjectSchemaVariant);
  let selectedSchema = selected;
  if (nullableObject) {
    // Lift branch constraints before applying the outer schema's restrictions.
    selectedSchema = { ...selected, type: ["object", "null"] };
    const literals = readLiteralSchemaValues(selected);
    if (literals) {
      selectedSchema.enum = literals.includes(null) ? literals : [...literals, null];
      delete selectedSchema.const;
    }
  }
  const merged = {
    ...selectedSchema,
    ...normalized,
  };
  if (hasNullVariant && !nullableObject) {
    merged.nullable = true;
  }
  return merged;
}

function isStringConstVariant(entry: unknown): entry is { const: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return typeof record.const === "string";
}

function isObjectSchemaVariant(entry: unknown): entry is Record<string, unknown> {
  return (
    isSchemaRecord(entry) &&
    (entry.type === "object" ||
      (Array.isArray(entry.type) &&
        entry.type.includes("object") &&
        entry.type.every((type) => type === "object" || type === "null")))
  );
}

/**
 * Keys that only document a schema. Everything else is a constraint, so this is
 * what survives when a property has to stay unconstrained.
 */
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

/** Compare JSON schema containers without recursing through deeply nested constraints or literals. */
function schemaValuesEqual(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  const compared = new WeakMap<object, WeakSet<object>>();
  for (let pair = pending.pop(); pair; pair = pending.pop()) {
    const [a, b] = pair;
    if (Object.is(a, b)) {
      continue;
    }
    if (!a || !b || typeof a !== "object" || typeof b !== "object") {
      return false;
    }
    const prototype = Object.getPrototypeOf(a);
    if (prototype !== Object.getPrototypeOf(b) || Array.isArray(a) !== Array.isArray(b)) {
      return false;
    }
    if (
      prototype !== Object.prototype &&
      prototype !== null &&
      !(Array.isArray(a) && prototype === Array.prototype)
    ) {
      // Non-JSON values retain Node's existing comparison semantics.
      if (!isDeepStrictEqual(a, b)) {
        return false;
      }
      continue;
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
      return false;
    }
    if (compared.get(a)?.has(b)) {
      continue;
    }
    const keys = Reflect.ownKeys(a).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(a, key),
    );
    const otherKeys = Reflect.ownKeys(b).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(b, key),
    );
    if (keys.length !== otherKeys.length) {
      return false;
    }
    const matches = compared.get(a) ?? new WeakSet<object>();
    matches.add(b);
    compared.set(a, matches);
    for (const key of keys) {
      if (!Object.prototype.propertyIsEnumerable.call(b, key)) {
        return false;
      }
      pending.push([Reflect.get(a, key), Reflect.get(b, key)]);
    }
  }
  return true;
}

/**
 * Flattens a union of object schemas into one object schema, keeping every
 * branch expressible: the union of the variants' properties, and the
 * intersection of their `required` lists.
 *
 * A property that discriminates the variants differs only by its literals
 * (`type: { enum: ["page_id"] }` in one variant, `["database_id"]` in another),
 * so its values are pooled into a single enum. Without that pooling the
 * flattened schema would still pin the discriminator to the first variant and
 * the tool would stay unusable for the others.
 *
 * Missing property maps retain the previous single-variant selection.
 * Conflicting property constraints retain their first definition.
 */
function flattenObjectVariants(
  variants: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  // SAFETY: Object.create(null) is typed as any; every key written below is a schema keyword string.
  const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let required: string[] | undefined;
  for (const variant of variants) {
    const variantProperties = variant.properties;
    if (
      !variantProperties ||
      typeof variantProperties !== "object" ||
      Array.isArray(variantProperties)
    ) {
      return undefined;
    }
    for (const [key, value] of Object.entries(variantProperties)) {
      // Own-property membership, not a prototype-chain read: a key named
      // `constructor` or `toString` would otherwise look already present and
      // its real definition would be dropped.
      if (!Object.hasOwn(properties, key)) {
        properties[key] = value;
        continue;
      }
      const existing = properties[key];
      if (schemaValuesEqual(existing, value)) {
        continue;
      }
      const pooled = poolLiteralEnum(existing, value);
      if (pooled) {
        properties[key] = pooled;
      }
      // Otherwise keep the first definition. Widening it would mean putting a
      // union keyword back, which is the one thing DeepSeek will not accept.
    }
    const variantRequired = Array.isArray(variant.required)
      ? variant.required.filter((key): key is string => typeof key === "string")
      : [];
    required =
      required === undefined
        ? variantRequired
        : required.filter((key) => variantRequired.includes(key));
  }
  // A variant that does not declare a key can still accept it, either by
  // allowing additional properties or through a `patternProperties` pattern.
  // Constraining such a key would reject calls the variant accepted, so keep
  // what documents it and drop what constrains it.
  for (const key of Object.keys(properties)) {
    if (variants.some((variant) => acceptsUndeclaredKey(variant, key))) {
      properties[key] = schemaAnnotationsOnly(properties[key]);
    }
  }
  const flattened: Record<string, unknown> = { type: "object", properties };
  if (required && required.length > 0) {
    flattened.required = required;
  }
  return flattened;
}

/**
 * Whether a variant accepts a key it does not declare.
 *
 * `additionalProperties` only constrains keys that no `properties` entry and no
 * `patternProperties` pattern covers, so a pattern match widens acceptance even
 * when `additionalProperties` is false. Ignoring that would copy another
 * variant's constraint onto a key this variant accepted.
 */
function acceptsUndeclaredKey(variant: Record<string, unknown>, key: string): boolean {
  const declared = variant.properties;
  if (isSchemaRecord(declared) && Object.hasOwn(declared, key)) {
    return false;
  }
  if (variant.additionalProperties !== false) {
    return true;
  }
  return matchesPatternProperty(variant.patternProperties, key);
}

/** Whether a variant's `patternProperties` covers the key. */
function matchesPatternProperty(patternProperties: unknown, key: string): boolean {
  if (!isSchemaRecord(patternProperties)) {
    return false;
  }
  return Object.keys(patternProperties).some((pattern) => {
    try {
      return new RegExp(pattern).test(key);
    } catch {
      // An uncompilable pattern covers nothing, so it cannot widen acceptance
      // and must not make the merge throw.
      return false;
    }
  });
}

/** Keeps only the keys that document a property, dropping every constraint. */
function schemaAnnotationsOnly(schema: unknown): Record<string, unknown> {
  if (!isSchemaRecord(schema)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => SCHEMA_ANNOTATION_KEYS.has(key)),
  );
}

function readLiteralSchemaValues(schema: Record<string, unknown>): unknown[] | undefined {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (Object.hasOwn(schema, "const")) {
    if (!enumValues) {
      return [schema.const];
    }
    return enumValues.some((value) => schemaValuesEqual(value, schema.const)) ? [schema.const] : [];
  }
  return enumValues;
}

/** Pools the values of two property schemas that differ only by their literals. */
function poolLiteralEnum(left: unknown, right: unknown): Record<string, unknown> | undefined {
  if (!isSchemaRecord(left) || !isSchemaRecord(right)) {
    return undefined;
  }
  const leftValues = readLiteralSchemaValues(left);
  const rightValues = readLiteralSchemaValues(right);
  if (!leftValues || !rightValues) {
    return undefined;
  }
  if (!schemaValuesEqual(literalValidationConstraints(left), literalValidationConstraints(right))) {
    return undefined;
  }
  const combined = [...leftValues, ...rightValues];
  const values = combined.filter(
    (value, index) =>
      combined.findIndex((candidate) => schemaValuesEqual(candidate, value)) === index,
  );
  if (values.length === 0) {
    return undefined;
  }
  const merged: Record<string, unknown> = { ...left, enum: values };
  delete merged.const;
  return merged;
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function literalValidationConstraints(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).filter(
      ([key]) => key !== "const" && key !== "enum" && !SCHEMA_ANNOTATION_KEYS.has(key),
    ),
  );
}

/**
 * Rewrites DeepSeek-incompatible union schemas into the closest accepted shape.
 */
export function normalizeDeepSeekToolSchemas(
  /** Provider tool-schema normalization context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return normalizeToolSchemasIfChanged(ctx, normalizeDeepSeekSchema);
}

/**
 * Reports DeepSeek-incompatible union schema paths without mutating tool definitions.
 */
export function inspectDeepSeekToolSchemas(
  /** Provider tool-schema inspection context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return inspectUnsupportedToolSchemas(ctx, DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS);
}

/**
 * Supported provider tool-schema compatibility families.
 */
export type ProviderToolCompatFamily = "deepseek" | "gemini" | "llamacpp-gbnf" | "openai";

/**
 * Returns the normalizer and inspector pair for a provider tool-schema compatibility family.
 */
export function buildProviderToolCompatFamilyHooks(
  /** Provider tool-schema compatibility family to route to normalizer/inspector hooks. */
  family: ProviderToolCompatFamily,
): {
  /** Mutating-compatible hook that returns tool definitions accepted by the provider family. */
  normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => AnyAgentTool[];
  /** Non-mutating hook that reports provider-family schema incompatibilities. */
  inspectToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => ProviderToolSchemaDiagnostic[];
} {
  switch (family) {
    case "deepseek":
      return {
        normalizeToolSchemas: normalizeDeepSeekToolSchemas,
        inspectToolSchemas: inspectDeepSeekToolSchemas,
      };
    case "gemini":
      return {
        normalizeToolSchemas: normalizeGeminiToolSchemas,
        inspectToolSchemas: inspectGeminiToolSchemas,
      };
    case "llamacpp-gbnf":
      return {
        normalizeToolSchemas: normalizeLlamacppGbnfToolSchemas,
        inspectToolSchemas: inspectLlamacppGbnfToolSchemas,
      };
    case "openai":
      return {
        normalizeToolSchemas: normalizeOpenAIToolSchemas,
        inspectToolSchemas: inspectOpenAIToolSchemas,
      };
  }
  throw new Error("Unsupported provider tool compatibility family");
}
