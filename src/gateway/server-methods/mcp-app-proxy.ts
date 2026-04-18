import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  getOrCreateSessionMcpRuntime,
  getSessionMcpRuntimeManager,
} from "../../agents/pi-bundle-mcp-runtime.js";
import type { McpCatalogTool } from "../../agents/pi-bundle-mcp-types.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`missing required string parameter: ${key}`);
  }
  return value.trim();
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveRuntime(sessionKey: string) {
  const manager = getSessionMcpRuntimeManager();
  const sessionId = manager.resolveSessionId(sessionKey);
  if (sessionId) {
    const runtime = manager.getExisting(sessionId);
    if (runtime) {
      return runtime;
    }
  }

  const cfg = loadConfig();
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return await getOrCreateSessionMcpRuntime({
    sessionId: `mcp-app:${sessionKey}`,
    sessionKey,
    workspaceDir,
    cfg,
  });
}

function requireMcpAppsEnabled(runtime: Awaited<ReturnType<typeof resolveRuntime>>) {
  if (runtime.mcpAppsEnabled !== true) {
    throw new Error("MCP Apps are disabled");
  }
}

async function requireAppCallableTool(params: {
  runtime: Awaited<ReturnType<typeof resolveRuntime>>;
  serverName: string;
  toolName: string;
}): Promise<McpCatalogTool> {
  requireMcpAppsEnabled(params.runtime);
  const catalog = await params.runtime.getCatalog();
  const tool = catalog.tools.find(
    (entry) => entry.serverName === params.serverName && entry.toolName === params.toolName,
  );
  if (!tool) {
    throw new Error(`MCP tool "${params.toolName}" not found on server "${params.serverName}"`);
  }
  if (!isAppCallableTool(tool)) {
    throw new Error(`MCP tool "${params.toolName}" is not app-callable`);
  }
  return tool;
}

function isAppCallableTool(tool: McpCatalogTool): boolean {
  // Unannotated tools predate MCP Apps and remain visible to both model and app callers.
  return tool.uiVisibility === undefined || tool.uiVisibility.includes("app");
}

function isAppCallableListedTool(tool: Tool): boolean {
  const uiMeta = tool._meta?.ui;
  const visibility = Array.isArray(uiMeta?.visibility)
    ? uiMeta.visibility.filter(
        (entry): entry is "model" | "app" => entry === "model" || entry === "app",
      )
    : undefined;
  return visibility === undefined || visibility.includes("app");
}

export const mcpAppProxyHandlers: GatewayRequestHandlers = {
  "mcp.callTool": async ({ respond, params }) => {
    try {
      const sessionKey = requireString(params, "sessionKey");
      const serverName = requireString(params, "serverName");
      const toolName = requireString(params, "toolName");
      const toolInput = params.arguments ?? {};
      const runtime = await resolveRuntime(sessionKey);
      await requireAppCallableTool({ runtime, serverName, toolName });
      const result = await runtime.callTool(serverName, toolName, toolInput);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "mcp.readResource": async ({ respond, params }) => {
    try {
      const sessionKey = requireString(params, "sessionKey");
      const serverName = requireString(params, "serverName");
      const uri = requireString(params, "uri");
      const runtime = await resolveRuntime(sessionKey);
      requireMcpAppsEnabled(runtime);
      const result = await runtime.readResource(serverName, uri);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "mcp.listTools": async ({ respond, params }) => {
    try {
      const sessionKey = requireString(params, "sessionKey");
      const serverName = requireString(params, "serverName");
      const cursor = optionalString(params, "cursor");
      const runtime = await resolveRuntime(sessionKey);
      requireMcpAppsEnabled(runtime);
      const result = await runtime.listTools(serverName, cursor ? { cursor } : undefined);
      respond(true, {
        ...result,
        tools: result.tools.filter(isAppCallableListedTool),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "mcp.listResources": async ({ respond, params }) => {
    try {
      const sessionKey = requireString(params, "sessionKey");
      const serverName = requireString(params, "serverName");
      const cursor = optionalString(params, "cursor");
      const runtime = await resolveRuntime(sessionKey);
      requireMcpAppsEnabled(runtime);
      const result = await runtime.listResources(serverName, cursor ? { cursor } : undefined);
      respond(true, result);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "mcp.listResourceTemplates": async ({ respond, params }) => {
    try {
      const sessionKey = requireString(params, "sessionKey");
      const serverName = requireString(params, "serverName");
      const cursor = optionalString(params, "cursor");
      const runtime = await resolveRuntime(sessionKey);
      requireMcpAppsEnabled(runtime);
      const result = await runtime.listResourceTemplates(
        serverName,
        cursor ? { cursor } : undefined,
      );
      respond(true, result);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
