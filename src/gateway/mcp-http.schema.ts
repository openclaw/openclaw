import { logWarn } from "../logger.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

export type McpLoopbackTool = ReturnType<typeof resolveGatewayScopedTools>["tools"][number];

/**
 * Tool-level `_meta.ui` metadata per MCP Apps spec (SEP-1865).
 * Only `resourceUri` and `visibility` belong on the tool; CSP/permissions
 * live in the resource-level metadata returned by `resources/read`.
 */
export type McpToolUiMeta = {
  resourceUri: string;
  visibility?: Array<"model" | "app">;
};

export type McpToolSchemaEntry = {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
  _meta?: {
    ui?: McpToolUiMeta;
  };
};

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
        if (Array.isArray(existing.enum) && Array.isArray(incoming.enum)) {
          mergedProps[key] = {
            ...existing,
            enum: [...new Set([...(existing.enum as unknown[]), ...(incoming.enum as unknown[])])],
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
      ? [...(requiredSets[0] ?? [])].filter((key) => requiredSets.every((set) => set.has(key)))
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
    const entry: McpToolSchemaEntry = {
      name: tool.name,
      description: tool.description,
      inputSchema: raw,
    };
    const mcpAppUi = (
      tool as unknown as {
        mcpAppUi?: { resourceUri?: string; visibility?: Array<"model" | "app"> };
      }
    ).mcpAppUi;
    if (mcpAppUi?.resourceUri) {
      const ui: McpToolUiMeta = { resourceUri: mcpAppUi.resourceUri };
      if (mcpAppUi.visibility) {
        ui.visibility = mcpAppUi.visibility;
      }
      entry._meta = { ui };
    }
    return entry;
  });
}

/**
 * Filter tool schema entries by caller role per MCP Apps visibility rules.
 *
 * - `"model"` → exclude tools with `visibility: ["app"]` (app-only tools)
 * - `"app"`   → exclude tools with `visibility: ["model"]` (model-only tools)
 * - `undefined` → no filtering, return all tools (backward-compatible default)
 *
 * Tools without `_meta.ui.visibility` or with `visibility: ["model", "app"]`
 * are always included.
 */
export function filterToolSchemaByVisibility(
  tools: McpToolSchemaEntry[],
  callerRole: "model" | "app" | undefined,
): McpToolSchemaEntry[] {
  if (!callerRole) {
    return tools;
  }
  return tools.filter((tool) => {
    const visibility = tool._meta?.ui?.visibility;
    if (!visibility || visibility.length === 0) {
      return true; // default: visible to both
    }
    return visibility.includes(callerRole);
  });
}

/**
 * Check whether a specific tool is callable by the given caller role.
 * Returns `true` when the tool is accessible, `false` when visibility
 * rules block the caller.
 */
export function isToolVisibleTo(
  tool: McpToolSchemaEntry,
  callerRole: "model" | "app" | undefined,
): boolean {
  if (!callerRole) {
    return true;
  }
  const visibility = tool._meta?.ui?.visibility;
  if (!visibility || visibility.length === 0) {
    return true;
  }
  return visibility.includes(callerRole);
}
