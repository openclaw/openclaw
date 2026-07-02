/**
 * Standalone MCP server that exposes OpenClaw plugin-registered tools
 * (e.g. memory-lancedb's memory_recall, memory_store, memory_forget)
 * so ACP sessions running Claude Code can use them.
 *
 * Run via: node --import tsx src/mcp/plugin-tools-serve.ts
 * Or: bun src/mcp/plugin-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import { ensureStandalonePluginToolRegistryLoaded, resolvePluginTools } from "../plugins/tools.js";
import { resolveSessionEntryChatType } from "../sessions/session-chat-type-shared.js";
import {
  resolveLongTermMemoryTargetChatType,
  shouldIncludeLongTermMemoryByDefault,
} from "../sessions/session-memory-policy.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { connectToolsMcpServerToStdio, createToolsMcpServer } from "./tools-stdio-server.js";

export const OPENCLAW_PLUGIN_TOOLS_MCP_AGENT_SESSION_KEY_ENV =
  "OPENCLAW_PLUGIN_TOOLS_MCP_AGENT_SESSION_KEY";

function resolvePluginToolPolicy(config: OpenClawConfig): {
  toolAllowlist?: string[];
  toolDenylist?: string[];
} {
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(config.tools?.profile),
    config.tools?.alsoAllow,
  );
  const globalPolicy = pickSandboxToolPolicy(config.tools);
  const toolAllowlist = collectExplicitAllowlist([profilePolicy, globalPolicy]);
  const toolDenylist = collectExplicitDenylist([profilePolicy, globalPolicy]);
  return {
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(toolDenylist.length > 0 ? { toolDenylist } : {}),
  };
}

export function resolvePluginToolsMcpAgentSessionKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[OPENCLAW_PLUGIN_TOOLS_MCP_AGENT_SESSION_KEY_ENV]?.trim() || undefined;
}

function resolvePluginToolContext(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  const sessionKey = resolvePluginToolsMcpAgentSessionKey(params.env);
  if (!sessionKey) {
    return { config: params.config, chatType: "group" as const };
  }
  const entry = loadSessionEntry(sessionKey, { strictRead: true }).entry;
  const storedChatType = resolveSessionEntryChatType(entry);
  const scopedChatType = resolveLongTermMemoryTargetChatType({
    sessionKey,
    storedChatType,
    longTermMemoryDefaultPolicy: entry?.longTermMemoryDefaultPolicy,
    preferStoredPolicy: true,
  });
  const shouldUseDirectScope =
    scopedChatType === undefined &&
    shouldIncludeLongTermMemoryByDefault({
      sessionKey,
      chatType: storedChatType,
      longTermMemoryDefaultPolicy: entry?.longTermMemoryDefaultPolicy,
    });
  return {
    config: params.config,
    sessionKey,
    chatType: scopedChatType ?? (shouldUseDirectScope ? "direct" : "group"),
  };
}

function resolveTools(config: OpenClawConfig, env: NodeJS.ProcessEnv = process.env): AnyAgentTool[] {
  const pluginToolPolicy = resolvePluginToolPolicy(config);
  const context = resolvePluginToolContext({ config, env });
  const runtimeRegistry = ensureStandalonePluginToolRegistryLoaded({
    context,
    ...pluginToolPolicy,
  });
  return resolvePluginTools({
    context,
    ...pluginToolPolicy,
    suppressNameConflicts: true,
    runtimeRegistry,
  });
}

export function createPluginToolsMcpServer(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    tools?: AnyAgentTool[];
  } = {},
): Server {
  const cfg = params.config ?? getRuntimeConfig();
  const tools = params.tools ?? resolveTools(cfg, params.env);
  return createToolsMcpServer({ name: "openclaw-plugin-tools", tools });
}

export async function servePluginToolsMcp(): Promise<void> {
  // MCP stdio requires stdout to stay protocol-only, including during plugin
  // tool discovery before the transport is connected.
  routeLogsToStderr();

  const config = getRuntimeConfig();
  const tools = resolveTools(config, process.env);
  const server = createPluginToolsMcpServer({ config, env: process.env, tools });
  if (tools.length === 0) {
    process.stderr.write("plugin-tools-serve: no plugin tools found\n");
  }

  await connectToolsMcpServerToStdio(server);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  servePluginToolsMcp().catch((err: unknown) => {
    process.stderr.write(`plugin-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
