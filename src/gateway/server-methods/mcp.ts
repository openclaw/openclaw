/**
 * MCP server management gateway RPC handlers.
 *
 * Provides server listing, health, registry browsing, and server
 * configuration management to the UI and CLI.
 *
 * Server CRUD operates on scope files (`~/.openclaw/mcp/servers.yaml` etc.)
 * via the helpers in `src/mcp/scope.ts`, not on `openclaw.json`.
 */
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { getMcpClientManager } from "../../mcp/index.js";
import {
  loadMcpRegistriesFromDb,
  saveMcpRegistryToDb,
  deleteMcpRegistryFromDb,
} from "../../mcp/registries-sqlite.js";
import {
  syncMcpRegistry,
  syncAllMcpRegistries,
  loadCachedMcpServers,
} from "../../mcp/registry-sync.js";
import {
  findServerScope,
  resolveMcpServers,
  removeServerFromScope,
  upsertServerInScope,
  loadServersFromScope,
} from "../../mcp/scope.js";
import type {
  McpRegistryConfig,
  McpScope,
  McpServerConfig,
  McpServerState,
} from "../../mcp/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Get the inline MCP config from openclaw.json (for merging with scopes). */
function getInlineMcpConfig(): { servers?: Record<string, McpServerConfig> } | undefined {
  const cfg = loadConfig();
  const tools = (cfg as Record<string, unknown>).tools as Record<string, unknown> | undefined;
  return tools?.mcp as { servers?: Record<string, McpServerConfig> } | undefined;
}

/** Resolve project root for scope operations (uses default agent workspace). */
function getProjectRoot(): string {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  return resolveAgentWorkspaceDir(cfg, agentId);
}

