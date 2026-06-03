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

// Shared provider-tool helpers for plugin-owned schema compatibility rewrites.
export { cleanSchemaForGemini, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS, stripUnsupportedSchemaKeywords };

type ToolFieldRead<TField extends "name" | "parameters"> =
  | {
      readonly ok: true;
      readonly value: AnyAgentTool[TField];
    }
  | { readonly ok: false };

function readToolField<TField extends "name" | "parameters">(
  tool: AnyAgentTool,
  field: TField,
): ToolFieldRead<TField> {
  try {
    return { ok: true, value: tool[field] };
  } catch {
    return { ok: false };
  }
}

function readToolName(
  tool: AnyAgentTool,
  toolIndex: number,
): {
  readonly toolName: string;
  readonly violations: string[];
} {
  const nameRead = readToolField(tool, "name");
  const toolName =
    nameRead.ok && typeof nameRead.value === "string" && nameRead.value
      ? nameRead.value
      : `tool[${toolIndex}]`;
  return {
    toolName,
    violations: nameRead.ok ? [] : [`${toolName}.name is unreadable`],
  };
}

function readObjectEntries(
  value: object,
  path: string,
):
  | { readonly ok: true; readonly entries: [string, unknown][] }
  | {
      readonly ok: false;
      readonly violations: string[];
    } {
  try {
    return { ok: true, entries: Object.entries(value) };
  } catch {
    return { ok: false, violations: [`${path} is unreadable`] };
  }
}

function inspectSchemaArray(
  schema: readonly unknown[],
  path: string,
  inspect: (entry: unknown, path: string) => string[],
): string[] {
  let length: number;
  try {
    length = schema.length;
  } catch {
    return [`${path} is unreadable`];
  }
  const violations: string[] = [];
  for (let index = 0; index < length; index += 1) {
    let entry: unknown;
    try {
      entry = schema[index];
    } catch {
      violations.push(`${path}[${index}] is unreadable`);
      continue;
    }
    violations.push(...inspect(entry, `${path}[${index}]`));
  }
  return violations;
}

function findEntry(entries: readonly [string, unknown][], key: string): unknown {
  return entries.find(([entryKey]) => entryKey === key)?.[1];
}

