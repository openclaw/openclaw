import { listA2ATaskEventLogTaskTokens, loadA2ATaskRecordFromEventLog } from "../agents/a2a/log.js";
import { A2A_BROKER_ADAPTER_PLUGIN_ID } from "../agents/a2a/standalone-broker-client.js";
import { buildA2ATaskProtocolStatus, classifyA2AExecutionStatus } from "../agents/a2a/status.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { readSessionStoreReadOnly } from "../config/sessions/store-read.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import type {
  A2AStatusSummary,
  HeartbeatStatus,
  SessionStatus,
  StatusContributorSummary,
  StatusSummary,
} from "./status.types.js";

let channelSummaryModulePromise: Promise<typeof import("../infra/channel-summary.js")> | undefined;
let linkChannelModulePromise: Promise<typeof import("./status.link-channel.js")> | undefined;
let configIoModulePromise: Promise<typeof import("../config/io.js")> | undefined;
let taskRegistryMaintenanceModulePromise:
  | Promise<typeof import("../tasks/task-registry.maintenance.js")>
  | undefined;

const A2A_DELAYED_HEARTBEAT_MS = 10 * 60_000;
const A2A_REQUIRED_METHODS = [
  "a2a.task.request",
  "a2a.task.update",
  "a2a.task.cancel",
  "a2a.task.status",
] as const;

function loadChannelSummaryModule() {
  channelSummaryModulePromise ??= import("../infra/channel-summary.js");
  return channelSummaryModulePromise;
}

function loadLinkChannelModule() {
  linkChannelModulePromise ??= import("./status.link-channel.js");
  return linkChannelModulePromise;
}

const loadStatusSummaryRuntimeModule = createLazyRuntimeSurface(
  () => import("./status.summary.runtime.js"),
  ({ statusSummaryRuntime }) => statusSummaryRuntime,
);

function loadConfigIoModule() {
  configIoModulePromise ??= import("../config/io.js");
  return configIoModulePromise;
}

