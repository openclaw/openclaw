/**
 * MCP Manager — lifecycle orchestrator for all MCP server connections.
 *
 * Central orchestrator that:
 * - Takes merged MCP config
 * - Creates and manages clients for each server
 * - Parallel startup with error isolation
 * - Aggregates tools and resources from all connected servers
 * - Graceful shutdown
 */

import type { AnyAgentTool } from "../agents/tools/common.js";
import type { McpConfig, McpServerConfig } from "./config.js";
import { logInfo, logWarn, logError } from "../logger.js";
import { McpClientBase, type McpClientStatus } from "./client-base.js";
import { SseMcpClient } from "./client-sse.js";
import { StdioMcpClient } from "./client-stdio.js";
import { buildResourceContext } from "./resource-bridge.js";
import { resolveSecrets } from "./secret-resolver.js";
import { bridgeAllTools } from "./tool-bridge.js";

export type ClientFactory = (name: string, config: McpServerConfig) => McpClientBase;

export type McpManagerOptions = {
  /** Override client creation for testing */
  clientFactory?: ClientFactory;
};

export type McpServerStatus = {
  name: string;
  status: McpClientStatus;
  toolCount: number;
};

function defaultClientFactory(name: string, config: McpServerConfig): McpClientBase {
  const transport = config.transport ?? "stdio";
  switch (transport) {
    case "stdio":
      return new StdioMcpClient(name, config);
    case "sse":
    case "http":
      return new SseMcpClient(name, config);
    default:
      throw new Error(`Unknown transport '${transport}' for server '${name}'`);
  }
}

export class McpManager {
  private readonly config: McpConfig;
  private readonly factory: ClientFactory;
  private readonly clients: Map<string, McpClientBase> = new Map();

  constructor(config: McpConfig, options?: McpManagerOptions) {
    this.config = config;
    this.factory = options?.clientFactory ?? defaultClientFactory;

    // Pre-create clients (for getStatus before start)
    for (const [name, serverConfig] of Object.entries(config.servers ?? {})) {
      if (serverConfig.enabled === false) {
        continue;
      }
      this.clients.set(name, this.factory(name, serverConfig));
    }
  }

  /**
   * Start all configured MCP servers in parallel.
   * Error isolation: one server failing does not affect others.
   */
  async start(): Promise<void> {
    const entries = [...this.clients.entries()];
    if (entries.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      entries.map(async ([name, client]) => {
        try {
          // Resolve secrets in env/headers before connecting
          const serverConfig = this.config.servers![name];
          if (serverConfig.env) {
            const resolved = await resolveSecrets(serverConfig.env);
            Object.assign(serverConfig.env, resolved);
          }
          if (serverConfig.headers) {
            const resolved = await resolveSecrets(serverConfig.headers);
            Object.assign(serverConfig.headers, resolved);
          }

          await client.connect();
          const toolCount = client.getDiscoveredTools().length;
          logInfo(`MCP server '${name}' connected (${toolCount} tools)`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logError(`MCP server '${name}' failed to start: ${msg}`);
          // Don't rethrow — error isolation
        }
      }),
    );
  }

  /**
   * Get all bridged tools from all ready servers.
   */
  getTools(): AnyAgentTool[] {
    const tools: AnyAgentTool[] = [];
    for (const [name, client] of this.clients) {
      if (client.getStatus() !== "ready") {
        continue;
      }
      const prefix = this.config.servers![name]?.toolPrefix;
      tools.push(...bridgeAllTools(client, name, prefix));
    }
    return tools;
  }

  /**
   * Get combined resource context from all ready servers.
   */
  async getResourceContext(): Promise<string> {
    const parts: string[] = [];
    for (const [name, client] of this.clients) {
      if (client.getStatus() !== "ready") {
        continue;
      }
      try {
        const context = await buildResourceContext(client, name);
        if (context) {
          parts.push(context);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logWarn(`Failed to get resources from '${name}': ${msg}`);
      }
    }
    return parts.join("\n\n");
  }

  /**
   * Gracefully shut down all clients.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.values()].map(async (client) => {
        try {
          await client.disconnect();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logWarn(`Error disconnecting MCP server '${client.name}': ${msg}`);
        }
      }),
    );
  }

  /**
   * Get per-server status and tool counts.
   */
  getStatus(): McpServerStatus[] {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      status: client.getStatus(),
      toolCount: client.getDiscoveredTools().length,
    }));
  }
}
