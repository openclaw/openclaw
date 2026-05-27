import { logWarn } from "../logger.js";
import { isRecord } from "../shared/record-coerce.js";
import { uniqueValues } from "../shared/string-normalization.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

export type McpLoopbackTool = ReturnType<typeof resolveGatewayScopedTools>["tools"][number];

export type McpToolSchemaEntry = {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
};

function flattenUnionSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const variants = (raw.anyOf ?? raw.oneOf) as unknown[] | undefined;
  if (!Array.isArray(variants) || variants.length === 0) {
    return raw;
  }
  const mergedProps: Record<string, unknown> = {};
  const requiredSets: Set<string>[] = [];
  for (const variant of variants) {
    if (variant === false) {
      continue;
    }
    if (!isRecord(variant)) {
      if (variant !== true) {
        logWarn("mcp loopback: malformed union variant, treating it as unconstrained");
      }
      requiredSets.push(new Set());
      continue;
    }
    const props = isRecord(variant.properties) ? variant.properties : undefined;
    if (props) {
      for (const [key, schema] of Object.entries(props)) {
        if (!isPropertySchema(schema)) {
          logWarn(`mcp loopback: malformed schema definition for "${key}", ignoring that variant`);
          continue;
        }
        if (!(key in mergedProps)) {
          mergedProps[key] = schema;
          continue;
        }
        const existing = mergedProps[key];
        const incoming = schema;
        if (!isRecord(existing) || !isRecord(incoming)) {
          if (existing !== incoming) {
            logWarn(
              `mcp loopback: conflicting schema definitions for "${key}", keeping the first variant`,
            );
          }
          continue;
        }
        if (Array.isArray(existing.enum) && Array.isArray(incoming.enum)) {
          mergedProps[key] = {
            ...existing,
            enum: uniqueValues([...(existing.enum as unknown[]), ...(incoming.enum as unknown[])]),
          };
          continue;
        }
        if ("const" in existing && "const" in incoming && existing.const !== incoming.const) {
          const merged: Record<string, unknown> = {
            ...existing,
            enum: [existing.const, incoming.const],
          };
          delete merged.const;
          mergedProps[key] = merged;
          continue;
        }
        logWarn(
          `mcp loopback: conflicting schema definitions for "${key}", keeping the first variant`,
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
          (key) => key in mergedProps && requiredSets.every((set) => set.has(key)),
        )
      : [];
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw;
  return { ...rest, type: "object", properties: mergedProps, required };
}

function isPropertySchema(value: unknown): value is boolean | Record<string, unknown> {
  return typeof value === "boolean" || isRecord(value);
}

export function buildMcpToolSchema(tools: McpLoopbackTool[]): McpToolSchemaEntry[] {
  return tools.map((tool) => {
    let raw =
      tool.parameters && typeof tool.parameters === "object"
        ? { ...(tool.parameters as Record<string, unknown>) }
        : {};
    if (raw.anyOf || raw.oneOf) {
      raw = flattenUnionSchema(raw);
    }
    if (raw.type !== "object") {
      raw.type = "object";
    }
    if (!raw.properties) {
      raw.properties = {};
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: raw,
    };
  });
}
