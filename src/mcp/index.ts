/**
 * MCP client public API.
 *
 * `connectMcpServers()` is the single entry point called from `createOpenClawTools()`.
 * Tier 1 (direct): register all MCP tools individually as AgentTools.
 * Tier 2 (search): expose a single `mcp_search` meta-tool backed by a ToolIndex.
 */
import type { AnyAgentTool } from "../agents/tools/common.js";
import { McpClientManager } from "./client-manager.js";
import { truncateResult, type McpResultContent } from "./result-truncation.js";
import { resolveEffectiveMcpConfig } from "./scope.js";
import { convertMcpToolsToAgentTools } from "./tool-adapter.js";
import { ToolIndex } from "./tool-index.js";
import { createMcpSearchTool } from "./tool-search.js";
import type { McpConfig, McpServerConfig, ToolIndexEntry } from "./types.js";
import { MCP_DEFAULTS } from "./types.js";

/** Singleton client manager (one per gateway process). */
let manager: McpClientManager | undefined;

/** Singleton tool index (populated only in search mode / Tier 2). */
let toolIndex: ToolIndex | undefined;

/** Get the current McpClientManager (if initialized). */
export function getMcpClientManager(): McpClientManager | undefined {
  return manager;
}

/** Get the current ToolIndex (if search mode is active). */
export function getMcpToolIndex(): ToolIndex | undefined {
  return toolIndex;
}

/**
 * Connect to configured MCP servers and return AgentTools.
 *
 * Auto-switches between direct mode (Tier 1) and search mode (Tier 2)
 * based on `toolSearch` config and `toolSearchThreshold`.
 */
export async function connectMcpServers(
  inlineConfig: McpConfig | undefined,
  options?: {
    projectRoot?: string;
    nativeToolNames?: Set<string>;
    agentId?: string;
  },
): Promise<AnyAgentTool[]> {
  const projectRoot = options?.projectRoot ?? process.cwd();
  const nativeToolNames = options?.nativeToolNames ?? new Set<string>();

  const { config, servers } = await resolveEffectiveMcpConfig(inlineConfig, projectRoot);

  // Filter to enabled servers only.
  let enabledServers = Object.entries(servers).filter(([, cfg]) => cfg.enabled !== false);

  // Apply per-agent scoping if configured.
  const agentId = options?.agentId;
  const agentScopes = config.agentScopes;
  if (agentId && agentScopes && agentId in agentScopes) {
    const allowedKeys = new Set(agentScopes[agentId]);
    const beforeCount = enabledServers.length;
    enabledServers = enabledServers.filter(([key]) => allowedKeys.has(key));
    if (enabledServers.length < beforeCount) {
      console.log(
        `[mcp] agent "${agentId}": scoped to ${enabledServers.length}/${beforeCount} servers`,
      );
    }
  }

  if (enabledServers.length === 0) {
    return [];
  }

  // Initialize the manager.
  manager = new McpClientManager();

  // Connect to all enabled servers in parallel.
  const connectResults = await Promise.allSettled(
    enabledServers.map(([key, cfg]) => manager!.connect(key, cfg)),
  );

  // Log any connection failures (already logged in client-manager, but summarize).
  let connectedCount = 0;
  for (let i = 0; i < connectResults.length; i++) {
    const result = connectResults[i];
    if (result?.status === "fulfilled") {
      const serverEntry = enabledServers[i];
      const state = serverEntry ? manager.getServerState(serverEntry[0]) : undefined;
      if (state?.status === "connected") {
        connectedCount++;
      }
    }
  }

  // Collect all discovered tools across servers.
  const allTools: { serverKey: string; tools: ToolIndexEntry[]; config: McpServerConfig }[] = [];
  let totalToolCount = 0;

  for (const [key, cfg] of enabledServers) {
    const tools = manager.getDiscoveredTools(key);
    if (tools.length > 0) {
      allTools.push({ serverKey: key, tools, config: cfg });
      totalToolCount += tools.length;
    }
  }

  if (totalToolCount === 0) {
    console.log(`[mcp] connected to ${connectedCount} servers, no tools discovered`);
    return [];
  }

  // Decide between direct registration (Tier 1) and search mode (Tier 2).
  const toolSearch = config.toolSearch ?? MCP_DEFAULTS.toolSearch;
  const threshold = config.toolSearchThreshold ?? MCP_DEFAULTS.toolSearchThreshold;
  const useSearchMode =
    toolSearch === "always" || (toolSearch === "auto" && totalToolCount >= threshold);

  const globalMaxResultBytes = config.maxResultBytes ?? MCP_DEFAULTS.maxResultBytes;
  const agentTools: AnyAgentTool[] = [];

  if (useSearchMode) {
    // Tier 2: search mode — build a ToolIndex and expose only the mcp_search meta-tool.
    toolIndex = new ToolIndex();

    for (const { tools } of allTools) {
      toolIndex.addTools(tools);
    }

    const mgr = manager;
    const searchTool = createMcpSearchTool({
      toolIndex,
      callTool: async (serverKey, toolName, args) => {
        const result = await mgr.callTool(serverKey, toolName, args);
        const content = result.content as McpResultContent[];
        const truncated = truncateResult(content, globalMaxResultBytes);
        return { ...result, content: truncated };
      },
    });

    agentTools.push(searchTool);
  } else {
    // Tier 1: direct registration — register all tools individually as AgentTools.
    toolIndex = undefined;
    const mcpToolNames = new Set<string>();

    for (const { serverKey, tools, config: serverConfig } of allTools) {
      const maxResultBytes = serverConfig.maxResultBytes ?? globalMaxResultBytes;
      const mgr = manager;

      const converted = convertMcpToolsToAgentTools({
        serverKey,
        tools,
        config: serverConfig,
        callTool: async (sKey, toolName, args) => {
          const result = await mgr.callTool(sKey, toolName, args);
          // Apply result truncation.
          const content = result.content as McpResultContent[];
          const truncated = truncateResult(content, maxResultBytes);
          return { ...result, content: truncated };
        },
        nativeToolNames,
        mcpToolNames,
      });

      agentTools.push(...converted);
    }

    // Warn if approaching threshold (direct mode only).
    if (toolSearch === "auto" && totalToolCount >= threshold - 2 && totalToolCount < threshold) {
      console.log(
        `[mcp] warning: ${totalToolCount}/${threshold} MCP tools registered directly. Adding more servers will auto-switch to search mode.`,
      );
    }
  }

  const mode = useSearchMode ? "search mode" : "direct registration";
  console.log(
    `[mcp] connected to ${connectedCount} servers, discovered ${totalToolCount} tools (${mode})`,
  );

  // If some servers failed, schedule a single retry after 30 s for those servers only.
  const failedServers = enabledServers.filter(([key]) => {
    const state = manager?.getServerState(key);
    return !state || state.status !== "connected";
  });

  if (failedServers.length > 0) {
    console.log(
      `[mcp] ${failedServers.length} server(s) failed; scheduling retry in 30 s: ${failedServers.map(([k]) => k).join(", ")}`,
    );
    setTimeout(() => {
      void retryFailedServers(failedServers, config, nativeToolNames);
    }, 30_000);
  }

  return agentTools;
}