function loadTaskRegistryMaintenanceModule() {
  taskRegistryMaintenanceModulePromise ??= import("../tasks/task-registry.maintenance.js");
  return taskRegistryMaintenanceModulePromise;
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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isA2ATaskDelayed(entry: {
  statusCategory: string;
  executionStatus: string;
  startedAt?: number;
  heartbeatAt?: number;
  updatedAt: number;
}): boolean {
  if (entry.statusCategory !== "active" || entry.executionStatus === "waiting_external") {
    return false;
  }
  const reference = entry.heartbeatAt ?? entry.startedAt ?? entry.updatedAt;
  return Date.now() - reference >= A2A_DELAYED_HEARTBEAT_MS;
}

function isBrokerUnreachableCode(code?: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(code);
  return (
    normalized === "broker_unavailable" ||
    normalized === "broker_timeout" ||
    normalized === "broker_request_failed"
  );
}

function isReconcileFailureCode(code?: string): boolean {
  return normalizeLowercaseStringOrEmpty(code) === "broker_malformed_response";
}

function resolveA2AHealthState(
  summary: Omit<A2AStatusSummary, "state">,
): A2AStatusSummary["state"] {
  if (
    summary.broker.pluginEnabled &&
    (!summary.broker.baseUrlPresent || !summary.broker.methodScopesOk)
  ) {
    return "config_error";
  }
  if (summary.tasks.waitingExternal > 0 || summary.issues.brokerUnreachable > 0) {
    return "waiting_external";
  }
  if (
    summary.tasks.failed > 0 ||
    summary.issues.reconcileFailed > 0 ||
    summary.issues.deliveryFailed > 0 ||
    summary.issues.cancelNotAttempted > 0 ||
    summary.issues.sessionAbortFailed > 0
  ) {
    return "failed";
  }
  if (summary.tasks.delayed > 0) {
    return "delayed";
  }
  return "ok";
}


function buildA2AStatusContributor(summary: A2AStatusSummary): StatusContributorSummary {
  const state: StatusContributorSummary["state"] =
    summary.state === "ok"
      ? "ok"
      : summary.state === "delayed" || summary.state === "waiting_external"
        ? "warn"
        : summary.state === "failed" || summary.state === "config_error"
          ? "error"
          : "info";
  const summaryLabelByState: Record<A2AStatusSummary["state"], string> = {
    ok: "ok",
    delayed: "delayed",
    waiting_external: "waiting external",
    failed: "failed",
    config_error: "config error",
  };
  const details: string[] = [`broker ${summary.broker.adapterEnabled ? "on" : "off"}`];
  if (summary.tasks.active > 0) {
    details.push(`${summary.tasks.active} active`);
  } else {
    details.push("no active");
  }
  if (summary.tasks.waitingExternal > 0) {
    details.push(`${summary.tasks.waitingExternal} waiting external`);
  }
  if (summary.tasks.delayed > 0) {
    details.push(`${summary.tasks.delayed} delayed`);
  }
  if (summary.tasks.failed > 0) {
    details.push(`${summary.tasks.failed} failed`);
  }
  if (summary.state === "config_error") {
    if (!summary.broker.baseUrlPresent) {
      details.push("baseUrl missing");
    }
    if (!summary.broker.methodScopesOk) {
      details.push("scope map missing");
    }
  } else if (summary.tasks.latestFailed) {
    const detail =
      summary.tasks.latestFailed.errorMessage ??
      summary.tasks.latestFailed.errorCode ??
      summary.tasks.latestFailed.summary ??
      summary.tasks.latestFailed.taskId;
    if (detail) {
      details.push(`latest ${detail}`);
    }
  }
  return {
    id: "a2a",
    label: "A2A",
    state,
    summary: summaryLabelByState[summary.state],
    details,
  };
}

async function buildA2AStatusSummary(params: {
  cfg: OpenClawConfig;
  agentIds: string[];
}): Promise<A2AStatusSummary> {
  const pluginEntry = params.cfg.plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID];
  const pluginConfig = pluginEntry?.config;
  const broker = {
    pluginEnabled: Boolean(pluginEntry) && pluginEntry?.enabled !== false,
    adapterEnabled:
      Boolean(pluginEntry) &&
      pluginEntry?.enabled !== false &&
      Boolean(readOptionalString(pluginConfig?.baseUrl)),
    baseUrlPresent: Boolean(readOptionalString(pluginConfig?.baseUrl)),
    edgeSecretPresent: Boolean(readOptionalString(pluginConfig?.edgeSecret)),
    methodScopesOk: A2A_REQUIRED_METHODS.every(
      (method) => resolveLeastPrivilegeOperatorScopesForMethod(method).length > 0,
    ),
  } satisfies A2AStatusSummary["broker"];

  const indexed: Array<
    {
      agentId: string;
      sessionKey: string;
      statusCategory: ReturnType<typeof classifyA2AExecutionStatus>;
    } & ReturnType<typeof buildA2ATaskProtocolStatus>
  > = [];

  for (const agentId of params.agentIds) {
    const sessionKey = `agent:${agentId}:main`;
    let taskIds: string[] = [];
    try {
      taskIds = await listA2ATaskEventLogTaskTokens({ sessionKey });
    } catch {
      continue;
    }
    if (taskIds.length === 0) {
      continue;
    }
    const rows = await Promise.all(
      taskIds.map(async (taskId) => {
        try {
          const record = await loadA2ATaskRecordFromEventLog({ sessionKey, taskId });
          if (!record) {
            return null;
          }
          const status = buildA2ATaskProtocolStatus(record);
          return {
            agentId,
            sessionKey: record.envelope.target.sessionKey,
            ...status,
            statusCategory: classifyA2AExecutionStatus(status.executionStatus),
          };
        } catch {
          return null;
        }
      }),
    );
    indexed.push(...rows.filter((row) => row !== null));
  }

  const failures = indexed
    .filter((entry) => entry.statusCategory === "terminal-failure")
    .toSorted((a, b) => b.updatedAt - a.updatedAt);

  const summaryWithoutState = {
    tasks: {
      total: indexed.length,
      active: indexed.filter((entry) => entry.statusCategory === "active").length,
      failed: failures.length,
      waitingExternal: indexed.filter((entry) => entry.executionStatus === "waiting_external")
        .length,
      delayed: indexed.filter((entry) => isA2ATaskDelayed(entry)).length,
      latestFailed: failures[0]
        ? {
            agentId: failures[0].agentId,
            sessionKey: failures[0].sessionKey,
            taskId: failures[0].taskId,
            executionStatus: failures[0].executionStatus,
            deliveryStatus: failures[0].deliveryStatus,
            updatedAt: failures[0].updatedAt,
            ...(failures[0].error?.code ? { errorCode: failures[0].error.code } : {}),
            ...(failures[0].error?.message ? { errorMessage: failures[0].error.message } : {}),
            ...(failures[0].summary ? { summary: failures[0].summary } : {}),
          }
        : null,
    },
    issues: {
      brokerUnreachable: indexed.filter((entry) => isBrokerUnreachableCode(entry.error?.code))
        .length,
      reconcileFailed: indexed.filter((entry) => isReconcileFailureCode(entry.error?.code)).length,
      deliveryFailed: indexed.filter((entry) => entry.deliveryStatus === "failed").length,
      cancelNotAttempted: indexed.filter((entry) => {
        const code = normalizeLowercaseStringOrEmpty(entry.error?.code);
        const message = normalizeLowercaseStringOrEmpty(entry.error?.message);
        return code === "cancel_not_attempted" || message.includes("abort not wired");
      }).length,
      sessionAbortFailed: indexed.filter((entry) => {
        const code = normalizeLowercaseStringOrEmpty(entry.error?.code);
        const message = normalizeLowercaseStringOrEmpty(entry.error?.message);
        return code === "session_abort_failed" || message.includes("abort failed");
      }).length,
    },
    broker,
  } satisfies Omit<A2AStatusSummary, "state">;

  return {
    ...summaryWithoutState,
    state: resolveA2AHealthState(summaryWithoutState),
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
  const {
    classifySessionKey,
    resolveConfiguredStatusModelRef,
    resolveContextTokensForModel,
    resolveSessionModelRef,
  } = await loadStatusSummaryRuntimeModule();
  const cfg = options.config ?? (await loadConfigIoModule()).loadConfig();
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
  const taskMaintenanceModule = await loadTaskRegistryMaintenanceModule();
  const tasks = taskMaintenanceModule.getInspectableTaskRegistrySummary();
  const taskAudit = taskMaintenanceModule.getInspectableTaskAuditSummary();
  const a2a = await buildA2AStatusSummary({
    cfg,
    agentIds: agentList.agents.map((agent) => agent.id),
  });

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
  const storeCache = new Map<string, Record<string, SessionEntry | undefined>>();
  const loadStore = (storePath: string) => {
    const cached = storeCache.get(storePath);
    if (cached) {
      return cached;
    }
    const store = readSessionStoreReadOnly(storePath);
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
            allowAsyncLoad: false,
          }) ?? null;
        const total = resolveFreshSessionTotalTokens(entry);
        const totalTokensFresh =
          typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
        const canComputeContextUtilization =
          contextTokens != null && total !== undefined && total <= contextTokens;
        const remaining = canComputeContextUtilization ? Math.max(0, contextTokens - total) : null;
        const pct =
          canComputeContextUtilization && contextTokens > 0
            ? Math.min(999, Math.round((total / contextTokens) * 100))
            : null;
        const parsedAgentId = parseAgentSessionKey(key)?.agentId;
        const agentId = opts.agentIdOverride ?? parsedAgentId;

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

  const contributors: StatusContributorSummary[] = [];
  contributors.push(buildA2AStatusContributor(a2a));

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
    contributors,
    a2a,
    tasks,
    taskAudit,
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
