import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  findToolInputSchemaTopLevelUnionError,
  TOOL_INPUT_SCHEMA_TOP_LEVEL_UNION_KEYWORDS,
} from "../shared/json-schema-defaults.js";
import { mergeLiteralSchemas } from "../shared/json-schema-literals.js";
import type { resolveGatewayScopedTools } from "./tool-resolution.js";

const MCP_LOOPBACK_LOG_PREFIX = "mcp-loopback";

export type McpLoopbackTool = Awaited<
  ReturnType<typeof resolveGatewayScopedTools>
>["tools"][number];

export type McpToolSchemaEntry = {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
};

export function readMcpLoopbackToolName(tool: McpLoopbackTool): string | undefined {
  return normalizeOptionalString(tool.name);
}

function readLoopbackToolParameters(tool: McpLoopbackTool): Record<string, unknown> | undefined {
  let value;
  try {
    value = tool.parameters;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return {};
  }
  try {
    return { ...value };
  } catch {
    return undefined;
  }
}

// MCP clients vary in union-schema support. This receives only prevalidated
// alternative branches, so merging cannot silently lose a constraint. Returns
// one required-key set per merged variant.
function mergeVariantsIntoProperties(
  variants: readonly unknown[],
  mergedProps: Record<string, boolean | Record<string, unknown>>,
): Set<string>[] {
  const requiredSets: Set<string>[] = [];
  for (const variant of variants) {
    const safeVariant = readSafeObjectVariant(variant)!;
    for (const [key, schema] of Object.entries(safeVariant.properties)) {
      if (!Object.hasOwn(mergedProps, key)) {
        mergedProps[key] = schema;
        continue;
      }
      const existing = mergedProps[key]!;
      if (existing === true || schema === true) {
        mergedProps[key] = true;
      } else if (existing === false) {
        mergedProps[key] = schema;
      } else if (
        schema !== false &&
        !isDeepStrictEqual(existing, schema, { skipPrototype: true })
      ) {
        mergedProps[key] = mergeLiteralSchemas(existing, schema)!;
      }
    }
    requiredSets.push(new Set(safeVariant.required));
  }
  return requiredSets;
}

function readSchemaVariants(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function hasTopLevelUnion(schema: Record<string, unknown>): boolean {
  return TOOL_INPUT_SCHEMA_TOP_LEVEL_UNION_KEYWORDS.some((keyword) =>
    Object.hasOwn(schema, keyword),
  );
}

function readObjectProperties(
  value: unknown,
): Record<string, boolean | Record<string, unknown>> | undefined {
  if (value === undefined) {
    // SAFETY: this null-prototype map is populated only with schemas validated below.
    return Object.create(null) as Record<string, boolean | Record<string, unknown>>;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  // SAFETY: entries are accepted only after isPropertySchema validates each value.
  const properties = Object.create(null) as Record<string, boolean | Record<string, unknown>>;
  for (const [key, schema] of Object.entries(value)) {
    if (!isPropertySchema(schema)) {
      return undefined;
    }
    properties[key] = schema;
  }
  return properties;
}

function isRequiredKeyList(value: unknown): value is string[] | undefined {
  return (
    value === undefined || (Array.isArray(value) && value.every((key) => typeof key === "string"))
  );
}

function readSafeObjectVariant(
  value: unknown,
):
  | { properties: Record<string, boolean | Record<string, unknown>>; required: string[] }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    Object.keys(value).some(
      (key) => key !== "type" && key !== "properties" && key !== "required",
    ) ||
    (value.type !== undefined && value.type !== "object") ||
    !isRequiredKeyList(value.required)
  ) {
    return undefined;
  }
  const properties = readObjectProperties(value.properties);
  return properties ? { properties, required: value.required ?? [] } : undefined;
}

