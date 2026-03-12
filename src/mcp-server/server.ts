/**
 * MCP Server Core
 *
 * Handles MCP protocol messages and routes to appropriate handlers.
 */

import type {
  McpCapabilities,
  McpMessage,
  McpServerInfo,
  McpTool,
  McpToolResult,
  McpTransport,
} from "./types.js";
import { createToolHandlers, type ToolHandlerContext } from "./tools.js";

export interface McpServerOptions {
  gatewayUrl?: string;
  agentId?: string;
  workspace?: string;
}

export interface McpServer {
  connect(transport: McpTransport): Promise<void>;
  close(): Promise<void>;
}

const SERVER_INFO: McpServerInfo = {
  name: "openclaw-mcp",
  version: "1.0.0",
  capabilities: {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
  },
};

export function createServer(options: McpServerOptions = {}): McpServer {
  let transport: McpTransport | null = null;
  const toolContext: ToolHandlerContext = {
    gatewayUrl: options.gatewayUrl ?? "http://localhost:18789",
    agentId: options.agentId ?? "default",
    workspace: options.workspace,
  };

  const toolHandlers = createToolHandlers(toolContext);

  async function handleMessage(message: McpMessage): Promise<McpMessage | void> {
    const { id, method, params } = message;

    if (!method) {
      if (id !== undefined) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32600, message: "Invalid request: missing method" },
        };
      }
      return;
    }

    try {
      const result = await routeMethod(method, params ?? {});
      if (id !== undefined) {
        return { jsonrpc: "2.0", id, result };
      }
    } catch (err) {
      if (id !== undefined) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }
  }

  async function routeMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          serverInfo: SERVER_INFO,
          capabilities: SERVER_INFO.capabilities,
        };

      case "initialized":
        return {};

      case "tools/list":
        return { tools: listTools() };

      case "tools/call":
        return callTool(params);

      case "resources/list":
        return { resources: [] };

      case "prompts/list":
        return { prompts: [] };

      case "ping":
        return {};

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  function listTools(): McpTool[] {
    return [
      {
        name: "openclaw_send_message",
        description: "Send a message to an OpenClaw agent and get a response",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "The message to send" },
            agentId: { type: "string", description: "Target agent ID (optional)" },
            sessionKey: { type: "string", description: "Session key for continuity (optional)" },
          },
          required: ["message"],
        },
      },
      {
        name: "openclaw_memory_search",
        description: "Search persistent memory for relevant information",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Maximum results (default: 10)" },
            threshold: { type: "number", description: "Similarity threshold 0-1 (default: 0.7)" },
          },
          required: ["query"],
        },
      },
      {
        name: "openclaw_memory_add",
        description: "Add a new memory entry to persistent storage",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "Content to store" },
            metadata: {
              type: "object",
              description: "Optional metadata (tags, source, etc.)",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "openclaw_agent_status",
        description: "Get status of an OpenClaw agent",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Agent ID (optional, defaults to current)" },
          },
        },
      },
      {
        name: "openclaw_list_sessions",
        description: "List active agent sessions",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Filter by agent ID (optional)" },
            limit: { type: "number", description: "Maximum results (default: 20)" },
          },
        },
      },
      {
        name: "openclaw_get_session",
        description: "Get session transcript and details",
        inputSchema: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Session key" },
            limit: { type: "number", description: "Message limit (default: 50)" },
          },
          required: ["sessionKey"],
        },
      },
      {
        name: "openclaw_execute_skill",
        description: "Execute a registered skill/command",
        inputSchema: {
          type: "object",
          properties: {
            skill: { type: "string", description: "Skill name (e.g., 'commit', 'review-pr')" },
            args: { type: "string", description: "Arguments for the skill (optional)" },
            agentId: { type: "string", description: "Target agent ID (optional)" },
          },
          required: ["skill"],
        },
      },
      {
        name: "openclaw_browser_action",
        description: "Execute browser automation action via OpenClaw browser control",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description: "Action type: navigate, click, type, screenshot, snapshot",
            },
            url: { type: "string", description: "URL for navigate action" },
            selector: { type: "string", description: "CSS selector for click/type actions" },
            text: { type: "string", description: "Text for type action" },
            profile: { type: "string", description: "Browser profile name (optional)" },
          },
          required: ["action"],
        },
      },
      {
        name: "openclaw_read_file",
        description: "Read a file from the agent workspace",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to workspace" },
            encoding: { type: "string", description: "File encoding (default: utf-8)" },
          },
          required: ["path"],
        },
      },
      {
        name: "openclaw_list_files",
        description: "List files in the agent workspace",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path (default: workspace root)" },
            pattern: { type: "string", description: "Glob pattern filter (optional)" },
          },
        },
      },
    ];
  }

  async function callTool(params: Record<string, unknown>): Promise<McpToolResult> {
    const toolName = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

    const handler = toolHandlers[toolName];
    if (!handler) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      };
    }

    try {
      const result = await handler(toolArgs);
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  return {
    async connect(t: McpTransport) {
      transport = t;
      transport.onMessage(handleMessage);
      if (transport.start) {
        await transport.start();
      }
    },

    async close() {
      if (transport) {
        await transport.close();
        transport = null;
      }
    },
  };
}
