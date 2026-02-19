/**
 * Tool Bridge — converts MCP tool schemas to OpenClaw AgentTool format.
 *
 * Handles:
 * - JSON Schema → TypeBox schema conversion
 * - Tool naming with mcp_{server}_{tool} prefix
 * - Execute wrapper routing calls through MCP client
 * - Untrusted content wrapping for all results
 * - Graceful error handling (no crashes)
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TSchema } from "@sinclair/typebox";
import type { McpClientBase, McpToolInfo } from "./client-base.js";
import { logWarn } from "../logger.js";
import { wrapExternalContent, detectSuspiciousPatterns } from "../security/external-content.js";

// Re-export for convenience
export type { McpToolInfo } from "./client-base.js";

type AnyAgentTool = AgentTool<any, unknown>;

/**
 * Convert an MCP tool's JSON Schema (inputSchema) to a TypeBox TSchema
 * suitable for OpenClaw AgentTool parameters.
 */
export function convertMcpSchema(jsonSchema: Record<string, unknown>): TSchema {
  if (!jsonSchema || jsonSchema.type !== "object") {
    return Type.Object({});
  }

  const properties = (jsonSchema.properties ?? {}) as Record<string, any>;
  const required = new Set((jsonSchema.required ?? []) as string[]);
  const tbProperties: Record<string, TSchema> = {};

  for (const [key, prop] of Object.entries(properties)) {
    tbProperties[key] = convertPropertySchema(prop, required.has(key));
  }

  return Type.Object(tbProperties);
}

function convertPropertySchema(prop: any, isRequired: boolean): TSchema {
  const desc = prop.description as string | undefined;

  const base = (() => {
    switch (prop.type) {
      case "string":
        if (prop.enum && Array.isArray(prop.enum)) {
          return Type.Union(prop.enum.map((v: string) => Type.Literal(v)));
        }
        return Type.String();
      case "number":
      case "integer":
        return Type.Number();
      case "boolean":
        return Type.Boolean();
      case "array":
        return Type.Array(prop.items ? convertPropertySchema(prop.items, true) : Type.Unknown());
      case "object":
        if (prop.properties) {
          const nested: Record<string, TSchema> = {};
          const nestedRequired = new Set((prop.required ?? []) as string[]);
          for (const [k, v] of Object.entries(prop.properties as Record<string, any>)) {
            nested[k] = convertPropertySchema(v, nestedRequired.has(k));
          }
          return Type.Object(nested);
        }
        return Type.Record(Type.String(), Type.Unknown());
      default:
        return Type.Unknown();
    }
  })();

  // Add description if present
  const withDesc = desc ? { ...base, description: desc } : base;
  return isRequired ? withDesc : Type.Optional(withDesc);
}

/**
 * Bridge a single MCP tool into an OpenClaw AgentTool.
 *
 * The resulting tool:
 * - Has a prefixed name: mcp_{prefix}_{toolName}
 * - Routes execute() calls through the MCP client's callTool()
 * - Wraps all results as untrusted external content
 * - Catches all errors and returns them as tool results (never throws)
 */
export function bridgeMcpTool(
  client: McpClientBase,
  mcpTool: McpToolInfo,
  serverName: string,
  prefix?: string,
): AnyAgentTool {
  const toolPrefix = prefix ?? serverName;
  const toolName = `mcp_${toolPrefix}_${mcpTool.name}`;

  return {
    name: toolName,
    label: `MCP: ${serverName}/${mcpTool.name}`,
    description: `[MCP server: ${serverName}] ${mcpTool.description ?? "No description"}`,
    parameters: convertMcpSchema(mcpTool.inputSchema ?? {}),

    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> => {
      try {
        const result = await client.callTool(mcpTool.name, params);

        // Process content items
        const textParts: string[] = [];
        for (const item of result.content ?? []) {
          if (item.type === "text" && item.text) {
            textParts.push(item.text);
          } else if (item.type === "image") {
            textParts.push(`[Image: ${item.mimeType ?? "unknown"}]`);
          }
        }

        const rawText = textParts.join("\n");

        // SECURITY: Check for prompt injection patterns
        const suspicious = detectSuspiciousPatterns(rawText);
        if (suspicious.length > 0) {
          logWarn(
            `MCP server '${serverName}' tool '${mcpTool.name}' returned suspicious patterns: ${suspicious.join(", ")}`,
          );
        }

        // SECURITY: Wrap as untrusted external content
        const wrappedText = wrapExternalContent(rawText, {
          source: "mcp_server",
          sender: serverName,
          includeWarning: true,
        });

        return {
          content: [{ type: "text" as const, text: wrappedText }],
          details: {
            externalContent: {
              untrusted: true,
              source: "mcp_server",
              server: serverName,
              tool: mcpTool.name,
              wrapped: true,
            },
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `MCP tool error (${serverName}/${mcpTool.name}): ${message}`,
            },
          ],
          details: { error: true },
        };
      }
    },
  };
}

/**
 * Bridge all tools from an MCP client into OpenClaw AgentTools.
 */
export function bridgeAllTools(
  client: McpClientBase,
  serverName: string,
  prefix?: string,
): AnyAgentTool[] {
  return client.getDiscoveredTools().map((tool) => bridgeMcpTool(client, tool, serverName, prefix));
}
