type AgentStatusLike = {
  bootstrapPendingCount: number;
  totalSessions: number;
  agents: Array<{
    id: string;
    lastActiveAgeMs?: number | null;
  }>;
};

type PluginCompatibilityNoticeLike = {
  pluginId?: string | null;
  plugin?: string | null;
};

type SummarySessionsLike = {
  count: number;
  paths: string[];
  defaults: {
    model?: string | null;
    contextTokens?: number | null;
  };
};

function countActiveStatusAgents(params: {
  agentStatus: AgentStatusLike;
  activeThresholdMs?: number;
}) {
  // The overview treats recently touched sessions as "active" signal without
  // requiring a live gateway probe for every agent.
  const activeThresholdMs = params.activeThresholdMs ?? 10 * 60_000;
  return params.agentStatus.agents.filter(
    (agent) => agent.lastActiveAgeMs != null && agent.lastActiveAgeMs <= activeThresholdMs,
  ).length;
}

/** Builds the compact agent activity value for `status --all` overview rows. */
export function buildStatusAllAgentsValue(params: {
  agentStatus: AgentStatusLike;
  activeThresholdMs?: number;
}) {
  const activeAgents = countActiveStatusAgents(params);
  return `${params.agentStatus.agents.length} total · ${params.agentStatus.bootstrapPendingCount} bootstrapping · ${activeAgents} active · ${params.agentStatus.totalSessions} sessions`;
}

/** Formats the number of secret diagnostics found during status scanning. */
export function buildStatusSecretsValue(count: number) {
  return count > 0 ? `${count} diagnostic${count === 1 ? "" : "s"}` : "none";
}

/** Formats queued system-event count for the regular status overview. */
export function buildStatusEventsValue(params: { queuedSystemEvents: string[] }) {
  return params.queuedSystemEvents.length > 0
    ? `${params.queuedSystemEvents.length} queued`
    : "none";
}

/** Formats whether deep health probes ran for the regular status overview. */
export function buildStatusProbesValue(params: {
  health?: unknown;
  ok: (value: string) => string;
  muted: (value: string) => string;
}) {
  return params.health ? params.ok("enabled") : params.muted("skipped (use --deep)");
}

/** Summarizes plugin compatibility notices and affected plugin count. */
export function buildStatusPluginCompatibilityValue(params: {
  notices: PluginCompatibilityNoticeLike[];
  ok: (value: string) => string;
  warn: (value: string) => string;
}) {
  if (params.notices.length === 0) {
    return params.ok("none");
  }
  const pluginCount = new Set(
    params.notices.map((notice) => notice.pluginId ?? notice.plugin ?? ""),
  ).size;
  return params.warn(
    `${params.notices.length} notice${params.notices.length === 1 ? "" : "s"} · ${pluginCount} plugin${pluginCount === 1 ? "" : "s"}`,
  );
}

/** Formats active session count, default model context, and store coverage. */
export function buildStatusSessionsOverviewValue(params: {
  sessions: SummarySessionsLike;
  formatKTokens: (value: number) => string;
}) {
  const defaultCtx = params.sessions.defaults.contextTokens
    ? ` (${params.formatKTokens(params.sessions.defaults.contextTokens)} ctx)`
    : "";
  const storeLabel =
    params.sessions.paths.length > 1
      ? `${params.sessions.paths.length} stores`
      : (params.sessions.paths[0] ?? "unknown");
  return `${params.sessions.count} active · default ${params.sessions.defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`;
}
