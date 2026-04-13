import crypto from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { listResources, resolveResourceContent } from "./mcp-app-resources.js";
import {
  MCP_LOOPBACK_SERVER_NAME,
  MCP_LOOPBACK_SERVER_VERSION,
  MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS,
  jsonRpcError,
  jsonRpcResult,
  type JsonRpcRequest,
} from "./mcp-http.protocol.js";
import {
  filterToolSchemaByVisibility,
  isToolVisibleTo,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";

type McpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
};

/**
 * Normalize a tool execution result into MCP content blocks.
 * Preserves the original block structure (type, data, mimeType, etc.)
 * so non-text content such as images is not degraded to text-only.
 * This keeps the HTTP loopback surface consistent with the WS handler.
 */
function normalizeToolCallContent(result: unknown): McpContentBlock[] {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content.map((block: Record<string, unknown>) => {
      const type = typeof block.type === "string" ? block.type : "text";
      if (type === "text") {
        return {
          type: "text",
          text:
            typeof block.text === "string"
              ? block.text
              : typeof block === "string"
                ? block
                : JSON.stringify(block),
        };
      }
      // Preserve non-text blocks (image, resource, etc.) as-is
      return { ...block, type } as McpContentBlock;
    });
  }
  return [
    {
      type: "text",
      text: typeof result === "string" ? result : JSON.stringify(result),
    },
  ];
}

export async function handleMcpJsonRpc(params: {
  message: JsonRpcRequest;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  callerRole?: "model" | "app";
}): Promise<object | null> {
  const { id, method, params: methodParams } = params.message;
  const callerRole = params.callerRole;

  switch (method) {
    case "initialize": {
      const clientVersion = (methodParams?.protocolVersion as string) ?? "";
      const negotiated =
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === clientVersion) ??
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {}, resources: {} },
        serverInfo: {
          name: MCP_LOOPBACK_SERVER_NAME,
          version: MCP_LOOPBACK_SERVER_VERSION,
        },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "tools/list":
      return jsonRpcResult(id, {
        tools: filterToolSchemaByVisibility(params.toolSchema, callerRole),
      });
    case "resources/list":
      return jsonRpcResult(id, { resources: listResources() });
    case "resources/read": {
      const uri = methodParams?.uri as string;
      if (!uri) {
        return jsonRpcError(id, -32602, "resources/read requires a uri parameter");
      }
      const resolved = await resolveResourceContent(uri);
      if (!resolved.ok) {
        return jsonRpcError(id, -32002, resolved.error);
      }
      return jsonRpcResult(id, { contents: [resolved.content] });
    }
    case "tools/call": {
      const toolName = methodParams?.name as string;
      const toolArgs = (methodParams?.arguments ?? {}) as Record<string, unknown>;
      const tool = params.tools.find((candidate) => candidate.name === toolName);
      if (!tool) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }

      // Enforce visibility: reject calls from a role that doesn't match the tool's visibility.
      const schemaEntry = params.toolSchema.find((s) => s.name === toolName);
      if (schemaEntry && !isToolVisibleTo(schemaEntry, callerRole)) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Tool not available: ${toolName}` }],
          isError: true,
        });
      }
      const toolCallId = `mcp-${crypto.randomUUID()}`;
      try {
        const result = await tool.execute(toolCallId, toolArgs);
        const payload: Record<string, unknown> = {
          content: normalizeToolCallContent(result),
          isError: false,
        };
        // Include _meta.ui when the tool has MCP App metadata
        if (schemaEntry?._meta) {
          payload._meta = schemaEntry._meta;
        }
        return jsonRpcResult(id, payload);
      } catch (error) {
        const message = formatErrorMessage(error);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: message || "tool execution failed" }],
          isError: true,
        });
      }
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}