function canMergeAlternativeProperties(
  variants: readonly unknown[],
  rootProperties: Record<string, boolean | Record<string, unknown>>,
): boolean {
  const merged = Object.create(null) as Record<string, boolean | Record<string, unknown>>;
  for (const variant of variants) {
    const safeVariant = readSafeObjectVariant(variant);
    if (!safeVariant) {
      return false;
    }
    for (const [key, schema] of Object.entries(safeVariant.properties)) {
      if (Object.hasOwn(rootProperties, key)) {
        return false;
      }
      const existing = merged[key];
      if (existing === undefined || isDeepStrictEqual(existing, schema, { skipPrototype: true })) {
        merged[key] = schema;
      } else if (existing === true || schema === true) {
        merged[key] = true;
      } else if (existing === false) {
        merged[key] = schema;
      } else if (schema === false) {
        continue;
      } else if (!mergeLiteralSchemas(existing, schema)) {
        return false;
      }
    }
  }
  return true;
}

function canMergeAllOfProperties(
  variants: readonly unknown[],
  rootProperties: Record<string, boolean | Record<string, unknown>>,
): boolean {
  const seen = new Set(Object.keys(rootProperties));
  return variants.every((variant) => {
    const safeVariant = readSafeObjectVariant(variant);
    if (!safeVariant) {
      return false;
    }
    return Object.keys(safeVariant.properties).every((key) => {
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  });
}

// Native tool definitions cannot contain root unions. Flatten only one known
// object composition when its properties can be copied without weakening a
// constraint; otherwise leave it intact for the named publish-boundary error.
function flattenTopLevelUnionSchema(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const keywords = TOOL_INPUT_SCHEMA_TOP_LEVEL_UNION_KEYWORDS.filter((keyword) =>
    Object.hasOwn(raw, keyword),
  );
  if (keywords.length !== 1) {
    return undefined;
  }
  const keyword = keywords[0]!;
  const variants = readSchemaVariants(raw[keyword]);
  const rootProperties = readObjectProperties(raw.properties);
  if (!variants || variants.length === 0 || !rootProperties) {
    return undefined;
  }
  if (
    (keyword === "allOf" && !canMergeAllOfProperties(variants, rootProperties)) ||
    (keyword !== "allOf" && !canMergeAlternativeProperties(variants, rootProperties))
  ) {
    return undefined;
  }
  const mergedProps = { ...rootProperties };
  // SAFETY: JSON Schema `required` is a string list; this mirrors the variant read above.
  const required = new Set<string>(Array.isArray(raw.required) ? (raw.required as string[]) : []);
  const requiredSets = mergeVariantsIntoProperties(variants, mergedProps);
  for (const set of requiredSets) {
    for (const key of set) {
      if (keyword === "allOf" || requiredSets.every((candidate) => candidate.has(key))) {
        required.add(key);
      }
    }
  }
  const { allOf: _allOf, anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw;
  return {
    ...rest,
    type: "object",
    properties: mergedProps,
    required: [...required].filter((key) => Object.hasOwn(mergedProps, key)),
  };
}

function isPropertySchema(value: unknown): value is boolean | Record<string, unknown> {
  return typeof value === "boolean" || isRecord(value);
}

export function buildMcpToolSchema(tools: McpLoopbackTool[]): McpToolSchemaEntry[] {
  return tools.flatMap((tool) => {
    const name = readMcpLoopbackToolName(tool);
    if (!name) {
      return [];
    }
    let raw = readLoopbackToolParameters(tool);
    if (!raw) {
      return [];
    }
    if (hasTopLevelUnion(raw)) {
      raw = flattenTopLevelUnionSchema(raw) ?? raw;
    }
    if (raw.type !== "object") {
      raw.type = "object";
    }
    if (!raw.properties) {
      raw.properties = {};
    }
    // Publish-boundary invariant: the flatten above removes every top-level union
    // keyword, and a schema carrying one past this point is rejected by native
    // tool definitions as an opaque request-wide 400 that names only a tool index.
    // Fail here, where the tool is named, rather than at the provider.
    const unionError = findToolInputSchemaTopLevelUnionError(raw, name);
    if (unionError) {
      throw new Error(`${MCP_LOOPBACK_LOG_PREFIX}: ${unionError}`);
    }
    return {
      name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: raw,
    };
  });
}
