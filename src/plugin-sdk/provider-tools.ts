import type { TSchema } from "typebox";
import {
  cleanSchemaForGemini,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
} from "../agents/schema/clean-for-gemini.js";
import { projectRuntimeToolInputSchema } from "../agents/tool-schema-projection.js";
import { stripUnsupportedSchemaKeywords } from "../shared/schema-keyword-strip.js";
import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderToolSchemaDiagnostic,
} from "./plugin-entry.js";

// Shared provider-tool helpers for plugin-owned schema compatibility rewrites.
export { cleanSchemaForGemini, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS, stripUnsupportedSchemaKeywords };

type ProviderToolSnapshot = {
  readonly entries: readonly {
    readonly source: AnyAgentTool;
    readonly name: string;
    readonly parameters: unknown;
    readonly originalIndex: number;
  }[];
  readonly tools: AnyAgentTool[];
  readonly diagnostics: ProviderToolSchemaDiagnostic[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unreadableProviderToolDiagnostic(toolIndex: number): ProviderToolSchemaDiagnostic {
  return {
    toolName: `tool[${toolIndex}]`,
    toolIndex,
    violations: [`tool[${toolIndex}] is unreadable`],
  };
}

function readProviderToolEntry(
  tools: readonly AnyAgentTool[],
  toolIndex: number,
): { ok: true; tool: unknown } | { ok: false } {
  try {
    return { ok: true, tool: Reflect.get(tools, String(toolIndex)) };
  } catch {
    return { ok: false };
  }
}

function readProviderToolField(
  tool: Record<string, unknown>,
  field: "name" | "parameters",
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: Reflect.get(tool, field) };
  } catch {
    return { ok: false };
  }
}

function providerNormalizableProjectionViolations(violations: readonly string[]): string[] {
  return violations.filter(
    (violation) => !violation.endsWith(".$dynamicRef") && !violation.endsWith(".$dynamicAnchor"),
  );
}

function cloneProviderToolWithParameters(
  source: AnyAgentTool,
  name: string,
  parameters: unknown,
): AnyAgentTool {
  const clone = Object.create(Object.getPrototypeOf(source)) as AnyAgentTool;
  const descriptors = Object.getOwnPropertyDescriptors(source);
  Reflect.deleteProperty(descriptors, "name");
  Reflect.deleteProperty(descriptors, "parameters");
  Object.defineProperties(clone, descriptors);
  Object.defineProperty(clone, "name", {
    configurable: true,
    enumerable: true,
    value: name,
    writable: true,
  });
  Object.defineProperty(clone, "parameters", {
    configurable: true,
    enumerable: true,
    value: parameters,
    writable: true,
  });
  return clone;
}

function replaceProviderToolParameters(
  entry: ProviderToolSnapshot["entries"][number],
  parameters: unknown,
): AnyAgentTool {
  return parameters === entry.parameters
    ? entry.source
    : cloneProviderToolWithParameters(entry.source, entry.name, parameters);
}

