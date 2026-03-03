import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveFreshSessionTotalTokens,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import {
  classifySessionKey,
  listAgentsForGateway,
  resolveSessionModelRef,
} from "../gateway/session-utils.js";
import { buildChannelSummary } from "../infra/channel-summary.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-runner.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isCronJobSessionKey, isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { resolveLinkChannelContext } from "./status.link-channel.js";
import type {
  HeartbeatStatus,
  SessionGroup,
  SessionGroups,
  SessionStatus,
  SessionType,
  StatusSummary,
} from "./status.types.js";

/**
 * Classify session type for grouping in status output.
 * Uses canonical session-key utilities (`isCronJobSessionKey` / `isCronRunSessionKey`) for cron detection.
 * - main: Primary interactive session (agent:xxx:main, direct sessions, per-peer sessions)
 * - cronJob: Cron job definition (agent:xxx:cron:uuid)
 * - cronRun: Individual cron execution (agent:xxx:cron:uuid:run:uuid)
 * - other: Everything else (group sessions, channels, subagents, acp, etc.)
 *
 * @internal Exported for testing purposes only
 */
export function classifySessionType(key: string, kind?: SessionStatus["kind"]): SessionType {
  const parsed = parseAgentSessionKey(key);

  // Non-agent keys (global/unknown/legacy aliases) are not interactive sessions.
  if (!parsed) {
    return "other";
  }

  // Cron split (primary goal of this refactor)
  if (isCronRunSessionKey(key)) {
    return "cronRun";
  }
  if (isCronJobSessionKey(key)) {
    return "cronJob";
  }

  // Non-interactive agent sessions
  const restParts = parsed.rest
    .split(":")
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  const head = restParts[0] ?? "";
  const second = restParts[1] ?? "";
  if (head === "subagent" || head === "acp") {
    return "other";
  }
  if (head === "group" || head === "channel" || second === "group" || second === "channel") {
    return "other";
  }

  // Main vs other: prefer existing kind when provided (direct => main, group/global/unknown => other)
  if (kind) {
    return kind === "direct" ? "main" : "other";
  }

  // Fallback: token-based heuristics (no regex)
  if (head === "main") {
    return "main";
  }
  if (restParts.includes("direct")) {
    return "main";
  }

  return "main";
}

const buildFlags = (entry?: SessionEntry): string[] => {
  if (!entry) {
    return [];
  }
  const flags: string[] = [];
  const think = entry?.thinkingLevel;
  if (typeof think === "string" && think.length > 0) {
    flags.push(`think:${think}`);
  }
  const verbose = entry?.verboseLevel;
  if (typeof verbose === "string" && verbose.length > 0) {
    flags.push(`verbose:${verbose}`);
  }
  const reasoning = entry?.reasoningLevel;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    flags.push(`reasoning:${reasoning}`);
  }
  const elevated = entry?.elevatedLevel;
  if (typeof elevated === "string" && elevated.length > 0) {
    flags.push(`elevated:${elevated}`);
  }
  if (entry?.systemSent) {
    flags.push("system");
  }
  if (entry?.abortedLastRun) {
    flags.push("aborted");
  }
  const sessionId = entry?.sessionId as unknown;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    flags.push(`id:${sessionId}`);
  }
  return flags;
};

/**
 * Group sessions by type for improved status display.
 * Collapses cron run history when there are many entries.
 *
 * @internal Exported for testing purposes only
 */
export function groupSessions(sessions: SessionStatus[]): SessionGroups {
  const main = sessions.filter((s) => s.sessionType === "main");
  const cronJobs = sessions.filter((s) => s.sessionType === "cronJob");
  const cronRuns = sessions.filter((s) => s.sessionType === "cronRun");
  const other = sessions.filter((s) => s.sessionType === "other");

  // Collapse cron runs if there are many (show only count, not all sessions)
  const shouldCollapseRuns = cronRuns.length > 20;

  const createGroup = (
    label: string,
    items: SessionStatus[],
    collapsed: boolean,
  ): SessionGroup => ({
    label,
    count: items.length,
    sessions: collapsed ? items.slice(0, 5) : items,
    collapsed,
  });

  return {
    active: createGroup("Active", main, false),
    cronJobs: createGroup("Cron Jobs", cronJobs, false),
    cronRuns: createGroup("Recent Runs", cronRuns, shouldCollapseRuns),
    other: createGroup("Other", other, false),
  };
}

export function redactSensitiveStatusSummary(summary: StatusSummary): StatusSummary {
  return {
    ...summary,
    sessions: {
      ...summary.sessions,
      paths: [],
      defaults: {
        model: null,
        contextTokens: null,
      },
      recent: [],
      byAgent: summary.sessions.byAgent.map((entry) => ({
        ...entry,
        path: "[redacted]",
        recent: [],
      })),
      grouped: undefined,
    },
  };
}

