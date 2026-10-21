import type { SystemInfoResult } from "../../packages/gateway-protocol/src/schema/system-info.js";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { readStartupRecoveryWarning } from "../agents/main-session-recovery/main-session-restart-recovery-diagnostics.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { resolveProjectedSessionContextTokens } from "../config/sessions/context-token-provenance.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import {
  hasSessionActiveAutoModelFallback,
  hasUserPinnedModelSelection,
} from "../config/sessions/model-override-provenance.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionEntrySummary } from "../config/sessions/session-accessor.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  resolveFreshSessionTotalTokens,
  resolveSessionTotalTokens,
  type SessionEntry,
} from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveCronDeliverySessionKey } from "../cron/session-target.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import type { GatewayPluginReloadStatus } from "../gateway/server-plugin-reload-status.types.js";
import type { SessionRowProjection } from "../gateway/session-row-projection.js";
import { getGatewayInstallationReplacement } from "../gateway/stale-install.js";
import {
  projectHeartbeatSummary,
  readHeartbeatSummarySnapshot,
} from "../infra/heartbeat-summary-snapshot.js";
import { hasResolvableProactiveOwnerRoute } from "../infra/outbound/targets.js";
import { readStartupMigrationWarning } from "../infra/state-migrations.messages.js";
import { resolveSystemEventQueueKey } from "../infra/system-event-ownership.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { readModelReasoningWarning } from "../logging/diagnostic-session-state.js";
import {
  listActiveDegradedPlugins,
  toPublicPluginVerificationDiagnostic,
} from "../plugins/runtime-degraded-state.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getSecretEgressCertificateStatus } from "../secrets/egress-proxy/registry.js";
import {
  listActiveDegradedSecretOwners,
  redactSecretDegradationReason,
} from "../secrets/runtime-degraded-state.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { sortAndLimitBy } from "../shared/sort-and-limit.js";
import { readOpenClawStateWalHealth } from "../state/openclaw-state-db-cache.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { buildStatusCliProjection } from "./cli-projection.js";
import {
  prepareStatusSessionStores,
  STATUS_RECENT_SESSION_LIMIT,
  type PreparedStatusSessionStores,
} from "./session-stores.js";
import type { HeartbeatStatus, SessionStatus } from "./types.js";
import { collectUtilityModelWarnings } from "./utility-model-warnings.js";

const channelSummaryModuleLoader = createLazyImportLoader(
  () => import("../infra/channel-summary.js"),
);
const channelPluginIdsModuleLoader = createLazyImportLoader(
  () => import("../plugins/channel-plugin-ids.js"),
);
const linkChannelModuleLoader = createLazyImportLoader(() => import("./link-channel.js"));

const loadStatusSummaryRuntimeModule = createLazyRuntimeSurface(
  () => import("./summary.runtime.js"),
  ({ statusSummaryRuntime }) => statusSummaryRuntime,
);

const buildFlags = (entry?: SessionEntry): string[] => {
  if (!entry) {
    return [];
  }
  const stringFlag = (label: string, value?: string) => (value ? `${label}:${value}` : undefined);
  let fastFlag: string | undefined;
  if (entry.fastMode === "auto" || entry.fastMode === "ultrafast") {
    fastFlag = `fast:${entry.fastMode}`;
  } else if (entry.fastMode !== undefined) {
    fastFlag = entry.fastMode ? "fast" : "fast:off";
  }
  return [
    stringFlag("think", entry.thinkingLevel),
    stringFlag("verbose", entry.verboseLevel),
    fastFlag,
    stringFlag("reasoning", entry.reasoningLevel),
    stringFlag("elevated", entry.elevatedLevel),
    entry.systemSent ? "system" : undefined,
    entry.abortedLastRun ? "aborted" : undefined,
    stringFlag("id", entry.sessionId),
  ].filter((flag): flag is string => flag !== undefined);
};

function compareSessionCandidatesByUpdatedAt(
  left: SessionEntrySummary,
  right: SessionEntrySummary,
) {
  return (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0);
}

