import crypto from "node:crypto";
import {
  MCP_LOOPBACK_SERVER_NAME,
  MCP_LOOPBACK_SERVER_VERSION,
  MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS,
  jsonRpcError,
  jsonRpcResult,
  type JsonRpcRequest,
} from "./mcp-http.protocol.js";
import type { McpLoopbackTool, McpToolSchemaEntry } from "./mcp-http.schema.js";

type McpTextContent = {
  type: "text";
  text: string;
};

function normalizeToolCallContent(result: unknown): McpTextContent[] {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content.map((block: { type?: string; text?: string }) => ({
      type: (block.type ?? "text") as "text",
      text: block.text ?? (typeof block === "string" ? block : JSON.stringify(block)),
    }));
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
  /**
   * Called after a successful `message` tool send/thread-reply with the raw
   * target string from the tool arguments.  Used by the MCP loopback HTTP
   * server to detect when a CLI agent replies to its own session channel.
   */
  onMessageSend?: (rawTarget: string) => void;
}): Promise<object | null> {
  const { id, method, params: methodParams } = params.message;

  switch (method) {
    case "initialize": {
      const clientVersion = (methodParams?.protocolVersion as string) ?? "";
      const negotiated =
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === clientVersion) ??
        MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS[0];
      return jsonRpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
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
      return jsonRpcResult(id, { tools: params.toolSchema });
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
      const toolCallId = `mcp-${crypto.randomUUID()}`;
      try {
        // oxlint-disable-next-line typescript/no-explicit-any
        const result = await (tool as any).execute(toolCallId, toolArgs);
        // Notify caller when the message tool performs a send/thread-reply so
        // the CLI runner can detect self-replies and suppress output.text.
        if (params.onMessageSend && toolName === "message") {
          const action = typeof toolArgs.action === "string" ? toolArgs.action.trim() : "";
          if (action === "send" || action === "thread-reply") {
            const rawTarget = (
              typeof toolArgs.target === "string"
                ? toolArgs.target
                : typeof toolArgs.to === "string"
                  ? toolArgs.to
                  : ""
            ).trim();
            if (rawTarget) {
              params.onMessageSend(rawTarget);
            }
          }
        }
        return jsonRpcResult(id, {
          content: normalizeToolCallContent(result),
          isError: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
