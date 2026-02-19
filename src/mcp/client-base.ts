/**
 * Abstract base class for MCP clients.
 *
 * Provides the shared interface for both stdio and SSE/HTTP transports.
 */

import type { McpServerConfig } from "./config.js";

export type McpClientStatus = "disconnected" | "connecting" | "ready" | "error" | "closed";

export abstract class McpClientBase {
  readonly name: string;
  readonly config: McpServerConfig;
  protected status: McpClientStatus = "disconnected";

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  /** Connect to MCP server and discover tools */
  abstract connect(): Promise<void>;

  /** Gracefully disconnect */
  abstract disconnect(): Promise<void>;

  /** Call a tool on this MCP server */
  abstract callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text?: string; mimeType?: string; data?: string }> }>;

  /** List available resources */
  abstract listResources(): Promise<{
    resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  }>;

  /** Read a specific resource */
  abstract readResource(params: { uri: string }): Promise<{
    contents: Array<{ text?: string; blob?: string; mimeType?: string }>;
  }>;

  /** Get current status */
  getStatus(): McpClientStatus {
    return this.status;
  }
}
