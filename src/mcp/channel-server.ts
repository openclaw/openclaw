// Channel MCP server wires channel bridge tools into an MCP server instance.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import { ClaudePermissionRequestSchema, type ClaudeChannelMode } from "./channel-shared.js";
import { getChannelMcpCapabilities, registerChannelMcpTools } from "./channel-tools.js";
import {
  loadOpenClawMcpAppResource,
  OPENCLAW_SESSION_APP_URI,
  openClawMcpServerInfo,
  registerOpenClawMcpApp,
} from "./session-app.js";
import { registerSessionMcpTools } from "./session-tools-registration.js";

/**
 * MCP stdio server assembly for OpenClaw channel conversations.
 *
 * This module wires config, the Gateway bridge, protocol notifications, and
 * registered tools into a lifecycle that callers can either embed or serve.
 */
export { OpenClawChannelBridge } from "./channel-bridge.js";

/** Options accepted by the channel MCP server factory and stdio entry point. */
type OpenClawMcpServeOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  config?: OpenClawConfig;
  claudeChannelMode?: ClaudeChannelMode;
  client?: "codex";
  appResourcePath?: string;
  verbose?: boolean;
};

async function resolveMcpConfig(config: OpenClawConfig | undefined): Promise<OpenClawConfig> {
  if (config) {
    return config;
  }
  const { getRuntimeConfig } = await import("../config/config.js");
  return getRuntimeConfig();
}

/** Create an in-process channel MCP server plus explicit start and close hooks. */
export async function createOpenClawChannelMcpServer(opts: OpenClawMcpServeOptions = {}): Promise<{
  server: McpServer;
  bridge: OpenClawChannelBridge;
  start: () => Promise<void>;
  close: () => Promise<void>;
}> {
  if ((opts.client === "codex") !== Boolean(opts.appResourcePath)) {
    throw new Error("--client codex and --app-resource must be used together");
  }
  const isCodex = opts.client === "codex";
  const appHtml = opts.appResourcePath
    ? await loadOpenClawMcpAppResource({
        cwd: process.cwd(),
        resourcePath: opts.appResourcePath,
      })
    : undefined;
  const cfg = await resolveMcpConfig(opts.config);
  const claudeChannelMode = isCodex ? "off" : (opts.claudeChannelMode ?? "auto");
  const { gatewayUrl, gatewayToken, gatewayPassword } = opts;
  const capabilities = getChannelMcpCapabilities(claudeChannelMode);
  const server = new McpServer(
    openClawMcpServerInfo(),
    capabilities ? { capabilities } : undefined,
  );
  const bridge = new OpenClawChannelBridge(cfg, {
    gatewayUrl,
    gatewayToken,
    gatewayPassword,
    claudeChannelMode,
    client: opts.client,
    verbose: opts.verbose ?? false,
  });
  bridge.setServer(server);

  if (!isCodex) {
    server.server.setNotificationHandler(ClaudePermissionRequestSchema, async ({ params }) => {
      await bridge.handleClaudePermissionRequest({
        requestId: params.request_id,
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
      });
    });
  }
  // The all-session projection is a Codex app capability. Generic and Claude
  // channel clients must not gain access to unrelated Gateway sessions.
  if (isCodex && appHtml !== undefined) {
    registerSessionMcpTools(server, bridge.sessionTools, {
      appResourceUri: OPENCLAW_SESSION_APP_URI,
    });
    registerOpenClawMcpApp(server, {
      html: appHtml,
      open: async () => await bridge.sessionTools.open(),
    });
  } else {
    registerChannelMcpTools(server, bridge);
  }

  return {
    server,
    bridge,
    start: async () => {
      await bridge.start();
    },
    close: async () => {
      await bridge.close();
      await server.close();
    },
  };
}

/** Serve the channel MCP server over stdio until transport or process shutdown. */
export async function serveOpenClawChannelMcp(opts: OpenClawMcpServeOptions = {}): Promise<void> {
  const { server, start, close } = await createOpenClawChannelMcpServer(opts);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    // The MCP SDK exposes transport close as a mutable handler rather than an EventEmitter API.
    transport["onclose"] = undefined;
    close().then(resolveClosed, resolveClosed);
  };

  transport["onclose"] = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    await start();
    await closed;
  } finally {
    shutdown();
    await closed;
  }
}