export async function getStatusSummary(
  options: { includeSensitive?: boolean; config?: OpenClawConfig } = {},
): Promise<StatusSummary> {
  const { includeSensitive = true } = options;
  const cfg = options.config ?? loadConfig();
  const linkContext = await resolveLinkChannelContext(cfg);
  const agentList = listAgentsForGateway(cfg);
  const heartbeatAgents: HeartbeatStatus[] = agentList.agents.map((agent) => {
    const summary = resolveHeartbeatSummaryForAgent(cfg, agent.id);
    return {
      agentId: agent.id,
      enabled: summary.enabled,
      every: summary.every,
      everyMs: summary.everyMs,
    } satisfies HeartbeatStatus;
  });
  const channelSummary = await buildChannelSummary(cfg, {
    colorize: true,
    includeAllowFrom: true,
  });
  const mainSessionKey = resolveMainSessionKey(cfg);
  const queuedSystemEvents = peekSystemEvents(mainSessionKey);

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const configContextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: resolved.provider ?? DEFAULT_PROVIDER,
      model: configModel,
      contextTokensOverride: cfg.agents?.defaults?.contextTokens,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  const now = Date.now();
  const storeCache = new Map<string, Record<string, SessionEntry | undefined>>();
  const loadStore = (storePath: string) => {
    const cached = storeCache.get(storePath);
    if (cached) {
      return cached;
    }
    const store = loadSessionStore(storePath);
    storeCache.set(storePath, store);
    return store;
  };
  const buildSessionRows = (
    store: Record<string, SessionEntry | undefined>,
    opts: { agentIdOverride?: string } = {},
  ) =>
    Object.entries(store)
      .filter(([key]) => key !== "global" && key !== "unknown")
      .map(([key, entry]) => {
        const updatedAt = entry?.updatedAt ?? null;
        const age = updatedAt ? now - updatedAt : null;
        const resolvedModel = resolveSessionModelRef(cfg, entry, opts.agentIdOverride);
        const model = resolvedModel.model ?? configModel ?? null;
        const contextTokens =
          resolveContextTokensForModel({
            cfg,
            provider: resolvedModel.provider,
            model,
            contextTokensOverride: entry?.contextTokens,
            fallbackContextTokens: configContextTokens ?? undefined,
          }) ?? null;
        const total = resolveFreshSessionTotalTokens(entry);
        const totalTokensFresh =
          typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
        const remaining =
          contextTokens != null && total !== undefined ? Math.max(0, contextTokens - total) : null;
        const pct =
          contextTokens && contextTokens > 0 && total !== undefined
            ? Math.min(999, Math.round((total / contextTokens) * 100))
            : null;
        const parsedAgentId = parseAgentSessionKey(key)?.agentId;
        const agentId = opts.agentIdOverride ?? parsedAgentId;

        const kind = classifySessionKey(key, entry);
        const sessionType = classifySessionType(key, kind);

        return {
          agentId,
          key,
          kind,
          sessionType,
          sessionId: entry?.sessionId,
          updatedAt,
          age,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          reasoningLevel: entry?.reasoningLevel,
          elevatedLevel: entry?.elevatedLevel,
          systemSent: entry?.systemSent,
          abortedLastRun: entry?.abortedLastRun,
          inputTokens: entry?.inputTokens,
          outputTokens: entry?.outputTokens,
          cacheRead: entry?.cacheRead,
          cacheWrite: entry?.cacheWrite,
          totalTokens: total ?? null,
          totalTokensFresh,
          remainingTokens: remaining,
          percentUsed: pct,
          model,
          contextTokens,
          flags: buildFlags(entry),
        } satisfies SessionStatus;
      })
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const paths = new Set<string>();
  const byAgent = agentList.agents.map((agent) => {
    const storePath = resolveStorePath(cfg.session?.store, { agentId: agent.id });
    paths.add(storePath);
    const store = loadStore(storePath);
    const sessions = buildSessionRows(store, { agentIdOverride: agent.id });
    return {
      agentId: agent.id,
      path: storePath,
      count: sessions.length,
      recent: sessions.slice(0, 10),
    };
  });

  const allSessions = Array.from(paths)
    .flatMap((storePath) => buildSessionRows(loadStore(storePath)))
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const recent = allSessions.slice(0, 10);
  const totalSessions = allSessions.length;

  // Group sessions by type for better UX
  const grouped = groupSessions(allSessions);

  const summary: StatusSummary = {
    linkChannel: linkContext
      ? {
          id: linkContext.plugin.id,
          label: linkContext.plugin.meta.label ?? "Channel",
          linked: linkContext.linked,
          authAgeMs: linkContext.authAgeMs,
        }
      : undefined,
    heartbeat: {
      defaultAgentId: agentList.defaultId,
      agents: heartbeatAgents,
    },
    channelSummary,
    queuedSystemEvents,
    sessions: {
      paths: Array.from(paths),
      count: totalSessions,
      defaults: {
        model: configModel ?? null,
        contextTokens: configContextTokens ?? null,
      },
      recent,
      byAgent,
      grouped,
    },
  };
  return includeSensitive ? summary : redactSensitiveStatusSummary(summary);
}
