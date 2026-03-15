/**
 * OpenClaw MCP Server
 *
 * Model Context Protocol server that exposes OpenClaw capabilities to Claude Code
 * and other MCP-compatible clients. Supports stdio and browser (WebSocket) transports.
 */

import { createServer, type McpServerOptions } from "./server.js";
import { createStdioTransport } from "./transports/stdio.js";
import { createBrowserTransport } from "./transports/browser.js";
import type { McpTransport } from "./types.js";

export type TransportType = "stdio" | "browser";

export interface McpStartOptions extends McpServerOptions {
  transport?: TransportType;
  port?: number;
  host?: string;
}

function selectTransport(options: McpStartOptions): McpTransport {
  const transportType = options.transport ?? "stdio";

  switch (transportType) {
    case "browser":
      return createBrowserTransport({
        port: options.port ?? 8765,
        host: options.host ?? "127.0.0.1",
      });
    case "stdio":
    default:
      return createStdioTransport();
  }
}

export async function startMcpServer(options: McpStartOptions = {}): Promise<void> {
  const transport = selectTransport(options);
  const server = createServer(options);

  await server.connect(transport);

  const transportName = options.transport ?? "stdio";
  if (transportName === "browser") {
    console.error(
      `[mcp] Browser transport listening on ws://${options.host ?? "127.0.0.1"}:${options.port ?? 8765}`,
    );
  } else {
    console.error("[mcp] Server started on stdio");
  }
}

export { createServer } from "./server.js";
export { createStdioTransport } from "./transports/stdio.js";
export { createBrowserTransport } from "./transports/browser.js";
export type { McpTransport, McpMessage, McpTool, McpToolResult } from "./types.js";
