import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { listSessionEntries } from "../config/sessions/store.js";
import { resolveSessionTotalTokens, type SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveCronStoreKey } from "../cron/store.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { hasConfiguredChannelsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import type { HeartbeatStatus, SessionStatus, StatusSummary } from "./status.types.js";

const channelSummaryModuleLoader = createLazyImportLoader(
  () => import("../infra/channel-summary.js"),
);
const linkChannelModuleLoader = createLazyImportLoader(() => import("./status.link-channel.js"));
const taskRegistryMaintenanceModuleLoader = createLazyImportLoader(
  () => import("../tasks/task-registry.maintenance.js"),
);

function loadChannelSummaryModule() {
  return channelSummaryModuleLoader.load();
}

function loadLinkChannelModule() {
  return linkChannelModuleLoader.load();
}

const loadStatusSummaryRuntimeModule = createLazyRuntimeSurface(
  () => import("./status.summary.runtime.js"),
  ({ statusSummaryRuntime }) => statusSummaryRuntime,
);

function loadTaskRegistryMaintenanceModule() {
  return taskRegistryMaintenanceModuleLoader.load();
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
  if (typeof entry?.fastMode === "boolean") {
    flags.push(entry.fastMode ? "fast" : "fast:off");
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

export function redactSensitiveStatusSummary(summary: StatusSummary): StatusSummary {
  return {
    ...summary,
    sessions: {
      ...summary.sessions,
      databasePaths: [],
      defaults: {
        model: null,
        contextTokens: null,
      },
      recent: [],
      byAgent: summary.sessions.byAgent.map((entry) => ({
        ...entry,
        databasePath: "[redacted]",
        recent: [],
      })),
    },
  };
}

export async function getStatusSummary(
  options: {
    includeSensitive?: boolean;
    includeChannelSummary?: boolean;
    config?: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
  } = {},
): Promise<StatusSummary> {
  const { includeSensitive = true, includeChannelSummary = true } = options;
  const {
    classifySessionKey,
    resolveConfiguredStatusModelRef,
    resolveContextTokensForModel,
    resolveSessionRuntimeLabel,
    resolveSessionModelRef,
  } = await loadStatusSummaryRuntimeModule();
  const cfg = options.config ?? getRuntimeConfig();
  const channelScopeConfig =
    options.sourceConfig === undefined
      ? { config: cfg }
      : { config: cfg, activationSourceConfig: options.sourceConfig };
  const needsChannelPlugins =
    includeChannelSummary && hasConfiguredChannelsForReadOnlyScope(channelScopeConfig);
  const linkContext = needsChannelPlugins
    ? await loadLinkChannelModule().then(({ resolveLinkChannelContext }) =>
        resolveLinkChannelContext(cfg, { sourceConfig: options.sourceConfig }),
      )
    : null;
  const agentList = listGatewayAgentsBasic(cfg);
  const heartbeatAgents: HeartbeatStatus[] = agentList.agents.map((agent) => {
    const summary = resolveHeartbeatSummaryForAgent(cfg, agent.id);
    return {
      agentId: agent.id,
      enabled: summary.enabled,
      every: summary.every,
      everyMs: summary.everyMs,
    } satisfies HeartbeatStatus;
  });
  const channelSummary = needsChannelPlugins
    ? await loadChannelSummaryModule().then(({ buildChannelSummary }) =>
        buildChannelSummary(cfg, {
          colorize: true,
          includeAllowFrom: true,
          sourceConfig: options.sourceConfig,
        }),
      )
    : [];
  const mainSessionKey = resolveMainSessionKey(cfg);
  const queuedSystemEvents = peekSystemEvents(mainSessionKey);
  const taskMaintenanceModule = await loadTaskRegistryMaintenanceModule();
  taskMaintenanceModule.configureTaskRegistryMaintenance({
    cronStoreKey: resolveCronStoreKey(),
  });
  const tasks = taskMaintenanceModule.getInspectableTaskRegistrySummary();
  const taskAudit = taskMaintenanceModule.getInspectableTaskAuditSummary();

  const resolved = resolveConfiguredStatusModelRef({
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
      // Keep `status`/`status --json` startup read-only. These summary lookups
      // should not kick off background provider discovery or plugin scans.
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  const now = Date.now();
  const sessionCache = new Map<string, Array<{ sessionKey: string; entry: SessionEntry }>>();
  const loadSessionRows = (agentId: string) => {
    const cached = sessionCache.get(agentId);
    if (cached) {
      return cached;
    }
    let rows: Array<{ sessionKey: string; entry: SessionEntry }>;
    try {
      rows = listSessionEntries({ agentId });
    } catch {
      rows = [];
    }
    sessionCache.set(agentId, rows);
    return rows;
  };
  const buildSessionRows = (
    rows: Array<{ sessionKey: string; entry: SessionEntry }>,
    opts: { agentIdOverride?: string } = {},
  ) =>
    rows
      .filter((row) => row.sessionKey !== "global" && row.sessionKey !== "unknown")
      .map(({ sessionKey: key, entry }) => {
        const updatedAt = entry?.updatedAt ?? null;
        const age = updatedAt ? now - updatedAt : null;
        const parsedAgentId = parseAgentSessionKey(key)?.agentId;
        const agentId = opts.agentIdOverride ?? parsedAgentId;
        const resolvedModel = resolveSessionModelRef(cfg, entry, opts.agentIdOverride);
        const model = resolvedModel.model ?? configModel ?? null;
        const contextTokens =
          resolveContextTokensForModel({
            cfg,
            provider: resolvedModel.provider,
            model,
            contextTokensOverride: entry?.contextTokens,
            fallbackContextTokens: configContextTokens ?? undefined,
            allowAsyncLoad: false,
          }) ?? null;
        const total = resolveSessionTotalTokens(entry);
        const totalTokensFresh =
          typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
        const remaining =
          contextTokens != null && total !== undefined ? Math.max(0, contextTokens - total) : null;
        const pct =
          contextTokens && contextTokens > 0 && total !== undefined
            ? Math.min(999, Math.round((total / contextTokens) * 100))
            : null;
        const runtime = resolveSessionRuntimeLabel({
          cfg,
          entry,
          provider: resolvedModel.provider,
          model: model ?? "",
          agentId,
          sessionKey: key,
        });

        return {
          agentId,
          key,
          kind: classifySessionKey(key, entry),
          sessionId: entry?.sessionId,
          updatedAt,
          age,
          thinkingLevel: entry?.thinkingLevel,
          fastMode: entry?.fastMode,
          verboseLevel: entry?.verboseLevel,
          traceLevel: entry?.traceLevel,
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
          runtime,
          contextTokens,
          flags: buildFlags(entry),
        } satisfies SessionStatus;
      })
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const databasePaths = new Set<string>();
  const allSessionsByAgent: SessionStatus[] = [];
  const byAgent = agentList.agents.map((agent) => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: agent.id });
    databasePaths.add(databasePath);
    const sessions = buildSessionRows(loadSessionRows(agent.id), { agentIdOverride: agent.id });
    allSessionsByAgent.push(...sessions);
    return {
      agentId: agent.id,
      databasePath,
      count: sessions.length,
      recent: sessions.slice(0, 10),
    };
  });

  const allSessions = allSessionsByAgent.toSorted(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  const recent = allSessions.slice(0, 10);
  const totalSessions = allSessions.length;

  const summary: StatusSummary = {
    runtimeVersion: resolveRuntimeServiceVersion(process.env),
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
    tasks,
    taskAudit,
    sessions: {
      databasePaths: Array.from(databasePaths),
      count: totalSessions,
      defaults: {
        model: configModel ?? null,
        contextTokens: configContextTokens ?? null,
      },
      recent,
      byAgent,
    },
  };
  return includeSensitive ? summary : redactSensitiveStatusSummary(summary);
}
