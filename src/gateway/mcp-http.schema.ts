import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { logWarn } from "../logger.js";
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

// MCP clients vary in union-schema support. Merge only safe object variants and
// report the ones that cannot merge, so generated forms stay usable and a lost
// constraint is never silent. Returns one required-key set per merged variant.
function mergeVariantsIntoProperties(
  variants: readonly unknown[],
  toolName: string,
  mergedProps: Record<string, boolean | Record<string, unknown>>,
): Set<string>[] {
  const requiredSets: Set<string>[] = [];
  for (const variant of variants) {
    if (variant === true) {
      requiredSets.push(new Set());
      continue;
    }
    if (!isRecord(variant)) {
      continue;
    }
    const props = isRecord(variant.properties) ? variant.properties : undefined;
    if (props) {
      for (const [key, schema] of Object.entries(props)) {
        if (!isPropertySchema(schema)) {
          warnSchemaOnce(
            `${MCP_LOOPBACK_LOG_PREFIX}: malformed schema definition for "${toolName}.${key}", ignoring that variant`,
          );
          continue;
        }
        if (!Object.hasOwn(mergedProps, key)) {
          mergedProps[key] = schema;
          continue;
        }
        const existing = mergedProps[key]!;
        if (existing === true || schema === true) {
          mergedProps[key] = true;
          continue;
        }
        if (existing === false) {
          mergedProps[key] = schema;
          continue;
        }
        if (schema === false) {
          continue;
        }
        if (isDeepStrictEqual(existing, schema, { skipPrototype: true })) {
          continue;
        }
        // A prior const merge becomes an enum. Treat both as one literal family
        // so later union variants cannot silently disappear based on ordering.
        const mergedLiterals = mergeLiteralSchemas(existing, schema);
        if (mergedLiterals) {
          mergedProps[key] = mergedLiterals;
          continue;
        }
        warnSchemaOnce(
          `${MCP_LOOPBACK_LOG_PREFIX}: conflicting schema definitions for "${toolName}.${key}", keeping the first variant`,
        );
      }
    }
    requiredSets.push(
      new Set(Array.isArray(variant.required) ? (variant.required as string[]) : []),
    );
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

// Root properties, each allOf branch, and each sibling union keyword all hold
// at once, so a key constrained differently on both sides of such a boundary
// cannot be merged without weakening one constraint. Alternatives within one
// keyword stay on the keep-first-and-warn contract instead.
function combineConjunctiveProps(
  target: Record<string, boolean | Record<string, unknown>>,
  source: Record<string, boolean | Record<string, unknown>>,
  toolName: string,
): boolean {
  for (const [key, schema] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) {
      target[key] = schema;
      continue;
    }
    if (isDeepStrictEqual(target[key], schema, { skipPrototype: true })) {
      continue;
    }
    warnSchemaOnce(
      `${MCP_LOOPBACK_LOG_PREFIX}: tool "${toolName}" input schema constrains "${key}" differently across combined top-level schemas; skipping the tool instead of publishing a weakened constraint`,
    );
    return false;
  }
  return true;
}

// Collapses every top-level union keyword into the single object schema native
// tool definitions require. `anyOf`/`oneOf` branches are alternatives, so only a
// key required by every branch stays required; `allOf` branches all hold, so
// their required keys are added. Sibling `properties`/`required` on the root are
// kept rather than replaced, and an empty union list is reported instead of
// being left in place for the provider to reject. Returns undefined when a
// conjunctive overlap makes every flattening lossy; the caller skips the tool.
function flattenTopLevelUnionSchema(
  raw: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> | undefined {
  const mergedProps = Object.create(null) as Record<string, boolean | Record<string, unknown>>;
  if (isRecord(raw.properties)) {
    for (const [key, schema] of Object.entries(raw.properties)) {
      if (isPropertySchema(schema)) {
        mergedProps[key] = schema;
      }
    }
  }
  // SAFETY: JSON Schema `required` is a string list; this mirrors the variant read above.
  const required = new Set<string>(Array.isArray(raw.required) ? (raw.required as string[]) : []);
  for (const keyword of TOOL_INPUT_SCHEMA_TOP_LEVEL_UNION_KEYWORDS) {
    const variants = readSchemaVariants(raw[keyword]);
    if (!variants || variants.length > 0) {
      continue;
    }
    warnSchemaOnce(
      `${MCP_LOOPBACK_LOG_PREFIX}: dropping empty top-level "${keyword}" for "${toolName}", native tool schemas reject it`,
    );
  }
  // Sibling anyOf and oneOf apply together, so each keyword's alternatives decide
  // their own required keys instead of pooling branches into one alternative set.
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = readSchemaVariants(raw[keyword]) ?? [];
    if (alternatives.length === 0) {
      continue;
    }
    // SAFETY: fresh null-prototype map; mergeVariantsIntoProperties validates every entry.
    const groupProps = Object.create(null) as Record<string, boolean | Record<string, unknown>>;
    const requiredSets = mergeVariantsIntoProperties(alternatives, toolName, groupProps);
    if (!combineConjunctiveProps(mergedProps, groupProps, toolName)) {
      return undefined;
    }
    for (const key of requiredSets[0] ?? []) {
      if (requiredSets.every((set) => set.has(key))) {
        required.add(key);
      }
    }
  }
  for (const branch of readSchemaVariants(raw.allOf) ?? []) {
    // SAFETY: fresh null-prototype map; mergeVariantsIntoProperties validates every entry.
    const branchProps = Object.create(null) as Record<string, boolean | Record<string, unknown>>;
    const requiredSets = mergeVariantsIntoProperties([branch], toolName, branchProps);
    if (!combineConjunctiveProps(mergedProps, branchProps, toolName)) {
      return undefined;
    }
    for (const set of requiredSets) {
      for (const key of set) {
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

// Deduplicate by tool, field, and reason across per-session schema cache misses.
// Tool metadata stays stable until restart or explicit reload.
const emittedSchemaWarnings = new Set<string>();

function warnSchemaOnce(message: string) {
  if (emittedSchemaWarnings.has(message)) {
    return;
  }
  emittedSchemaWarnings.add(message);
  logWarn(message);
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
      const flattened = flattenTopLevelUnionSchema(raw, name);
      if (!flattened) {
        // A conjunctive overlap means no single object schema can keep every
        // constraint. Skip the tool with the warning above instead of failing
        // the whole catalog build mid run preparation.
        return [];
      }
      raw = flattened;
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
