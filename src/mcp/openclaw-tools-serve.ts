/**
 * 独立的OpenClaw内置工具MCP服务器
 *
 * 运行方式：node --import tsx src/mcp/openclaw-tools-serve.ts
 * 或：bun src/mcp/openclaw-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createCronTool } from "../agents/tools/cron-tool.js";
import { formatErrorMessage } from "../infra/errors.js";
import { connectToolsMcpServerToStdio, createToolsMcpServer } from "./tools-stdio-server.js";

/**
 * 获取用于MCP的OpenClaw工具列表
 * @returns 工具数组
 */
export function resolveOpenClawToolsForMcp(): AnyAgentTool[] {
  return [createCronTool()];
}

/**
 * 创建OpenClaw工具MCP服务器
 * @param params - 可选参数，包含自定义工具列表
 * @returns MCP服务器实例
 */
export function createOpenClawToolsMcpServer(
  params: {
    tools?: AnyAgentTool[];
  } = {},
): Server {
  const tools = params.tools ?? resolveOpenClawToolsForMcp();
  return createToolsMcpServer({ name: "openclaw-tools", tools });
}

/**
 * 启动OpenClaw工具MCP服务器
 * 连接到stdio传输
 */
export async function serveOpenClawToolsMcp(): Promise<void> {
  const server = createOpenClawToolsMcpServer();
  await connectToolsMcpServerToStdio(server);
}

/**
 * 直接运行时入口点
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveOpenClawToolsMcp().catch((err) => {
    process.stderr.write(`openclaw-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
