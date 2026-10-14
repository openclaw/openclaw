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

function readLoopbackToolField(tool: McpLoopbackTool, key: "name" | "description" | "parameters") {
  try {
    return tool[key];
  } catch {
    return undefined;
  }
}

export function readMcpLoopbackToolName(tool: McpLoopbackTool): string | undefined {
  return normalizeOptionalString(readLoopbackToolField(tool, "name"));
}

function readLoopbackToolDescription(tool: McpLoopbackTool): string | undefined {
  const value = readLoopbackToolField(tool, "description");
  return typeof value === "string" ? value : undefined;
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
        if (areSchemaValuesEquivalent(existing, schema)) {
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

function rememberSchemaPair(
  left: object,
  right: object,
  seen: WeakMap<object, WeakSet<object>>,
): boolean {
  const existing = seen.get(left);
  if (existing?.has(right)) {
    return true;
  }
  const next = existing ?? new WeakSet<object>();
  next.add(right);
  if (!existing) {
    seen.set(left, next);
  }
  return false;
}

function areSchemaValuesEquivalent(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    if (rememberSchemaPair(left, right, seen)) {
      return true;
    }
    return left.every((value, index) => areSchemaValuesEquivalent(value, right[index], seen));
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  if (rememberSchemaPair(left, right, seen)) {
    return true;
  }
  const leftKeys = Object.keys(left).toSorted();
  const rightKeys = Object.keys(right).toSorted();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] && areSchemaValuesEquivalent(left[key], right[key], seen),
  );
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
      description: readLoopbackToolDescription(tool),
      inputSchema: raw,
    };
  });
}
