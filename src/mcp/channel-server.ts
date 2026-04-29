import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { VERSION } from "../version.js";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import { ClaudePermissionRequestSchema, type ClaudeChannelMode } from "./channel-shared.js";
import { getChannelMcpCapabilities, registerChannelMcpTools } from "./channel-tools.js";

/**
 * 导出OpenClaw通道桥接器类
 */
export { OpenClawChannelBridge } from "./channel-bridge.js";

/**
 * OpenClaw MCP服务选项
 */
export type OpenClawMcpServeOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  config?: OpenClawConfig;
  claudeChannelMode?: ClaudeChannelMode;
  verbose?: boolean;
};

/**
 * 解析MCP配置
 * 如果未提供配置，则从运行时配置获取
 * @param config - 可选的配置
 * @returns 解析后的配置
 */
async function resolveMcpConfig(config: OpenClawConfig | undefined): Promise<OpenClawConfig> {
  if (config) {
    return config;
  }
  const { getRuntimeConfig } = await import("../config/config.js");
  return getRuntimeConfig();
}

/**
 * 创建OpenClaw通道MCP服务器
 * @param opts - 服务选项
 * @returns 包含服务器、桥接器、启动和关闭函数的对象
 */
export async function createOpenClawChannelMcpServer(opts: OpenClawMcpServeOptions = {}): Promise<{
  server: McpServer;
  bridge: OpenClawChannelBridge;
  start: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const cfg = await resolveMcpConfig(opts.config);
  const claudeChannelMode = opts.claudeChannelMode ?? "auto";
  const capabilities = getChannelMcpCapabilities(claudeChannelMode);
  const server = new McpServer(
    { name: "openclaw", version: VERSION },
    capabilities ? { capabilities } : undefined,
  );
  const bridge = new OpenClawChannelBridge(cfg, {
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
    gatewayPassword: opts.gatewayPassword,
    claudeChannelMode,
    verbose: opts.verbose ?? false,
  });
  bridge.setServer(server);

  server.server.setNotificationHandler(ClaudePermissionRequestSchema, async ({ params }) => {
    await bridge.handleClaudePermissionRequest({
      requestId: params.request_id,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
    });
  });
  registerChannelMcpTools(server, bridge);

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

/**
 * 启动OpenClaw通道MCP服务器
 * 使用stdio传输，在stdin关闭时优雅关闭
 * @param opts - 服务选项
 */
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