async function prepareSessionStatusDetails(
  cfg: OpenClawConfig,
  now: number,
  candidates: readonly SessionEntrySummary[],
) {
  const {
    classifySessionKey,
    resolveConfiguredStatusModelRef,
    resolveAuthoredModelContextTokens,
    resolveContextTokensForModel,
    resolveSessionRuntime,
    readSessionRuntimeMetadata,
    resolveSessionModelRef,
    resolveStatusModelComparisonLabel,
    resolveStatusModelLookupRef,
    createStatusModelContextResolver,
  } = await loadStatusSummaryRuntimeModule();
  // Read runtime metadata once for every displayed row, including overlapping windows.
  const metadata = await readSessionRuntimeMetadata(cfg, candidates);
  const resolveModelContext = await createStatusModelContextResolver(cfg);

  const resolved = resolveConfiguredStatusModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const configModelContext = await resolveModelContext(
    resolved.provider ?? DEFAULT_PROVIDER,
    configModel,
  );
  const configContextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: resolved.provider ?? DEFAULT_PROVIDER,
      model: configModel,
      ...configModelContext,
      // Keep `status`/`status --json` startup read-only. These summary lookups
      // use offline static catalogs but never start live provider discovery.
      allowAsyncLoad: false,
      allowCacheLookup: false,
    }) ?? null;

  // Project each candidate once; agent and aggregate windows only select these facts.
  const sessionRows = new Map<SessionEntrySummary, SessionStatus>();
  await Promise.all(
    candidates.map(async (candidate, index) => {
      const { sessionKey: key, entry } = candidate;
      const agentId = parseAgentSessionKey(key)?.agentId;
      const updatedAt = entry.updatedAt ?? null;
      const age = updatedAt ? now - updatedAt : null;
      const configuredForSession = resolveConfiguredStatusModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        agentId,
      });
      const configuredSessionModel = configuredForSession.model ?? DEFAULT_MODEL;
      const configuredSessionModelLabel = `${configuredForSession.provider ?? DEFAULT_PROVIDER}/${configuredSessionModel}`;
      const resolvedModel = resolveSessionModelRef(configuredForSession, entry);
      const model = resolvedModel.model ?? configuredSessionModel;
      const lookupModel =
        resolveStatusModelLookupRef({
          provider: resolvedModel.provider,
          model,
          defaultProvider: configuredForSession.provider ?? DEFAULT_PROVIDER,
        }) ?? resolvedModel;
      const lookupModelId = lookupModel.model ?? model;
      const selectedModelLabel =
        resolvedModel.provider && model ? `${resolvedModel.provider}/${model}` : model;
      const configuredSessionModelComparisonLabel = resolveStatusModelComparisonLabel({
        provider: configuredForSession.provider ?? DEFAULT_PROVIDER,
        model: configuredSessionModel,
        defaultProvider: DEFAULT_PROVIDER,
      });
      const selectedModelComparisonLabel = resolveStatusModelComparisonLabel({
        provider: resolvedModel.provider,
        model,
        defaultProvider: configuredForSession.provider ?? DEFAULT_PROVIDER,
      });
      const runtimeMatchesConfiguredModel =
        selectedModelComparisonLabel != null &&
        configuredSessionModelComparisonLabel != null &&
        areRuntimeModelRefsEquivalent(
          selectedModelComparisonLabel,
          configuredSessionModelComparisonLabel,
          { config: cfg },
        );
      const contextModelProvider = runtimeMatchesConfiguredModel
        ? configuredForSession.provider
        : lookupModel.provider;
      const modelSelectionDiffers =
        selectedModelComparisonLabel != null &&
        configuredSessionModelComparisonLabel != null &&
        selectedModelComparisonLabel !== configuredSessionModelComparisonLabel &&
        !runtimeMatchesConfiguredModel &&
        (hasUserPinnedModelSelection(entry) || hasSessionActiveAutoModelFallback(entry));
      // Session rows show the live selected model and warn for user-pinned
      // differences as well as runtime fallback selections (#96126).
      const runtime = resolveSessionRuntime({
        cfg,
        entry,
        provider: lookupModel.provider,
        model: lookupModelId,
        agentId,
        sessionKey: key,
        acpMeta: metadata[index] ?? null,
      });
      const modelContext = await resolveModelContext(
        lookupModel.provider,
        lookupModelId,
        agentId,
        runtime.id,
        entry,
      );
      const resolvedContextTokens = resolveContextTokensForModel({
        cfg,
        provider: lookupModel.provider,
        model: lookupModelId,
        ...modelContext,
        allowAsyncLoad: false,
        allowCacheLookup: false,
      });
      const contextTokens =
        resolveProjectedSessionContextTokens({
          entry,
          provider: lookupModel.provider,
          model: lookupModelId,
          agentHarnessId: runtime.id,
          resolvedContextTokens,
          authoredContextTokens: resolveAuthoredModelContextTokens({
            cfg,
            provider: lookupModel.provider,
            modelProvider: contextModelProvider,
            model: lookupModelId,
          }),
        }) ?? null;
      const total = resolveSessionTotalTokens(entry);
      const freshTotal = resolveFreshSessionTotalTokens(entry);
      const totalTokensFresh = freshTotal !== undefined;
      const remaining =
        contextTokens != null && freshTotal !== undefined
          ? Math.max(0, contextTokens - freshTotal)
          : null;
      const pct =
        contextTokens && contextTokens > 0 && freshTotal !== undefined
          ? Math.min(999, Math.round((freshTotal / contextTokens) * 100))
          : null;
      const row = {
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
        configuredModel: configuredSessionModelLabel,
        selectedModel: selectedModelLabel,
        modelSelectionReason: modelSelectionDiffers
          ? hasUserPinnedModelSelection(entry)
            ? "session override"
            : "fallback selected"
          : null,
        runtime: runtime.label,
        contextTokens,
        flags: buildFlags(entry),
      } satisfies SessionStatus;
      sessionRows.set(candidate, row);
    }),
  );

  return {
    defaults: { model: configModel, contextTokens: configContextTokens },
    buildSessionRows: (rows: readonly SessionEntrySummary[]) =>
      rows.map((candidate) => sessionRows.get(candidate)!),
  };
}

