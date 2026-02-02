import type { OpenClawConfig } from "../config/config.js";
import type { McpServerConfig, McpServersConfig } from "../config/types.mcp.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeServerId(id: string): string {
  return id.trim().toLowerCase();
}

function mergeServers(globalCfg: McpServersConfig, agentCfg: McpServersConfig): McpServersConfig {
  // Per-agent entry wins on key collisions.
  const merged: McpServersConfig = { ...globalCfg, ...agentCfg };

  // Allow per-agent overrides to disable globally defined servers via enabled:false.
  for (const [rawId, cfg] of Object.entries(merged)) {
    if (!cfg || typeof cfg !== "object") continue;

    const enabled = (cfg as McpServerConfig).enabled;
    if (enabled === false) {
      // Keep the entry but mark as disabled (callers can filter).
      merged[rawId] = { ...cfg, enabled: false } as McpServerConfig;
    }
  }
  return merged;
}

export function resolveEffectiveMcpServers(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): McpServersConfig {
  const cfg = params.config;
  const globalRaw = cfg?.mcpServers;
  const globalServers: McpServersConfig = isRecord(globalRaw)
    ? (globalRaw as McpServersConfig)
    : {};

  const agentServers: McpServersConfig = (() => {
    if (!cfg || !params.agentId) return {};
    const agentCfg = resolveAgentConfig(cfg, params.agentId);
    const raw = agentCfg?.mcpServers;
    return isRecord(raw) ? (raw as McpServersConfig) : {};
  })();

  const merged = mergeServers(globalServers, agentServers);

  // Normalize keys to lowercase for stable tool naming.
  const normalized: McpServersConfig = {};
  for (const [rawId, server] of Object.entries(merged)) {
    const id = normalizeServerId(rawId);
    if (!id) continue;
    normalized[id] = server;
  }
  return normalized;
}

export function isMcpServerEnabled(server: McpServerConfig | undefined): boolean {
  if (!server) return false;
  return server.enabled !== false;
}
