import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CANVAS_HOST_PATH,
  resolveCanvasDocumentDir,
} from "../../../extensions/canvas/runtime-api.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  getOrCreateSessionMcpRuntime,
  getSessionMcpRuntimeManager,
} from "../../agents/agent-bundle-mcp-runtime.js";
import type { McpCatalogTool } from "../../agents/agent-bundle-mcp-types.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
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
  const cfg = loadConfig();
  const manager = getSessionMcpRuntimeManager();
  const sessionId = manager.resolveSessionId(sessionKey) ?? `mcp-app:${sessionKey}`;
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return await getOrCreateSessionMcpRuntime({
    sessionId,
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

function extractCanvasDocumentId(viewUrl: string): string {
  const localOrigin = "http://openclaw.local";
  let parsed: URL;
  try {
    parsed = new URL(viewUrl, localOrigin);
  } catch {
    throw new Error("MCP app view is not authorized");
  }
  if (parsed.origin !== localOrigin) {
    throw new Error("MCP app view is not authorized");
  }

  const prefix = `${CANVAS_HOST_PATH}/documents/`;
  if (!parsed.pathname.startsWith(prefix)) {
    throw new Error("MCP app view is not authorized");
  }

  const rawId = parsed.pathname.slice(prefix.length).split("/", 1)[0];
  let documentId: string;
  try {
    documentId = decodeURIComponent(rawId ?? "");
  } catch {
    throw new Error("MCP app view is not authorized");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(documentId)) {
    throw new Error("MCP app view is not authorized");
  }
  return documentId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function requireAuthorizedAppView(params: {
  sessionKey: string;
  serverName: string;
  appToolName: string;
  uiResourceUri: string;
  viewUrl: string;
}) {
  const documentId = extractCanvasDocumentId(params.viewUrl);
  const manifestPath = path.join(resolveCanvasDocumentDir(documentId), "manifest.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("MCP app view is not authorized");
  }

  const mcpApp = asRecord(manifest.mcpApp);
  if (
    manifest.kind !== "mcp_app_view" ||
    !mcpApp ||
    mcpApp.serverName !== params.serverName ||
    mcpApp.toolName !== params.appToolName ||
    mcpApp.uiResourceUri !== params.uiResourceUri
  ) {
    throw new Error("MCP app view is not authorized");
  }

  const manifestSessionKey =
    typeof mcpApp.sessionKey === "string" && mcpApp.sessionKey.trim()
      ? mcpApp.sessionKey.trim()
      : undefined;
  if (manifestSessionKey && manifestSessionKey !== params.sessionKey) {
    throw new Error("MCP app view is not authorized");
  }
}

async function resolveAuthorizedRuntime(
  params: Record<string, unknown>,
  sessionKey: string,
  serverName: string,
) {
  const runtime = await resolveRuntime(sessionKey);
  requireMcpAppsEnabled(runtime);
  await requireAuthorizedAppView({
    sessionKey,
    serverName,
    appToolName: requireString(params, "appToolName"),
    uiResourceUri: requireString(params, "uiResourceUri"),
    viewUrl: requireString(params, "viewUrl"),
  });
  return runtime;
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
  const uiMeta =
    tool._meta?.ui && typeof tool._meta.ui === "object" && !Array.isArray(tool._meta.ui)
      ? (tool._meta.ui as { visibility?: unknown })
      : undefined;
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
      const runtime = await resolveAuthorizedRuntime(params, sessionKey, serverName);
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
      const runtime = await resolveAuthorizedRuntime(params, sessionKey, serverName);
      const readResource = runtime.readResource;
      if (!readResource) {
        throw new Error("MCP resources/read is unavailable");
      }
      const result = await readResource(serverName, uri);
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
      const runtime = await resolveAuthorizedRuntime(params, sessionKey, serverName);
      const result = await runtime.listTools?.(serverName, cursor ? { cursor } : undefined);
      if (!result) {
        throw new Error("MCP tools/list is unavailable");
      }
      const catalog = await runtime.getCatalog();
      const appCallableToolNames = new Set(
        catalog.tools
          .filter((entry) => entry.serverName === serverName && isAppCallableTool(entry))
          .map((entry) => entry.toolName),
      );
      respond(true, {
        ...result,
        tools: result.tools.filter(
          (tool) => appCallableToolNames.has(tool.name.trim()) && isAppCallableListedTool(tool),
        ),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "mcp.listResources": async ({ respond, params }) => {
    try {
      const sessionKey = requireString(params, "sessionKey");
      const serverName = requireString(params, "serverName");
      const runtime = await resolveAuthorizedRuntime(params, sessionKey, serverName);
      const resources = await runtime.listResources?.(serverName);
      if (!resources) {
        throw new Error("MCP resources/list is unavailable");
      }
      const result = Array.isArray(resources) ? { resources } : resources;
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
      const runtime = await resolveAuthorizedRuntime(params, sessionKey, serverName);
      const result = await runtime.listResourceTemplates?.(
        serverName,
        cursor ? { cursor } : undefined,
      );
      if (!result) {
        throw new Error("MCP resources/templates/list is unavailable");
      }
      respond(true, result);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
