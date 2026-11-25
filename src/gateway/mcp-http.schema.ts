import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { logWarn } from "../logger.js";
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

function flattenUnionSchema(
  raw: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  // MCP clients vary in union-schema support. Merge only safe object variants
  // and keep common required fields so generated forms remain usable.
  const variants = raw.anyOf ?? raw.oneOf;
  if (!Array.isArray(variants) || variants.length === 0) {
    return raw;
  }
  const mergedProps = Object.create(null) as Record<string, boolean | Record<string, unknown>>;
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
  const required =
    requiredSets.length > 0
      ? [...(requiredSets[0] ?? [])].filter(
          (key) => Object.hasOwn(mergedProps, key) && requiredSets.every((set) => set.has(key)),
        )
      : [];
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw;
  return { ...rest, type: "object", properties: mergedProps, required };
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
    if (raw.anyOf || raw.oneOf) {
      raw = flattenUnionSchema(raw, name);
    }
    if (raw.type !== "object") {
      raw.type = "object";
    }
    if (!raw.properties) {
      raw.properties = {};
    }
    return {
      name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: raw,
    };
  });
}