function normalizeToolParameters(
  tool: AnyAgentTool,
  normalize: (parameters: unknown) => unknown,
): AnyAgentTool {
  const parametersRead = readToolField(tool, "parameters");
  if (!parametersRead.ok || !parametersRead.value || typeof parametersRead.value !== "object") {
    return tool;
  }
  let parameters: unknown;
  try {
    parameters = normalize(parametersRead.value);
  } catch {
    return tool;
  }
  return parameters === parametersRead.value
    ? tool
    : {
        ...tool,
        parameters: parameters as AnyAgentTool["parameters"],
      };
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
    return inspectSchemaArray(schema, path, (item, itemPath) =>
      findUnsupportedSchemaKeywords(item, itemPath, unsupportedKeywords),
    );
  }
  const entriesRead = readObjectEntries(schema, path);
  if (!entriesRead.ok) {
    return entriesRead.violations;
  }
  const violations: string[] = [];
  const propertiesValue = findEntry(entriesRead.entries, "properties");
  const properties =
    propertiesValue && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
      ? propertiesValue
      : undefined;
  if (properties) {
    const propertyEntriesRead = readObjectEntries(properties, `${path}.properties`);
    if (!propertyEntriesRead.ok) {
      violations.push(...propertyEntriesRead.violations);
    } else {
      for (const [key, value] of propertyEntriesRead.entries) {
        violations.push(
          ...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`, unsupportedKeywords),
        );
      }
    }
  }
  for (const [key, value] of entriesRead.entries) {
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
  return ctx.tools.map((tool) => normalizeToolParameters(tool, cleanSchemaForGemini));
}

export function inspectGeminiToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const { toolName, violations: descriptorViolations } = readToolName(tool, toolIndex);
    const parametersRead = readToolField(tool, "parameters");
    if (!parametersRead.ok) {
      return [
        {
          toolName,
          toolIndex,
          violations: [...descriptorViolations, `${toolName}.parameters is unreadable`],
        },
      ];
    }
    const violations = findUnsupportedSchemaKeywords(
      parametersRead.value,
      `${toolName}.parameters`,
      GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
    );
    const allViolations = [...descriptorViolations, ...violations];
    if (allViolations.length === 0) {
      return [];
    }
    return [{ toolName, toolIndex, violations: allViolations }];
  });
}

export function normalizeOpenAIToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  if (!shouldApplyOpenAIToolCompat(ctx)) {
    return ctx.tools;
  }
  return ctx.tools.map((tool) => {
    const parametersRead = readToolField(tool, "parameters");
    if (!parametersRead.ok) {
      return tool;
    }
    if (parametersRead.value == null) {
      return {
        ...tool,
        parameters: normalizeOpenAIStrictCompatSchema({}),
      };
    }
    if (typeof parametersRead.value !== "object") {
      return tool;
    }
    return normalizeToolParameters(tool, normalizeOpenAIStrictCompatSchema);
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
    return inspectSchemaArray(schema, path, (item, itemPath) =>
      findOpenAIStrictSchemaViolations(item, itemPath),
    );
  }
  if (!schema || typeof schema !== "object") {
    if (options?.requireObjectRoot) {
      return [`${path}.type`];
    }
    return [];
  }

  const entriesRead = readObjectEntries(schema, path);
  if (!entriesRead.ok) {
    return entriesRead.violations;
  }
  const violations: string[] = [];
  const anyOf = findEntry(entriesRead.entries, "anyOf");
  const oneOf = findEntry(entriesRead.entries, "oneOf");
  const allOf = findEntry(entriesRead.entries, "allOf");
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const value = key === "anyOf" ? anyOf : key === "oneOf" ? oneOf : allOf;
    if (Array.isArray(value)) {
      violations.push(`${path}.${key}`);
    }
  }
  const typeValue = findEntry(entriesRead.entries, "type");
  if (Array.isArray(typeValue)) {
    violations.push(`${path}.type`);
  }

  const propertiesValue = findEntry(entriesRead.entries, "properties");
  const properties =
    propertiesValue && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
      ? propertiesValue
      : undefined;

  if (typeValue === "object") {
    if (findEntry(entriesRead.entries, "additionalProperties") !== false) {
      violations.push(`${path}.additionalProperties`);
    }
    const requiredValue = findEntry(entriesRead.entries, "required");
    const required = Array.isArray(requiredValue)
      ? requiredValue.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      violations.push(`${path}.required`);
    } else if (properties) {
      const requiredSet = new Set(required);
      const propertyEntriesRead = readObjectEntries(properties, `${path}.properties`);
      if (!propertyEntriesRead.ok) {
        violations.push(...propertyEntriesRead.violations);
      } else {
        for (const [key] of propertyEntriesRead.entries) {
          if (!requiredSet.has(key)) {
            violations.push(`${path}.required.${key}`);
          }
        }
      }
    }
  }

  if (properties) {
    const propertyEntriesRead = readObjectEntries(properties, `${path}.properties`);
    if (!propertyEntriesRead.ok) {
      violations.push(...propertyEntriesRead.violations);
    } else {
      for (const [key, value] of propertyEntriesRead.entries) {
        violations.push(...findOpenAIStrictSchemaViolations(value, `${path}.properties.${key}`));
      }
    }
  }

  for (const [key, value] of entriesRead.entries) {
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
  if (!shouldApplyOpenAIToolCompat(ctx)) {
    return [];
  }
  const diagnostics: ProviderToolSchemaDiagnostic[] = [];
  for (const [toolIndex, tool] of ctx.tools.entries()) {
    const { toolName, violations } = readToolName(tool, toolIndex);
    const parametersRead = readToolField(tool, "parameters");
    if (!parametersRead.ok) {
      diagnostics.push({
        toolName,
        toolIndex,
        violations: [...violations, `${toolName}.parameters is unreadable`],
      });
    }
  }
  if (diagnostics.length > 0) {
    return diagnostics;
  }
  // Native OpenAI transports fall back to `strict: false` when any tool schema is not
  // strict-compatible, so these findings are expected for optional-heavy tool schemas.
  return [];
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
  return ctx.tools.map((tool) => normalizeToolParameters(tool, normalizeDeepSeekSchema));
}

export function inspectDeepSeekToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const { toolName, violations: descriptorViolations } = readToolName(tool, toolIndex);
    const parametersRead = readToolField(tool, "parameters");
    if (!parametersRead.ok) {
      return [
        {
          toolName,
          toolIndex,
          violations: [...descriptorViolations, `${toolName}.parameters is unreadable`],
        },
      ];
    }
    const violations = findUnsupportedSchemaKeywords(
      parametersRead.value,
      `${toolName}.parameters`,
      DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS,
    );
    const allViolations = [...descriptorViolations, ...violations];
    if (allViolations.length === 0) {
      return [];
    }
    return [{ toolName, toolIndex, violations: allViolations }];
  });
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