/**
 * Retry connecting to a set of previously-failed MCP servers and merge any
 * newly-discovered tools into the cache.
 */
async function retryFailedServers(
  failedServers: [string, McpServerConfig][],
  config: McpConfig,
  nativeToolNames: Set<string>,
): Promise<void> {
  if (!manager) {
    // Manager was torn down (e.g. gateway shutdown); skip retry.
    return;
  }

  console.log(`[mcp] retry: attempting ${failedServers.length} failed server(s)`);

  await Promise.allSettled(failedServers.map(([key, cfg]) => manager!.connect(key, cfg)));

  const newTools: AnyAgentTool[] = [];
  let newToolCount = 0;
  let newConnected = 0;

  const globalMaxResultBytes = config.maxResultBytes ?? MCP_DEFAULTS.maxResultBytes;
  const mcpToolNames = new Set<string>();

  for (const [key, cfg] of failedServers) {
    const state = manager.getServerState(key);
    if (state?.status !== "connected") {
      continue;
    }
    newConnected++;
    const tools = manager.getDiscoveredTools(key);
    if (tools.length === 0) {
      continue;
    }
    newToolCount += tools.length;
    const maxResultBytes = cfg.maxResultBytes ?? globalMaxResultBytes;
    const mgr = manager;
    const converted = convertMcpToolsToAgentTools({
      serverKey: key,
      tools,
      config: cfg,
      callTool: async (sKey, toolName, args) => {
        const result = await mgr.callTool(sKey, toolName, args);
        const content = result.content as McpResultContent[];
        const truncated = truncateResult(content, maxResultBytes);
        return { ...result, content: truncated };
      },
      nativeToolNames,
      mcpToolNames,
    });
    newTools.push(...converted);
  }

  if (newTools.length > 0) {
    // Merge into cached tools so future getOrConnectMcpTools() callers see them.
    if (cachedMcpTools) {
      cachedMcpTools = [...cachedMcpTools, ...newTools];
    } else {
      cachedMcpTools = newTools;
    }
  }

  console.log(
    `[mcp] retry: connected ${newConnected} additional server(s), ${newToolCount} tool(s)`,
  );
}

/** Cached MCP tools from the last successful connection. */
let cachedMcpTools: AnyAgentTool[] | undefined;

/**
 * Get pre-resolved MCP tools. If not yet connected, connects lazily (once).
 * Safe to call from sync contexts via `.then()` or to await from async.
 *
 * Only caches when at least one tool was discovered so a total startup failure
 * does not permanently prevent subsequent retries.
 */
export async function getOrConnectMcpTools(
  inlineConfig: McpConfig | undefined,
  options?: { projectRoot?: string; nativeToolNames?: Set<string>; agentId?: string },
): Promise<AnyAgentTool[]> {
  if (cachedMcpTools) {
    return cachedMcpTools;
  }
  const tools = await connectMcpServers(inlineConfig, options);
  // Only cache when at least one tool connected; otherwise a future call can retry.
  if (tools.length > 0) {
    cachedMcpTools = tools;
  }
  return tools;
}

/** Return pre-resolved MCP tools (undefined if not yet connected). Sync-safe. */
export function getCachedMcpTools(): AnyAgentTool[] | undefined {
  return cachedMcpTools;
}

/** Disconnect all MCP servers and clean up. */
export async function disconnectMcpServers(): Promise<void> {
  if (manager) {
    await manager.closeAll();
    manager = undefined;
  }
  toolIndex = undefined;
  cachedMcpTools = undefined;
}