function snapshotProviderNormalizableTools(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSnapshot {
  let length: number;
  try {
    length = ctx.tools.length;
  } catch {
    return { entries: [], tools: [], diagnostics: [unreadableProviderToolDiagnostic(0)] };
  }

  const entries: ProviderToolSnapshot["entries"][number][] = [];
  const tools: AnyAgentTool[] = [];
  const diagnostics: ProviderToolSchemaDiagnostic[] = [];
  for (let toolIndex = 0; toolIndex < length; toolIndex += 1) {
    const entry = readProviderToolEntry(ctx.tools, toolIndex);
    if (!entry.ok || !isRecord(entry.tool)) {
      diagnostics.push(unreadableProviderToolDiagnostic(toolIndex));
      continue;
    }

    const name = readProviderToolField(entry.tool, "name");
    const toolName =
      name.ok && typeof name.value === "string" && name.value ? name.value : `tool[${toolIndex}]`;
    const descriptorViolations = name.ok ? [] : [`${toolName}.name is unreadable`];
    if (!name.ok || typeof name.value !== "string" || !name.value) {
      diagnostics.push({
        toolName,
        toolIndex,
        violations:
          descriptorViolations.length > 0
            ? descriptorViolations
            : [`${toolName}.name must be a non-empty string`],
      });
      continue;
    }

    const parameters = readProviderToolField(entry.tool, "parameters");
    if (!parameters.ok) {
      diagnostics.push({
        toolName,
        toolIndex,
        violations: [`${toolName}.parameters is unreadable`],
      });
      continue;
    }
    if (parameters.value === undefined) {
      const source = entry.tool as AnyAgentTool;
      entries.push({ source, name: toolName, parameters: undefined, originalIndex: toolIndex });
      tools.push(source);
      continue;
    }

    const schemaProjection = projectRuntimeToolInputSchema(
      parameters.value,
      `${toolName}.parameters`,
    );
    const violations = providerNormalizableProjectionViolations(schemaProjection.violations);
    if (violations.length > 0) {
      diagnostics.push({ toolName, toolIndex, violations });
      continue;
    }

    const source = entry.tool as AnyAgentTool;
    entries.push({
      source,
      name: toolName,
      parameters: schemaProjection.schema,
      originalIndex: toolIndex,
    });
    tools.push(source);
  }

  return { entries, tools, diagnostics };
}

export function findUnsupportedSchemaKeywords(
  schema: unknown,
  path: string,
  unsupportedKeywords: ReadonlySet<string>,
): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findUnsupportedSchemaKeywords(item, `${path}[${index}]`, unsupportedKeywords),
    );
  }
  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      violations.push(
        ...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`, unsupportedKeywords),
      );
    }
  }
  for (const [key, value] of Object.entries(record)) {
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

export function normalizeGeminiToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return snapshotProviderNormalizableTools(ctx).entries.map((entry) => {
    if (!entry.parameters || typeof entry.parameters !== "object") {
      return entry.source;
    }
    return replaceProviderToolParameters(entry, cleanSchemaForGemini(entry.parameters));
  });
}

export function inspectGeminiToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  const snapshot = snapshotProviderNormalizableTools(ctx);
  return [
    ...snapshot.diagnostics,
    ...snapshot.entries.flatMap(({ name, parameters, originalIndex }) => {
      const violations = findUnsupportedSchemaKeywords(
        parameters,
        `${name}.parameters`,
        GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
      );
      if (violations.length === 0) {
        return [];
      }
      return [{ toolName: name, toolIndex: originalIndex, violations }];
    }),
  ];
}

export function normalizeOpenAIToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  const snapshot = snapshotProviderNormalizableTools(ctx);
  if (!shouldApplyOpenAIToolCompat(ctx)) {
    return snapshot.diagnostics.length > 0 ? snapshot.tools : ctx.tools;
  }
  return snapshot.entries.map((entry) => {
    if (entry.parameters == null) {
      return replaceProviderToolParameters(entry, normalizeOpenAIStrictCompatSchema({}));
    }
    if (typeof entry.parameters !== "object") {
      return entry.source;
    }
    return replaceProviderToolParameters(
      entry,
      normalizeOpenAIStrictCompatSchema(entry.parameters),
    );
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
      return !baseUrl || isOpenAIResponsesBaseUrl(baseUrl);
    }
    return (
      api === "openai-chatgpt-responses" &&
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

function normalizeOpenAIStrictCompatSchemaMap(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
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
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
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

  const record = schema as Record<string, unknown>;
  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
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
    Object.keys(normalized.properties as Record<string, unknown>).length === 0;

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

export function findOpenAIStrictSchemaViolations(
  schema: unknown,
  path: string,
  options?: { requireObjectRoot?: boolean },
): string[] {
  if (Array.isArray(schema)) {
    if (options?.requireObjectRoot) {
      return [`${path}.type`];
    }
    return schema.flatMap((item, index) =>
      findOpenAIStrictSchemaViolations(item, `${path}[${index}]`),
    );
  }
  if (!schema || typeof schema !== "object") {
    if (options?.requireObjectRoot) {
      return [`${path}.type`];
    }
    return [];
  }

  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(record[key])) {
      violations.push(`${path}.${key}`);
    }
  }
  if (Array.isArray(record.type)) {
    violations.push(`${path}.type`);
  }

  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;

  if (record.type === "object") {
    if (record.additionalProperties !== false) {
      violations.push(`${path}.additionalProperties`);
    }
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      violations.push(`${path}.required`);
    } else if (properties) {
      const requiredSet = new Set(required);
      for (const key of Object.keys(properties)) {
        if (!requiredSet.has(key)) {
          violations.push(`${path}.required.${key}`);
        }
      }
    }
  }

  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      violations.push(...findOpenAIStrictSchemaViolations(value, `${path}.properties.${key}`));
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") {
      continue;
    }
    if (value && typeof value === "object") {
      violations.push(...findOpenAIStrictSchemaViolations(value, `${path}.${key}`));
    }
  }

  return violations;
}

export function inspectOpenAIToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  const snapshot = snapshotProviderNormalizableTools(ctx);
  // Native OpenAI transports fall back to `strict: false` when any tool schema is not
  // strict-compatible, so these findings are expected for optional-heavy tool schemas.
  return snapshot.diagnostics;
}

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
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeDeepSeekSchema(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  const unionKey = Array.isArray(record.anyOf)
    ? "anyOf"
    : Array.isArray(record.oneOf)
      ? "oneOf"
      : undefined;

  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
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

  const variants = record[unionKey] as unknown[];
  const normalizedVariants = variants.map((entry) => normalizeDeepSeekSchema(entry));
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
  const record = entry as Record<string, unknown>;
  return typeof record.const === "string";
}

export function normalizeDeepSeekToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return snapshotProviderNormalizableTools(ctx).entries.map((entry) => {
    if (!entry.parameters || typeof entry.parameters !== "object") {
      return entry.source;
    }
    return replaceProviderToolParameters(
      entry,
      normalizeDeepSeekSchema(entry.parameters) as TSchema,
    );
  });
}

export function inspectDeepSeekToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  const snapshot = snapshotProviderNormalizableTools(ctx);
  return [
    ...snapshot.diagnostics,
    ...snapshot.entries.flatMap(({ name, parameters, originalIndex }) => {
      const violations = findUnsupportedSchemaKeywords(
        parameters,
        `${name}.parameters`,
        DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS,
      );
      if (violations.length === 0) {
        return [];
      }
      return [{ toolName: name, toolIndex: originalIndex, violations }];
    }),
  ];
}

export type ProviderToolCompatFamily = "deepseek" | "gemini" | "openai";

export function buildProviderToolCompatFamilyHooks(family: ProviderToolCompatFamily): {
  normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => AnyAgentTool[];
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
