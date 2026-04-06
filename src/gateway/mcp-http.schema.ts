import { logWarn } from "../logger.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

export type McpLoopbackTool = ReturnType<typeof resolveGatewayScopedTools>["tools"][number];

export type McpToolSchemaEntry = {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
};

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    return record.enum;
  }
  if ("const" in record) {
    return [record.const];
  }
  const variants = Array.isArray(record.anyOf)
    ? record.anyOf
    : Array.isArray(record.oneOf)
      ? record.oneOf
      : null;
  if (!variants) {
    return undefined;
  }
  const values = variants.flatMap((variant) => extractEnumValues(variant) ?? []);
  return values.length > 0 ? values : undefined;
}

function mergeEnumLikePropertySchema(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const existingEnum = extractEnumValues(existing);
  const incomingEnum = extractEnumValues(incoming);
  if (!existingEnum && !incomingEnum) {
    return undefined;
  }

  const merged: Record<string, unknown> = {};
  for (const source of [existing, incoming]) {
    for (const key of ["title", "description", "default"]) {
      if (!(key in merged) && key in source) {
        merged[key] = source[key];
      }
    }
  }

  const values = [...new Set([...(existingEnum ?? []), ...(incomingEnum ?? [])])];
  const valueTypes = new Set(
    values.map((value) => {
      if (value === null) {
        return "null";
      }
      if (Array.isArray(value)) {
        return "array";
      }
      return typeof value;
    }),
  );
  if (valueTypes.size === 1) {
    merged.type = [...valueTypes][0];
  }
  merged.enum = values;
  return merged;
}

function flattenUnionSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const variants = (raw.anyOf ?? raw.oneOf) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(variants) || variants.length === 0) {
    return raw;
  }
  const mergedProps: Record<string, unknown> = {};
  const requiredSets: Set<string>[] = [];
  for (const variant of variants) {
    const props = variant.properties as Record<string, unknown> | undefined;
    if (props) {
      for (const [key, schema] of Object.entries(props)) {
        if (!(key in mergedProps)) {
          mergedProps[key] = schema;
          continue;
        }
        const existing = mergedProps[key] as Record<string, unknown>;
        const incoming = schema as Record<string, unknown>;
        const mergedEnumLike = mergeEnumLikePropertySchema(existing, incoming);
        if (mergedEnumLike) {
          mergedProps[key] = mergedEnumLike;
          continue;
        }
        if (JSON.stringify(existing) === JSON.stringify(incoming)) {
          continue;
        }
        // Same base type with different description/metadata — compatible, keep first.
        if (existing.type && existing.type === incoming.type) {
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
      ? [
          ...requiredSets.reduce(
            (left, right) => new Set([...left].filter((key) => right.has(key))),
          ),
        ]
      : [];
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw;
  return { ...rest, type: "object", properties: mergedProps, required };
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
      if (!raw.properties) {
        raw.properties = {};
      }
    }
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: raw,
    };
  });
}