/** Builds the aggregate status summary at its final synchronous publication boundary. */
export async function getStatusSummary(options: Parameters<typeof prepareStatusSummary>[0] = {}) {
  return (await prepareStatusSummary(options)).publish().summary;
}

/** Composing CLI owners retain this preparation until their remaining work settles. */
export async function prepareStatusSummary(
  options: {
    includeSensitive?: boolean;
    includeChannelSummary?: boolean;
    includeCliProjection?: boolean;
    config?: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
    hostDesktopStatus?: import("../gateway/desktop/host-source.js").HostDesktopStatus;
    sessionStores?: PreparedStatusSessionStores;
    sessionRowProjection?: SessionRowProjection;
  } = {},
) {
  const { includeSensitive = true, includeChannelSummary = true } = options;
  const cfg = options.config ?? (await captureRuntimeConfigAsyncReader()());
  const channelScopeConfig =
    options.sourceConfig === undefined
      ? { config: cfg }
      : { config: cfg, activationSourceConfig: options.sourceConfig };
  const needsChannelPlugins =
    includeChannelSummary &&
    (await channelPluginIdsModuleLoader
      .load()
      .then(({ hasConfiguredChannelsForReadOnlyScopeAsync }) =>
        hasConfiguredChannelsForReadOnlyScopeAsync(channelScopeConfig),
      ));
  const linkContext = needsChannelPlugins
    ? await linkChannelModuleLoader
        .load()
        .then(({ resolveLinkChannelContext }) =>
          resolveLinkChannelContext(cfg, { sourceConfig: options.sourceConfig }),
        )
    : null;
  const agentList = await listGatewayAgentsBasic(cfg);
  // Receipts list the primary job first; retain it when converted siblings share an agent.
  const heartbeatJobs = new Map(
    (await readHeartbeatSummarySnapshot(cfg)).toReversed().map((job) => [job.agentId, job]),
  );
  // Share the remaining per-agent main-session resolution across the fleet.
  const heartbeatInputs = withAgentRosterFactsBatch(cfg, () => {
    return agentList.agents.map((agent) => {
      const job = heartbeatJobs.get(agent.id);
      const summary = projectHeartbeatSummary(job);
      let routeTarget:
        | {
            storePath: string;
            sessionKey: string;
            target: "last" | "owner";
            policy: Parameters<typeof hasResolvableProactiveOwnerRoute>[0]["policy"];
          }
        | undefined;
      if (
        summary.enabled &&
        !agent.admissionRefusal &&
        (summary.target === "last" || summary.target === "owner")
      ) {
        // A literal global row belongs to the job's selected agent store.
        const sessionKey =
          (job && resolveCronDeliverySessionKey(job)) ??
          (cfg.session?.scope === "global"
            ? "global"
            : resolveAgentMainSessionKey({ cfg, agentId: agent.id }));
        routeTarget = {
          storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: agent.id }),
          sessionKey,
          target: summary.target,
          policy: job?.delivery,
        };
      }
      const status: HeartbeatStatus = {
        agentId: agent.id,
        enabled: summary.enabled && !agent.admissionRefusal,
        every: summary.every,
        everyMs: summary.everyMs,
        waitingForRoute: false,
      };
      return { status, routeTarget };
    });
  });
  const heartbeatStores = new Map<
    string,
    { agentId: string; storePath: string; sessionKeys: string[] }
  >();
  for (const { status, routeTarget } of heartbeatInputs) {
    if (!routeTarget) {
      continue;
    }
    let store = heartbeatStores.get(routeTarget.storePath);
    if (!store) {
      store = { agentId: status.agentId, storePath: routeTarget.storePath, sessionKeys: [] };
      heartbeatStores.set(routeTarget.storePath, store);
    }
    store.sessionKeys.push(routeTarget.sessionKey);
  }
  const heartbeatStoreInputs = [...heartbeatStores.values()];
  const heartbeatEntries = heartbeatStoreInputs.length
    ? await withSessionEntriesFromStoresInWorker(
        heartbeatStoreInputs.map(({ agentId, storePath, sessionKeys }) => ({
          agentId,
          storePath,
          sessionKeys,
          projection: "exact",
          snapshotFields: [],
        })),
        (reads) =>
          new Map(
            reads.flatMap(({ result }, index) =>
              result.entries.map(
                (row) =>
                  [
                    `${heartbeatStoreInputs[index]!.storePath}\0${row.sessionKey}`,
                    row.entry,
                  ] as const,
              ),
            ),
          ),
      )
    : new Map<string, SessionEntry>();
  const heartbeatAgents: HeartbeatStatus[] = [];
  for (const { status, routeTarget } of heartbeatInputs) {
    if (routeTarget) {
      const entry = heartbeatEntries.get(`${routeTarget.storePath}\0${routeTarget.sessionKey}`);
      if (routeTarget.target === "last") {
        const route = deliveryContextFromSession(entry);
        status.waitingForRoute = !(route?.channel && route.to);
      } else {
        status.waitingForRoute = !(await hasResolvableProactiveOwnerRoute({
          cfg,
          agentId: status.agentId,
          entry,
          policy: routeTarget.policy,
        }));
      }
    }
    heartbeatAgents.push(status);
  }
  const channelSummary = needsChannelPlugins
    ? await channelSummaryModuleLoader.load().then(({ buildChannelSummary }) =>
        buildChannelSummary(cfg, {
          colorize: true,
          includeAllowFrom: true,
          sourceConfig: options.sourceConfig,
        }),
      )
    : [];
  const now = Date.now();

  const sessionStores =
    options.sessionStores ??
    (await prepareStatusSessionStores(
      cfg,
      agentList.agents,
      includeSensitive ? STATUS_RECENT_SESSION_LIMIT : 0,
      { projection: options.sessionRowProjection },
    ));
  const sessionDetails = includeSensitive
    ? await prepareSessionStatusDetails(cfg, now, sessionStores.candidates)
    : undefined;
  const hostDesktopStatus =
    options.hostDesktopStatus ??
    (
      await (
        await import("../gateway/desktop/host-source.js")
      ).inspectHostDesktop({ config: cfg.desktop?.host })
    ).status;
  const secretEgressProxy = await getSecretEgressCertificateStatus();
  const databaseStores = options.includeCliProjection
    ? (
        await import("../infra/database-engine/admitted-diagnostics.js")
      ).describeAdmittedDatabaseStores(cfg)
    : undefined;
  const utilityModelWarnings = collectUtilityModelWarnings(cfg);
  return {
    publish() {
      const publishedStores = sessionStores.publish();
      const survivingIds = new Set(publishedStores.byAgent.map(({ agent }) => agent.id));
      const survivingAgents = agentList.agents.filter(({ id }) => survivingIds.has(id));
      const publishedAgentList = {
        ...agentList,
        defaultId: survivingIds.has(agentList.defaultId)
          ? agentList.defaultId
          : survivingAgents[0]?.id,
        agents: survivingAgents,
      };
      const recentCandidates = sortAndLimitBy(
        publishedStores.recent,
        STATUS_RECENT_SESSION_LIMIT,
        compareSessionCandidatesByUpdatedAt,
      );
      const byAgent = publishedStores.byAgent.map(({ agent, path, count, recent }) => ({
        agentId: agent.id,
        ...(agent.status ? { status: agent.status } : {}),
        ...(includeSensitive && agent.admissionRefusal
          ? { admissionRefusal: agent.admissionRefusal }
          : {}),
        path: includeSensitive ? path : "[redacted]",
        count,
        recent: sessionDetails ? sessionDetails.buildSessionRows(recent) : [],
      }));
      const recent = sessionDetails ? sessionDetails.buildSessionRows(recentCandidates) : [];
      const queuedSystemEvents = publishedAgentList.agents.flatMap(({ id: agentId }) =>
        peekSystemEvents(
          resolveSystemEventQueueKey(
            resolveCanonicalMainSessionKey({
              agentId,
              mainKey: cfg.session?.mainKey,
              sessionScope: cfg.session?.scope,
            }),
            agentId,
          ),
        ),
      );
      const sqliteWal = readOpenClawStateWalHealth();
      return {
        sessionStores: publishedStores,
        summary: {
          runtimeVersion: resolveRuntimeServiceVersion(process.env),
          ...(databaseStores
            ? {
                databaseStores: includeSensitive
                  ? databaseStores
                  : databaseStores.map((store) => Object.assign({}, store, { path: null })),
              }
            : {}),
          ...(options.includeCliProjection
            ? { cliProjection: buildStatusCliProjection(cfg, publishedAgentList) }
            : {}),
          sqliteWal:
            sqliteWal && !includeSensitive ? { ...sqliteWal, error: undefined } : sqliteWal,
          hostDesktop: hostDesktopStatus,
          linkChannel: linkContext
            ? {
                id: linkContext.plugin.id,
                label: linkContext.plugin.meta.label ?? "Channel",
                linked: linkContext.linked,
                authAgeMs: linkContext.authAgeMs,
              }
            : undefined,
          heartbeat: {
            defaultAgentId: publishedAgentList.defaultId,
            agents: heartbeatAgents.filter(({ agentId }) => survivingIds.has(agentId)),
          },
          channelSummary,
          queuedSystemEvents,
          startupMigrationWarning: readStartupMigrationWarning(includeSensitive),
          startupRecoveryWarning: readStartupRecoveryWarning(includeSensitive),
          modelReasoningWarning: readModelReasoningWarning(includeSensitive),
          installationReplacementWarning: getGatewayInstallationReplacement()?.message,
          ...(utilityModelWarnings.length
            ? {
                utilityModelWarnings: includeSensitive
                  ? utilityModelWarnings
                  : [
                      {
                        path: "utilityModel",
                        message:
                          "A configured utility model cannot enforce tool-free utility work. Choose a capable utility model or add capable utilityModel fallbacks.",
                      },
                    ],
              }
            : {}),
          secretEgressProxy,
          degradedSecretOwners: listActiveDegradedSecretOwners().map(
            ({ ownerKind, ownerId, state, degradationState, paths, reason }) => ({
              ownerKind,
              ownerId,
              state,
              degradationState: degradationState ?? "cold",
              paths,
              reason: redactSecretDegradationReason(reason),
            }),
          ),
          degradedPlugins: listActiveDegradedPlugins().map(({ pluginId, state, diagnostic }) => ({
            pluginId,
            state,
            diagnostic: toPublicPluginVerificationDiagnostic(diagnostic),
          })),
          sessions: {
            paths: includeSensitive ? publishedStores.paths : [],
            count: publishedStores.count,
            defaults: sessionDetails?.defaults ?? { model: null, contextTokens: null },
            recent,
            byAgent,
          },
        },
      };
    },
  };
}

type GatheredStatusSummary = Awaited<ReturnType<typeof getStatusSummary>>;

/** Aggregate status summary, including cold-start and Gateway health compatibility fields. */
export type StatusSummary = Omit<
  Partial<GatheredStatusSummary>,
  "runtimeVersion" | "degradedSecretOwners"
> &
  Pick<
    GatheredStatusSummary,
    "heartbeat" | "channelSummary" | "queuedSystemEvents" | "sessions"
  > & {
    runtimeVersion?: string | null;
    childRuntime?: {
      execPath: string;
      available: boolean;
    };
    eventLoop?: NonNullable<SystemInfoResult["eventLoop"]>;
    processMemory?: NonNullable<SystemInfoResult["processMemory"]>;
    pluginReload?: GatewayPluginReloadStatus;
    degradedSecretOwners?: Array<
      Omit<
        NonNullable<GatheredStatusSummary["degradedSecretOwners"]>[number],
        "degradationState"
      > & { degradationState?: "cold" | "stale" }
    >;
  };
