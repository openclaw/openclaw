/**
 * MCP tool bridge — converts MCP server tools into OpenClaw AgentTool objects.
 *
 * Takes McpServerConnection instances and wraps their remote tools so they
 * appear as native tools to the agent. Handles:
 * - JSON Schema → TypeBox schema conversion for tool parameters
 * - Tool name prefixing to avoid collisions between servers
 * - MCP content type mapping to AgentToolResult content blocks
 * - Error wrapping for failed or timed-out calls
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TObject, type TProperties, type TSchema } from "@sinclair/typebox";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { defaultRuntime } from "../runtime.js";
import { requiresMcpApproval, getMcpApprovalManager } from "./approvals.js";
import type {
  McpJsonSchema,
  McpServerConfig,
  McpServerConnection,
  McpToolCallResult,
  McpToolContent,
  McpToolDefinition,
} from "./types.js";

const log = {
  info: (...args: unknown[]) => defaultRuntime.log("[mcp:tools]", ...args),
  error: (...args: unknown[]) => defaultRuntime.error("[mcp:tools]", ...args),
  debug: (...args: unknown[]) => {
    if (process.env.OPENCLAW_MCP_DEBUG === "1") {
      defaultRuntime.log("[mcp:tools:debug]", ...args);
    }
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert all tools from an MCP server connection into OpenClaw AgentTool objects.
 *
 * @param connection - An active MCP server connection with discovered tools.
 * @param existingToolNames - Set of tool names already registered (for conflict detection).
 * @returns Array of AgentTool objects ready for inclusion in the tool set.
 */
export function createMcpToolsFromConnection(
  connection: McpServerConnection,
  existingToolNames?: Set<string>,
): AnyAgentTool[] {
  if (connection.status !== "connected") {
    log.info(`Skipping tools from MCP server "${connection.name}" (status: ${connection.status})`);
    return [];
  }

  const prefix = resolveToolPrefix(connection);
  const tools: AnyAgentTool[] = [];

  for (const mcpTool of connection.tools) {
    const toolName = prefixToolName(prefix, mcpTool.name);

    if (existingToolNames?.has(toolName)) {
      log.error(
        `MCP tool name collision: "${toolName}" from server "${connection.name}" — skipping`,
      );
      continue;
    }

    const agentTool = convertMcpTool(connection, mcpTool, toolName);
    tools.push(agentTool);
    existingToolNames?.add(toolName);
  }

  log.info(
    `Registered ${tools.length} tool(s) from MCP server "${connection.name}" (prefix: "${prefix}")`,
  );
  return tools;
}

/**
 * Create tools from multiple MCP server connections.
 *
 * @param connections - Array of MCP server connections.
 * @param existingToolNames - Set of tool names already registered.
 * @returns Array of all AgentTool objects from all connections.
 */
export function createMcpToolsFromConnections(
  connections: McpServerConnection[],
  existingToolNames?: Set<string>,
): AnyAgentTool[] {
  const names = existingToolNames ?? new Set<string>();
  const allTools: AnyAgentTool[] = [];

  for (const conn of connections) {
    const tools = createMcpToolsFromConnection(conn, names);
    allTools.push(...tools);
  }

  return allTools;
}

// ---------------------------------------------------------------------------
// Tool conversion
// ---------------------------------------------------------------------------

function convertMcpTool(
  connection: McpServerConnection,
  mcpTool: McpToolDefinition,
  toolName: string,
): AnyAgentTool {
  const parameters = convertJsonSchemaToTypebox(mcpTool.inputSchema);
  const toolTimeout = resolveToolTimeout(connection.config, mcpTool.name);

  return {
    label: `MCP: ${connection.name}/${mcpTool.name}`,
    name: toolName,
    description: mcpTool.description ?? `MCP tool from ${connection.name}`,
    parameters,
    execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> => {
      const params = (args ?? {}) as Record<string, unknown>;

      log.debug(`Calling MCP tool "${mcpTool.name}" on server "${connection.name}"`);

      // ── Approval gate ─────────────────────────────────────────────
      if (requiresMcpApproval(connection.config, mcpTool.name)) {
        const approvalId = crypto.randomUUID();
        const manager = getMcpApprovalManager();
        const decision = await manager.register({
          id: approvalId,
          serverName: connection.name,
          toolName: mcpTool.name,
          args: params,
          timestamp: Date.now(),
        });

        if (decision !== "allow") {
          log.debug(
            `MCP tool "${mcpTool.name}" ${decision === "timeout" ? "timed out" : "denied"}`,
          );
          return {
            content: [
              {
                type: "text",
                text:
                  decision === "timeout"
                    ? `MCP tool "${mcpTool.name}" approval timed out.`
                    : `MCP tool "${mcpTool.name}" was denied by approval policy.`,
              },
            ],
            details: { status: decision === "timeout" ? "timeout" : "denied" },
          };
        }
      }

      emitDiagnosticEvent({
        type: "mcp.tool.call",
        serverName: connection.name,
        toolName: mcpTool.name,
      });

      const startMs = Date.now();
      let result: McpToolCallResult;
      try {
        result = await connection.callTool(mcpTool.name, params, toolTimeout);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        emitDiagnosticEvent({
          type: "mcp.tool.result",
          serverName: connection.name,
          toolName: mcpTool.name,
          durationMs: Date.now() - startMs,
          isError: true,
          error: errorMsg,
        });
        throw err;
      }

      emitDiagnosticEvent({
        type: "mcp.tool.result",
        serverName: connection.name,
        toolName: mcpTool.name,
        durationMs: Date.now() - startMs,
        isError: !!result.isError,
        ...(result.isError ? { error: "MCP tool returned error" } : {}),
      });

      return convertMcpResult(result);
    },
  };
}

