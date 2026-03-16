import { resolveAgentConfig } from "../agents/agent-scope.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveFreshSessionTotalTokens,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import type { HeartbeatStatus, SessionStatus, StatusSummary } from "./status.types.js";

let channelSummaryModulePromise: Promise<typeof import("../infra/channel-summary.js")> | undefined;
let linkChannelModulePromise: Promise<typeof import("./status.link-channel.js")> | undefined;
let statusSummaryRuntimeModulePromise:
  | Promise<typeof import("./status.summary.runtime.js")>
  | undefined;

function loadChannelSummaryModule() {
  channelSummaryModulePromise ??= import("../infra/channel-summary.js");
  return channelSummaryModulePromise;
}

function loadLinkChannelModule() {
  linkChannelModulePromise ??= import("./status.link-channel.js");
  return linkChannelModulePromise;
}

function loadStatusSummaryRuntimeModule() {
  statusSummaryRuntimeModulePromise ??= import("./status.summary.runtime.js");
  return statusSummaryRuntimeModulePromise;
}

function hasExplicitContextTokensCap(cfg: OpenClawConfig, agentId?: string): boolean {
  if (
    typeof cfg.agents?.defaults?.contextTokens === "number" &&
    cfg.agents.defaults.contextTokens > 0
  ) {
    return true;
  }
  if (!agentId) {
    return false;
  }
  const agentContextTokens = resolveAgentConfig(cfg, agentId)?.contextTokens;
  return typeof agentContextTokens === "number" && agentContextTokens > 0;
}

function shouldRepairStoredContextTokens(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  entry?: SessionEntry;
  resolvedContextTokens?: number | null;
}): boolean {
  const storedContextTokens = params.entry?.contextTokens;
  if (storedContextTokens !== DEFAULT_CONTEXT_TOKENS) {
    return false;
  }
  if (
    typeof params.resolvedContextTokens !== "number" ||
    params.resolvedContextTokens <= DEFAULT_CONTEXT_TOKENS
  ) {
    return false;
  }
  // Older cron/profile sessions could persist the hard fallback before the
  // async model registry finished loading. If there is no explicit cap in the
  // current config, prefer the resolved model window for status display.
  return !hasExplicitContextTokensCap(params.cfg, params.agentId);
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
    },
  };
}

export async function getStatusSummary(
  options: {
    includeSensitive?: boolean;
    config?: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
  } = {},
): Promise<StatusSummary> {
  const { includeSensitive = true } = options;
  const { classifySessionKey, resolveContextTokensForModelAsync, resolveSessionModelRef } =
    await loadStatusSummaryRuntimeModule();
  const cfg = options.config ?? loadConfig();
  const needsChannelPlugins = hasPotentialConfiguredChannels(cfg);
  const linkContext = needsChannelPlugins
    ? await loadLinkChannelModule().then(({ resolveLinkChannelContext }) =>
        resolveLinkChannelContext(cfg),
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

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const configContextTokens =
    (await resolveContextTokensForModelAsync({
      cfg,
      provider: resolved.provider ?? DEFAULT_PROVIDER,
      model: configModel,
      contextTokensOverride: cfg.agents?.defaults?.contextTokens,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
    })) ?? DEFAULT_CONTEXT_TOKENS;

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
  const buildSessionRows = async (
    store: Record<string, SessionEntry | undefined>,
    opts: { agentIdOverride?: string } = {},
  ) => {
    const rows = await Promise.all(
      Object.entries(store)
        .filter(([key]) => key !== "global" && key !== "unknown")
        .map(async ([key, entry]) => {
          const updatedAt = entry?.updatedAt ?? null;
          const age = updatedAt ? now - updatedAt : null;
          const parsedAgentId = parseAgentSessionKey(key)?.agentId;
          const agentId = opts.agentIdOverride ?? parsedAgentId;
          const resolvedModel = resolveSessionModelRef(cfg, entry, opts.agentIdOverride);
          const model = resolvedModel.model ?? configModel ?? null;
          const storedContextTokens =
            typeof entry?.contextTokens === "number" ? entry.contextTokens : undefined;
          const resolvedContextTokens =
            (await resolveContextTokensForModelAsync({
              cfg,
              provider: resolvedModel.provider,
              model,
              fallbackContextTokens: configContextTokens ?? undefined,
            })) ?? null;
          const contextTokens = shouldRepairStoredContextTokens({
            cfg,
            agentId,
            entry,
            resolvedContextTokens,
          })
            ? resolvedContextTokens
            : (storedContextTokens ?? resolvedContextTokens);
          const total = resolveFreshSessionTotalTokens(entry);
          const totalTokensFresh =
            typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
          const remaining =
            contextTokens != null && total !== undefined
              ? Math.max(0, contextTokens - total)
              : null;
          const pct =
            contextTokens && contextTokens > 0 && total !== undefined
              ? Math.min(999, Math.round((total / contextTokens) * 100))
              : null;

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
        }),
    );
    return rows.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  };

  const paths = new Set<string>();
  const byAgent = await Promise.all(
    agentList.agents.map(async (agent) => {
      const storePath = resolveStorePath(cfg.session?.store, { agentId: agent.id });
      paths.add(storePath);
      const store = loadStore(storePath);
      const sessions = await buildSessionRows(store, { agentIdOverride: agent.id });
      return {
        agentId: agent.id,
        path: storePath,
        count: sessions.length,
        recent: sessions.slice(0, 10),
      };
    }),
  );

  const allSessions = (
    await Promise.all(
      Array.from(paths).map(async (storePath) => await buildSessionRows(loadStore(storePath))),
    )
  )
    .flat()
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
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
    sessions: {
      paths: Array.from(paths),
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
