// Provider tool helpers expose shared tool-call payload contracts for provider plugins.
import type { TSchema } from "typebox";
import {
  cleanSchemaForGemini,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
} from "../agents/schema/clean-for-gemini.js";
import { stripUnsupportedSchemaKeywords } from "../shared/schema-keyword-strip.js";
import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderToolSchemaDiagnostic,
} from "./plugin-entry.js";

export { cleanSchemaForGemini, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS, stripUnsupportedSchemaKeywords };

/**
 * Finds unsupported JSON-schema keywords and reports their nested schema paths.
 */
export function findUnsupportedSchemaKeywords(
  /** JSON schema node to inspect recursively. */
  schema: unknown,
  /** Dot/bracket path prefix used in returned diagnostics. */
  path: string,
  /** Schema keywords unsupported by the target provider family. */
  unsupportedKeywords: ReadonlySet<string>,
): string[] {
  const arrayEntries = readSchemaArrayEntries(schema);
  if (arrayEntries === "unreadable") {
    return [`${path} is unreadable`];
  }
  if (arrayEntries) {
    return arrayEntries.flatMap(([index, item]) =>
      findUnsupportedSchemaKeywords(item, `${path}[${index}]`, unsupportedKeywords),
    );
  }
  const entries = readSchemaObjectEntries(schema);
  if (entries === "unreadable") {
    return [`${path} is unreadable`];
  }
  if (!entries) {
    return [];
  }
  const violations: string[] = [];
  const properties = readSchemaField(schema, "properties");
  const propertyEntries = readSchemaObjectEntries(properties);
  if (propertyEntries === "unreadable") {
    violations.push(`${path}.properties is unreadable`);
  } else if (propertyEntries) {
    for (const [key, value] of propertyEntries) {
      violations.push(
        ...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`, unsupportedKeywords),
      );
    }
  }
  for (const [key, value] of entries) {
    if (key === "properties") {
      continue;
    }
    if (unsupportedKeywords.has(key)) {
      violations.push(`${path}.${key}`);
    }
    if (value && typeof value === "object") {
      violations.push(
        ...findUnsupportedSchemaKeywords(value, `${path}.${key}`, unsupportedKeywords),
      );
    }
  }
  return violations;
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
  return ctx.tools.flatMap((tool, toolIndex) => {
    const violations = findUnsupportedSchemaKeywords(
      tool.parameters,
      `${tool.name}.parameters`,
      GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
    );
    if (violations.length === 0) {
      return [];
    }
    return [{ toolName: tool.name, toolIndex, violations }];
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

function normalizeOpenAIStrictCompatSchema(schema: unknown): TSchema {
  return normalizeOpenAIStrictCompatSchemaRecursive(schema, {
    promoteEmptyObject: true,
  }) as TSchema;
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
  if (provider === "openai") {
    return (
      api === "openai-chatgpt-responses" &&
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

type NormalizeOpenAIStrictCompatOptions = {
  promoteEmptyObject: boolean;
};

const OPENAI_STRICT_COMPAT_SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS = new Set([
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

type SchemaArrayEntries = [number, unknown][] | "unreadable" | undefined;
type SchemaObjectEntries = [string, unknown][] | "unreadable" | undefined;
type SchemaObjectKeys = string[] | "unreadable" | undefined;

function readSchemaArrayEntries(value: unknown): SchemaArrayEntries {
  if (!Array.isArray(value)) {
    return undefined;
  }
  try {
    return Array.from({ length: value.length }, (_, index) => [index, value[index]]);
  } catch {
    return "unreadable";
  }
}

function readSchemaObjectEntries(value: unknown): SchemaObjectEntries {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    return Object.entries(value as Record<string, unknown>);
  } catch {
    return "unreadable";
  }
}

function readSchemaObjectKeys(value: unknown): SchemaObjectKeys {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    return Object.keys(value as Record<string, unknown>);
  } catch {
    return "unreadable";
  }
}

function readSchemaField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function normalizeOpenAIStrictCompatSchemaMap(schema: unknown): unknown {
  const entries = readSchemaObjectEntries(schema);
  if (entries === "unreadable") {
    return schema;
  }
  if (!entries) {
    return schema;
  }

  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const next = normalizeOpenAIStrictCompatSchemaRecursive(value, {
      promoteEmptyObject: false,
    });
    normalized[key] = next;
    changed ||= next !== value;
  }
  return changed ? normalized : schema;
}

function normalizeOpenAIStrictCompatSchemaRecursive(
  schema: unknown,
  options: NormalizeOpenAIStrictCompatOptions,
): unknown {
  const arrayEntries = readSchemaArrayEntries(schema);
  if (arrayEntries === "unreadable") {
    return schema;
  }
  if (arrayEntries) {
    let changed = false;
    const normalized = arrayEntries.map(([, entry]) => {
      const next = normalizeOpenAIStrictCompatSchemaRecursive(entry, {
        promoteEmptyObject: false,
      });
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const entries = readSchemaObjectEntries(schema);
  if (entries === "unreadable" || !entries) {
    return schema;
  }
  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const next = OPENAI_STRICT_COMPAT_SCHEMA_MAP_KEYS.has(key)
      ? normalizeOpenAIStrictCompatSchemaMap(value)
      : OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS.has(key)
        ? normalizeOpenAIStrictCompatSchemaRecursive(value, {
            promoteEmptyObject: false,
          })
        : value;
    normalized[key] = next;
    changed ||= next !== value;
  }

  if (Object.keys(normalized).length === 0) {
    if (!options.promoteEmptyObject) {
      return schema;
    }
    return {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
  }

  const hasObjectShapeHints =
    !("type" in normalized) &&
    ((normalized.properties &&
      typeof normalized.properties === "object" &&
      !Array.isArray(normalized.properties)) ||
      Array.isArray(normalized.required));
  if (hasObjectShapeHints) {
    normalized.type = "object";
    changed = true;
  }
  if (normalized.type === "object" && !("properties" in normalized)) {
    normalized.properties = {};
    changed = true;
  }

  const hasEmptyProperties =
    normalized.properties &&
    typeof normalized.properties === "object" &&
    !Array.isArray(normalized.properties) &&
    readSchemaObjectKeys(normalized.properties)?.length === 0;

  if (normalized.type === "object" && !Array.isArray(normalized.required) && hasEmptyProperties) {
    normalized.required = [];
    changed = true;
  }

  if (
    normalized.type === "object" &&
    hasEmptyProperties &&
    !("additionalProperties" in normalized)
  ) {
    normalized.additionalProperties = false;
    changed = true;
  }

  return changed ? normalized : schema;
}

/**
 * Finds schema paths that violate OpenAI strict tool-schema requirements.
 */
export function findOpenAIStrictSchemaViolations(
  /** JSON schema node to inspect recursively. */
  schema: unknown,
  /** Dot/bracket path prefix used in returned diagnostics. */
  path: string,
  /** Strictness controls for the current schema position. */
  options?: { requireObjectRoot?: boolean },
): string[] {
  const arrayEntries = readSchemaArrayEntries(schema);
  if (arrayEntries === "unreadable") {
    return [`${path} is unreadable`];
  }
  if (arrayEntries) {
    if (options?.requireObjectRoot) {
      return [`${path}.type`];
    }
    return arrayEntries.flatMap(([index, item]) =>
      findOpenAIStrictSchemaViolations(item, `${path}[${index}]`),
    );
  }
  if (!schema || typeof schema !== "object") {
    if (options?.requireObjectRoot) {
      return [`${path}.type`];
    }
    return [];
  }

  const entries = readSchemaObjectEntries(schema);
  if (entries === "unreadable" || !entries) {
    return [`${path} is unreadable`];
  }
  const violations: string[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(readSchemaField(schema, key))) {
      violations.push(`${path}.${key}`);
    }
  }
  if (Array.isArray(readSchemaField(schema, "type"))) {
    violations.push(`${path}.type`);
  }

  const type = readSchemaField(schema, "type");
  const additionalProperties = readSchemaField(schema, "additionalProperties");
  const requiredValue = readSchemaField(schema, "required");
  const propertyEntries = readSchemaObjectEntries(readSchemaField(schema, "properties"));

  if (type === "object") {
    if (additionalProperties !== false) {
      violations.push(`${path}.additionalProperties`);
    }
    const required = Array.isArray(requiredValue)
      ? requiredValue.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      violations.push(`${path}.required`);
    } else if (propertyEntries !== "unreadable" && propertyEntries) {
      const requiredSet = new Set(required);
      for (const [key] of propertyEntries) {
        if (!requiredSet.has(key)) {
          violations.push(`${path}.required.${key}`);
        }
      }
    }
  }

  if (propertyEntries === "unreadable") {
    violations.push(`${path}.properties is unreadable`);
  } else if (propertyEntries) {
    for (const [key, value] of propertyEntries) {
      violations.push(...findOpenAIStrictSchemaViolations(value, `${path}.properties.${key}`));
    }
  }

  for (const [key, value] of entries) {
    if (key === "properties") {
      continue;
    }
    if (value && typeof value === "object") {
      violations.push(...findOpenAIStrictSchemaViolations(value, `${path}.${key}`));
    }
  }

  return violations;
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
  const type = readSchemaField(schema, "type");
  if (type === "null") {
    return true;
  }
  if (Array.isArray(type) && type.length === 1 && type[0] === "null") {
    return true;
  }
  if (readSchemaField(schema, "const") === null) {
    return true;
  }
  const enumValues = readSchemaField(schema, "enum");
  return Array.isArray(enumValues) && enumValues.length === 1 && enumValues[0] === null;
}

function normalizeDeepSeekSchema(schema: unknown): unknown {
  const arrayEntries = readSchemaArrayEntries(schema);
  if (arrayEntries === "unreadable") {
    return schema;
  }
  if (arrayEntries) {
    let changed = false;
    const normalized = arrayEntries.map(([, entry]) => {
      const next = normalizeDeepSeekSchema(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const entries = readSchemaObjectEntries(schema);
  if (entries === "unreadable" || !entries) {
    return schema;
  }
  const anyOf = readSchemaField(schema, "anyOf");
  const oneOf = readSchemaField(schema, "oneOf");
  const unionKey = Array.isArray(anyOf) ? "anyOf" : Array.isArray(oneOf) ? "oneOf" : undefined;

  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (key === "anyOf" || key === "oneOf") {
      if (key === unionKey) {
        changed = true;
        continue;
      }
    }
    const next = normalizeDeepSeekSchema(value);
    normalized[key] = next;
    changed ||= next !== value;
  }

  if (!unionKey) {
    return changed ? normalized : schema;
  }

  const variantEntries = readSchemaArrayEntries(readSchemaField(schema, unionKey));
  if (variantEntries === "unreadable" || !variantEntries) {
    return schema;
  }
  const normalizedVariants = variantEntries.map(([, entry]) => normalizeDeepSeekSchema(entry));
  const nonNullVariants = normalizedVariants.filter((entry) => !isNullSchemaVariant(entry));
  const hasNullVariant = nonNullVariants.length < normalizedVariants.length;

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

  const selected = nonNullVariants[0] ?? normalizedVariants[0];
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    return normalized;
  }

  const merged = {
    ...(selected as Record<string, unknown>),
    ...normalized,
  };
  if (hasNullVariant) {
    merged.nullable = true;
  }
  return merged;
}

function isStringConstVariant(entry: unknown): entry is { const: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return typeof readSchemaField(entry, "const") === "string";
}

/**
 * Rewrites DeepSeek-incompatible union schemas into the closest accepted shape.
 */
export function normalizeDeepSeekToolSchemas(
  /** Provider tool-schema normalization context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    const parameters = normalizeDeepSeekSchema(tool.parameters);
    return parameters === tool.parameters
      ? tool
      : {
          ...tool,
          parameters: parameters as TSchema,
        };
  });
}

/**
 * Reports DeepSeek-incompatible union schema paths without mutating tool definitions.
 */
export function inspectDeepSeekToolSchemas(
  /** Provider tool-schema inspection context containing the active tool list. */
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const violations = findUnsupportedSchemaKeywords(
      tool.parameters,
      `${tool.name}.parameters`,
      DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS,
    );
    if (violations.length === 0) {
      return [];
    }
    return [{ toolName: tool.name, toolIndex, violations }];
  });
}

/**
 * Supported provider tool-schema compatibility families.
 */
export type ProviderToolCompatFamily = "deepseek" | "gemini" | "openai";

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
    case "openai":
      return {
        normalizeToolSchemas: normalizeOpenAIToolSchemas,
        inspectToolSchemas: inspectOpenAIToolSchemas,
      };
  }
  throw new Error("Unsupported provider tool compatibility family");
}