// ---------------------------------------------------------------------------
// Result conversion: MCP content → AgentToolResult
// ---------------------------------------------------------------------------

function convertMcpResult(result: McpToolCallResult): AgentToolResult<unknown> {
  const content: AgentToolResult<unknown>["content"] = [];
  const details: Record<string, unknown> = {};

  if (result.isError) {
    details.isError = true;
  }

  for (const block of result.content) {
    const converted = convertContentBlock(block);
    if (converted) {
      content.push(converted);
    }
  }

  // If no content was extracted, add a placeholder.
  if (content.length === 0) {
    content.push({
      type: "text",
      text: result.isError ? "(MCP tool returned an error with no content)" : "(empty result)",
    });
  }

  // Aggregate text content into details for structured access.
  const textParts = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text);
  if (textParts.length > 0) {
    details.text = textParts.join("\n");
  }

  return { content, details };
}

function convertContentBlock(
  block: McpToolContent,
): AgentToolResult<unknown>["content"][number] | null {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: block.text ?? "",
      };

    case "image":
      if (block.data && block.mimeType) {
        return {
          type: "image",
          data: block.data,
          mimeType: block.mimeType,
        };
      }
      // If the image block is missing data, fall back to a text description.
      return {
        type: "text",
        text: `[MCP image: mimeType=${block.mimeType ?? "unknown"}]`,
      };

    case "resource":
      // Resources (embedded file content) are rendered as text.
      return {
        type: "text",
        text: block.text ?? `[MCP resource: ${block.uri ?? "unknown"}]`,
      };

    default:
      log.debug(`Unknown MCP content type: ${(block as McpToolContent).type}`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeBox conversion
// ---------------------------------------------------------------------------

/**
 * Convert an MCP JSON Schema object (typically an "object" type with properties)
 * into a TypeBox TObject schema compatible with pi-agent-core.
 *
 * This is a best-effort conversion — MCP schemas are arbitrary JSON Schema,
 * but tool parameter schemas are almost always simple objects with typed props.
 */
function convertJsonSchemaToTypebox(schema: McpJsonSchema): TObject {
  if (!schema || schema.type !== "object" || !schema.properties) {
    // If the schema is not an object, create a passthrough object that accepts
    // any properties. This is safety against weird MCP tool schemas.
    return Type.Object({});
  }

  const required = new Set(schema.required ?? []);
  const properties: TProperties = {};

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const converted = convertPropertySchema(propSchema);
    properties[key] = required.has(key) ? converted : Type.Optional(converted);
  }

  return Type.Object(properties);
}

function convertPropertySchema(schema: McpJsonSchema): TSchema {
  const opts: Record<string, unknown> = {};
  if (schema.description) {
    opts.description = schema.description;
  }
  if (schema.default !== undefined) {
    opts.default = schema.default;
  }

  // Handle enum values.
  if (schema.enum && Array.isArray(schema.enum)) {
    const literals = schema.enum
      .filter(
        (v): v is string | number | boolean =>
          typeof v === "string" || typeof v === "number" || typeof v === "boolean",
      )
      .map((v) => Type.Literal(v));
    if (literals.length > 0) {
      return Type.Union(literals, opts);
    }
  }

  switch (schema.type) {
    case "string":
      return Type.String(opts);

    case "number":
    case "integer":
      return schema.type === "integer" ? Type.Integer(opts) : Type.Number(opts);

    case "boolean":
      return Type.Boolean(opts);

    case "array":
      if (schema.items) {
        return Type.Array(convertPropertySchema(schema.items), opts);
      }
      return Type.Array(Type.Unknown(), opts);

    case "object":
      if (schema.properties) {
        const required = new Set(schema.required ?? []);
        const props: TProperties = {};
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          const converted = convertPropertySchema(propSchema);
          props[key] = required.has(key) ? converted : Type.Optional(converted);
        }
        return Type.Object(props, opts);
      }
      return Type.Record(Type.String(), Type.Unknown(), opts);

    default:
      // Unknown or missing type → accept anything.
      return Type.Unknown(opts);
  }
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

function resolveToolPrefix(connection: McpServerConnection): string {
  const explicit = connection.config.toolPrefix;
  if (explicit !== undefined) {
    return explicit;
  }
  return connection.name;
}

function prefixToolName(prefix: string, name: string): string {
  if (!prefix) {
    return name;
  }
  return `mcp_${prefix}_${name}`;
}

// ---------------------------------------------------------------------------
// Timeout resolution
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Resolve the timeout for a specific tool call.
 * Priority: toolTimeouts[toolName] → toolTimeoutMs → DEFAULT_TOOL_TIMEOUT_MS
 *
 * Returns undefined when the server default should be used (no per-tool override).
 */
export function resolveToolTimeout(config: McpServerConfig, toolName: string): number | undefined {
  const perTool = config.toolTimeouts?.[toolName];
  if (typeof perTool === "number" && perTool > 0) {
    return perTool;
  }
  return undefined; // Let the connection use its own default
}