/** Parse a scope param, defaulting to "user". */
function parseScope(raw: unknown): McpScope {
  if (raw === "local" || raw === "project" || raw === "user") {
    return raw;
  }
  return "user";
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export const mcpHandlers: GatewayRequestHandlers = {
  // ── READ ──────────────────────────────────────────────────────────────────

  /** List all configured MCP servers with runtime status (reads all scopes). */
  "mcp.servers.list": async ({ respond }) => {
    const manager = getMcpClientManager();
    const projectRoot = getProjectRoot();
    const inlineConfig = getInlineMcpConfig();
    const configuredServers = await resolveMcpServers(inlineConfig, projectRoot);

    // Merge config entries with runtime state (if manager is active).
    const servers: Array<
      McpServerState & { configured: boolean; scope?: string; config?: Partial<McpServerConfig> }
    > = [];

    for (const [key, cfg] of Object.entries(configuredServers)) {
      const runtimeState = manager?.getServerState(key);
      const scope = await findServerScope(key, projectRoot);
      // Include the raw config so the UI can populate edit forms.
      const config = {
        url: cfg.url,
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        headers: cfg.headers,
        env: cfg.env,
        timeout: cfg.timeout,
        prefix: cfg.prefix,
      };
      if (runtimeState) {
        servers.push({ ...runtimeState, configured: true, scope: scope ?? "inline", config });
      } else {
        servers.push({
          key,
          status: cfg.enabled === false ? "disabled" : "unavailable",
          type: cfg.type,
          toolCount: 0,
          toolNames: [],
          configured: true,
          scope: scope ?? "inline",
          config,
        });
      }
    }

    // Include any runtime servers not in config (shouldn't happen, but defensive).
    if (manager) {
      for (const state of manager.getAllServerStates()) {
        if (!configuredServers[state.key]) {
          servers.push({ ...state, configured: false });
        }
      }
    }

    respond(true, { servers });
  },

  /** List discovered tools for a specific server. */
  "mcp.servers.tools": async ({ params, respond }) => {
    const serverKey = params.server as string | undefined;
    if (!serverKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: server"),
      );
      return;
    }

    const manager = getMcpClientManager();
    if (!manager) {
      respond(true, { server: serverKey, tools: [] });
      return;
    }

    const tools = manager.getDiscoveredTools(serverKey);
    respond(true, {
      server: serverKey,
      tools: tools.map((t) => ({
        name: t.name,
        originalName: t.originalName,
        description: t.description,
        parameterNames: t.parameterNames,
      })),
    });
  },

  /** Overall MCP health summary. */
  "mcp.health.status": async ({ respond }) => {
    const manager = getMcpClientManager();
    const projectRoot = getProjectRoot();
    const inlineConfig = getInlineMcpConfig();
    const allServers = await resolveMcpServers(inlineConfig, projectRoot);
    const configuredCount = Object.keys(allServers).length;

    if (!manager) {
      respond(true, {
        connected: 0,
        total: configuredCount,
        toolCount: 0,
        servers: [],
      });
      return;
    }

    const states = manager.getAllServerStates();
    const connected = states.filter((s) => s.status === "connected").length;
    const toolCount = states.reduce((sum, s) => sum + s.toolCount, 0);

    respond(true, {
      connected,
      total: configuredCount,
      toolCount,
      servers: states,
    });
  },

  /** List configured registries (from SQLite). */
  "mcp.registry.list": async ({ respond }) => {
    const registries = loadMcpRegistriesFromDb();
    respond(true, { registries });
  },

  /** List available servers from synced registries (cached, no sync). */
  "mcp.browse.list": async ({ respond }) => {
    const registries = loadMcpRegistriesFromDb().filter((r) => r.enabled !== false);

    const results: Array<{
      registryId: string;
      registryName: string;
      servers: Awaited<ReturnType<typeof loadCachedMcpServers>>;
    }> = [];

    for (const reg of registries) {
      try {
        const servers = await loadCachedMcpServers(reg.id);
        results.push({ registryId: reg.id, registryName: reg.name, servers });
      } catch {
        results.push({ registryId: reg.id, registryName: reg.name, servers: [] });
      }
    }

    respond(true, { registries: results });
  },

  // ── WRITE ─────────────────────────────────────────────────────────────────

  /** Test connection to a specific server (or all servers). */
  "mcp.servers.test": async ({ params, respond }) => {
    const serverKey = params.server as string | undefined;
    const manager = getMcpClientManager();

    if (!manager) {
      respond(true, { results: [], message: "MCP client manager not initialized" });
      return;
    }

    const states = manager.getAllServerStates();
    const targets = serverKey ? states.filter((s) => s.key === serverKey) : states;

    // If a specific server wasn't found in runtime, check if it's configured but disabled.
    if (targets.length === 0 && serverKey) {
      const projectRoot = getProjectRoot();
      const inlineConfig = getInlineMcpConfig();
      const allServers = await resolveMcpServers(inlineConfig, projectRoot);
      const cfg = allServers[serverKey];
      if (cfg) {
        respond(true, {
          results: [
            {
              server: serverKey,
              status: cfg.enabled === false ? "disabled" : "not_connected",
              toolCount: 0,
              avgLatencyMs: null,
              lastError:
                cfg.enabled === false
                  ? "Server is disabled. Enable it first to test connectivity."
                  : "Server is configured but not connected to the runtime.",
            },
          ],
        });
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `server "${serverKey}" not found`),
      );
      return;
    }

    if (targets.length === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "no servers connected"));
      return;
    }

    // Actually ping each target server to measure real latency.
    const results = await Promise.all(
      targets.map(async (s) => {
        try {
          const ping = await manager.testConnection(s.key);
          return {
            server: s.key,
            status: "connected" as const,
            toolCount: ping.toolCount,
            latencyMs: ping.latencyMs,
            avgLatencyMs: s.avgLatencyMs,
            lastError: null,
          };
        } catch (err) {
          return {
            server: s.key,
            status: s.status,
            toolCount: s.toolCount,
            latencyMs: null,
            avgLatencyMs: s.avgLatencyMs,
            lastError: (err as Error).message,
          };
        }
      }),
    );

    respond(true, { results });
  },

  /** Update server configuration fields. */
  "mcp.servers.configure": async ({ params, respond }) => {
    const serverKey = params.server as string | undefined;
    if (!serverKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: server"),
      );
      return;
    }

    try {
      const projectRoot = getProjectRoot();
      const scope = await findServerScope(serverKey, projectRoot);
      if (!scope) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `server "${serverKey}" not found in any scope`),
        );
        return;
      }

      const servers = await loadServersFromScope(scope, projectRoot);
      const existing = servers[serverKey];
      if (!existing) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `server "${serverKey}" not found in ${scope} scope`,
          ),
        );
        return;
      }

      // Merge allowed fields from params into existing config.
      const updated: McpServerConfig = { ...existing };
      if (typeof params.url === "string") {
        updated.url = params.url;
      }
      if (typeof params.type === "string") {
        updated.type = params.type as McpServerConfig["type"];
      }
      if (typeof params.command === "string") {
        updated.command = params.command;
      }
      if (Array.isArray(params.args)) {
        updated.args = params.args as string[];
      }
      if (typeof params.cwd === "string") {
        updated.cwd = params.cwd;
      }
      if (typeof params.timeout === "number") {
        updated.timeout = params.timeout;
      }
      if (typeof params.toolNames === "string") {
        updated.toolNames = params.toolNames as McpServerConfig["toolNames"];
      }
      if (typeof params.prefix === "string") {
        updated.prefix = params.prefix;
      }
      if (typeof params.maxResultBytes === "number") {
        updated.maxResultBytes = params.maxResultBytes;
      }
      if (typeof params.enabled === "boolean") {
        updated.enabled = params.enabled;
      }
      if (params.headers !== undefined) {
        updated.headers = params.headers as Record<string, string>;
      }
      if (params.env !== undefined) {
        updated.env = params.env as Record<string, string>;
      }

      await upsertServerInScope(scope, projectRoot, serverKey, updated);
      respond(true, { server: serverKey, scope, config: updated });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `failed to update server config: ${(err as Error).message}`,
        ),
      );
    }
  },

  /** Enable a server. */
  "mcp.servers.enable": async ({ params, respond }) => {
    const serverKey = params.server as string | undefined;
    if (!serverKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: server"),
      );
      return;
    }

    try {
      const projectRoot = getProjectRoot();
      const scope = await findServerScope(serverKey, projectRoot);
      if (!scope) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `server "${serverKey}" not found in any scope`),
        );
        return;
      }

      const servers = await loadServersFromScope(scope, projectRoot);
      const existing = servers[serverKey];
      if (!existing) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `server "${serverKey}" not found in ${scope} scope`,
          ),
        );
        return;
      }

      const updated = { ...existing, enabled: true };
      await upsertServerInScope(scope, projectRoot, serverKey, updated);

      // Reconnect at runtime so the server becomes active immediately.
      const manager = getMcpClientManager();
      if (manager) {
        try {
          await manager.connect(serverKey, updated);
        } catch {
          // Non-fatal: server will reconnect on next gateway restart.
        }
      }

      respond(true, { server: serverKey, scope, enabled: true });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to enable server: ${(err as Error).message}`),
      );
    }
  },

  /** Disable a server. */
  "mcp.servers.disable": async ({ params, respond }) => {
    const serverKey = params.server as string | undefined;
    if (!serverKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: server"),
      );
      return;
    }

    try {
      const projectRoot = getProjectRoot();
      const scope = await findServerScope(serverKey, projectRoot);
      if (!scope) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `server "${serverKey}" not found in any scope`),
        );
        return;
      }

      const servers = await loadServersFromScope(scope, projectRoot);
      const existing = servers[serverKey];
      if (!existing) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `server "${serverKey}" not found in ${scope} scope`,
          ),
        );
        return;
      }

      await upsertServerInScope(scope, projectRoot, serverKey, { ...existing, enabled: false });

      // Disconnect from runtime so the server stops immediately.
      const manager = getMcpClientManager();
      if (manager?.getServerState(serverKey)) {
        try {
          await manager.close(serverKey);
        } catch {
          // Non-fatal.
        }
      }

      respond(true, { server: serverKey, scope, enabled: false });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `failed to disable server: ${(err as Error).message}`,
        ),
      );
    }
  },

  // ── ADMIN ─────────────────────────────────────────────────────────────────

  /** Add a new MCP server to a scope (default: user). */
  "mcp.servers.add": async ({ params, respond }) => {
    const serverKey = params.server as string | undefined;
    if (!serverKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: server"),
      );
      return;
    }

    const type = params.type as McpServerConfig["type"] | undefined;
    if (!type || !["http", "sse", "stdio"].includes(type)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing or invalid param: type (http|sse|stdio)"),
      );
      return;
    }

    const scope = parseScope(params.scope);

    try {
      const projectRoot = getProjectRoot();

      // Check for duplicates across all scopes.
      const existingScope = await findServerScope(serverKey, projectRoot);
      if (existingScope) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `server "${serverKey}" already exists in ${existingScope} scope`,
          ),
        );
        return;
      }

      const newServer: McpServerConfig = { type };
      if (typeof params.url === "string") {
        newServer.url = params.url;
      }
      if (typeof params.command === "string") {
        newServer.command = params.command;
      }
      if (Array.isArray(params.args)) {
        newServer.args = params.args as string[];
      }
      if (typeof params.cwd === "string") {
        newServer.cwd = params.cwd;
      }
      if (typeof params.timeout === "number") {
        newServer.timeout = params.timeout;
      }
      if (typeof params.toolNames === "string") {
        newServer.toolNames = params.toolNames as McpServerConfig["toolNames"];
      }
      if (typeof params.prefix === "string") {
        newServer.prefix = params.prefix;
      }
      if (typeof params.maxResultBytes === "number") {
        newServer.maxResultBytes = params.maxResultBytes;
      }
      if (typeof params.enabled === "boolean") {
        newServer.enabled = params.enabled;
      }
      if (params.headers !== undefined) {
        newServer.headers = params.headers as Record<string, string>;
      }
      if (params.env !== undefined) {
        newServer.env = params.env as Record<string, string>;
      }

      await upsertServerInScope(scope, projectRoot, serverKey, newServer);
      respond(true, { server: serverKey, scope, config: newServer });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to add server: ${(err as Error).message}`),
      );
    }
  },

  /** Remove an MCP server from its scope file. */
  "mcp.servers.remove": async ({ params, respond }) => {
    const serverKey = params.server as string | undefined;
    if (!serverKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: server"),
      );
      return;
    }

    try {
      const projectRoot = getProjectRoot();
      const scope = await findServerScope(serverKey, projectRoot);
      if (!scope) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `server "${serverKey}" not found in any scope`),
        );
        return;
      }

      await removeServerFromScope(scope, projectRoot, serverKey);

      // Also disconnect from runtime if manager is active.
      const manager = getMcpClientManager();
      if (manager?.getServerState(serverKey)) {
        await manager.close(serverKey);
      }

      respond(true, { server: serverKey, scope, removed: true });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to remove server: ${(err as Error).message}`),
      );
    }
  },

  /** Add a registry (persisted to SQLite). */
  "mcp.registry.add": async ({ params, respond }) => {
    const id = params.id as string | undefined;
    const name = params.name as string | undefined;
    const url = params.url as string | undefined;

    if (!id || !name || !url) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing required params: id, name, url"),
      );
      return;
    }

    try {
      const existing = loadMcpRegistriesFromDb();
      if (existing.some((r) => r.id === id)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `registry "${id}" already exists`),
        );
        return;
      }

      const newRegistry: McpRegistryConfig = {
        id,
        name,
        url,
        description: typeof params.description === "string" ? params.description : undefined,
        auth_token_env:
          typeof params.auth_token_env === "string" ? params.auth_token_env : undefined,
        visibility:
          params.visibility === "private" || params.visibility === "public"
            ? params.visibility
            : undefined,
        enabled: typeof params.enabled === "boolean" ? params.enabled : true,
      };
      saveMcpRegistryToDb(newRegistry);

      respond(true, { registry: newRegistry });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `failed to add registry: ${(err as Error).message}`),
      );
    }
  },

  /** Remove a registry (from SQLite). */
  "mcp.registry.remove": async ({ params, respond }) => {
    const id = params.id as string | undefined;
    if (!id) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing required param: id"),
      );
      return;
    }

    try {
      const removed = deleteMcpRegistryFromDb(id);
      if (!removed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `registry "${id}" not found`),
        );
        return;
      }

      respond(true, { id, removed: true });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `failed to remove registry: ${(err as Error).message}`,
        ),
      );
    }
  },

  /** Sync registry manifests (one or all). */
  "mcp.registry.sync": async ({ params, respond }) => {
    const registryId = params.registry as string | undefined;
    const registries = loadMcpRegistriesFromDb().filter((r) => r.enabled !== false);

    if (registries.length === 0) {
      respond(true, { results: [], message: "No MCP registries configured" });
      return;
    }

    try {
      const logs: string[] = [];
      const log = (msg: string) => logs.push(msg);

      if (registryId) {
        const registry = registries.find((r) => r.id === registryId);
        if (!registry) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `registry "${registryId}" not found`),
          );
          return;
        }
        const result = await syncMcpRegistry(registry, log);
        respond(true, { results: [result], logs });
      } else {
        const results = await syncAllMcpRegistries(registries, log);
        respond(true, { results, logs });
      }
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, `registry sync failed: ${(err as Error).message}`),
      );
    }
  },

  /** Run health check on a specific server or all servers. */
  "mcp.health.check": async ({ params, respond }) => {
    const serverKey = params.server as string | undefined;
    const manager = getMcpClientManager();

    if (!manager) {
      respond(true, { results: [], message: "MCP client manager not initialized" });
      return;
    }

    const states = manager.getAllServerStates();
    const targets = serverKey ? states.filter((s) => s.key === serverKey) : states;

    if (targets.length === 0 && serverKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `server "${serverKey}" not found`),
      );
      return;
    }

    // Health check: report current state and tool counts for each target.
    const results = targets.map((s) => ({
      server: s.key,
      status: s.status,
      type: s.type,
      toolCount: s.toolCount,
      avgLatencyMs: s.avgLatencyMs,
      lastCallAt: s.lastCallAt,
      lastError: s.lastError,
    }));

    respond(true, { results });
  },
};
