import { createHash } from "node:crypto";
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { SESSION_PARTICIPANT_LIMIT } from "../../packages/gateway-protocol/src/schema/session-participant.js";
import { resolveModelContextTokenProjection } from "../agents/context.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import { resolveQueueSettingsCore } from "../auto-reply/reply/queue/settings.js";
import { resolveEffectiveResponseUsage } from "../auto-reply/thinking.js";
import {
  resolveFreshSessionTotalTokens,
  resolveProjectedSessionContextTokens,
  type InternalSessionEntry,
  type SessionEntry,
  resolveProjectedSessionContextBudgetStatus,
  SESSION_TOTAL_TOKENS_VERSION,
} from "../config/sessions.js";
import { resolveSessionModelOverrideSource } from "../config/sessions/model-override-provenance.js";
import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import {
  sessionCreatorProfileId,
  MAX_SESSION_PARTICIPANTS,
} from "../config/sessions/session-entry-provenance.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildProjectedAgentRunIndex,
  resolveProjectedAgentRunModel,
  type ProjectedAgentRunIndex,
} from "../infra/agent-run-registry.js";
import { projectPluginSessionExtensionsSync } from "../plugins/host-hook-state.js";
import { resolveActiveSessionAgentStatus } from "../sessions/session-agent-status.js";
import { deriveSessionUnread } from "../shared/session-unread.js";
import { runSynchronousWork } from "../shared/synchronous-work.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { resolveActiveFallbackState } from "../status/fallback-notice-state.js";
import { readSessionFallbackModel } from "../status/session-fallback-model.js";
import { projectSessionDeliveryFields } from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { buildControlUiChannelAvatarUrl } from "./control-ui-contract.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { readPreparedGatewayModelCatalogMetadata } from "./server-model-catalog-view.js";
import { sessionHasAutomation } from "./session-automation-index.js";
import { sessionClassificationForRow } from "./session-classification.js";
import {
  projectSessionActor,
  projectSessionOwner,
  projectSessionParticipants,
} from "./session-identity-projection.js";
import { isSessionPermissionChangePending } from "./session-permission-change.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { buildSessionSwarmSummary } from "./session-swarm-summary.js";
import { readSessionTitleFieldsFromTranscript as readScopedSessionTitleFieldsFromTranscript } from "./session-transcript-title-reader.js";
import type {
  GatewaySessionModelSource,
  SessionListRowContext,
} from "./session-utils-contracts.js";
import {
  deriveSessionTitle,
  resolveEstimatedSessionCostUsd,
  resolvePositiveNumber,
  buildStoreChildSessionLinksWork,
  type SessionChildLink,
  resolveSessionChildOwners,
  resolveSessionCompactionSummary,
} from "./session-utils-core.js";
import {
  resolveGatewaySessionDisplayName,
  projectGatewaySessionRunState,
  resolveGatewaySessionKind,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import { resolveSessionSelectedModelRef } from "./session-utils-model-selection.js";
import {
  resolveGatewaySessionThinkingProjectionInternal,
  resolveSessionDisplayModelIdentityRefCached,
} from "./session-utils-model.js";
import {
  buildSessionListRowMetadataContext,
  resolveTranscriptUsageFallbacks,
} from "./session-utils-projection.js";
import { parseGroupKey } from "./session-utils-store.js";
import type { GatewaySessionRow, SessionListModelCatalog } from "./session-utils.types.js";
import { projectWorkerPlacementAgentRuntime } from "./worker-environments/placement-session-runtime.js";

export function readSessionRowInputs(params: {
  cfg: OpenClawConfig;
  storePath: string;
  storeAgentId?: string;
  active?: boolean;
  store: Record<string, SessionEntry>;
  modelSource?: GatewaySessionModelSource;
  key: string;
  entry?: InternalSessionEntry;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  now?: number;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  transcriptUsageMaxBytes?: number;
  storeChildSessionLinksByKey?: Map<string, SessionChildLink[]>;
  excludedChildKeys?: ReadonlySet<string>;
  rowContext?: SessionListRowContext;
  configuredAgentIds?: ReadonlySet<string>;
  agentId: string;
  skipTranscriptUsageFallback?: boolean;
  lightweightListRow?: boolean;
  includeSwarmChildren?: boolean;
}) {
  const { cfg, storePath, store, key, entry, agentId } = params;
  const lightweight = params.lightweightListRow === true;
  const now = params.now ?? Date.now();
  const rowContext =
    params.rowContext ??
    buildSessionListRowMetadataContext({ now, sessionKeys: [key, ...Object.keys(store)] });
  const owner = projectSessionOwner(
    entry,
    rowContext.userProfileIdentityById,
    cfg,
    params.configuredAgentIds,
  );
  const participants = projectSessionParticipants(entry, rowContext.userProfileIdentityById, cfg);
  if (owner?.actor.identity) {
    participants.delete(JSON.stringify(owner.actor.identity));
  }
  const displayName = resolveGatewaySessionDisplayName(key, entry);
  const preparedCatalog =
    params.modelCatalog instanceof Map ? params.modelCatalog.get(agentId) : undefined;
  const metadataSnapshot = readPreparedGatewayModelCatalogMetadata(preparedCatalog);
  const selectedModel = resolveSessionSelectedModelRef({
    cfg,
    sessionKey: key,
    source: params.modelSource ?? { entry, readSourceEntry: (parentKey) => store[parentKey] },
    agentId,
    rowContext,
    allowPluginNormalization: !lightweight,
    manifestPlugins: metadataSnapshot,
  });
  const freshSessionTotalTokens = asNonNegativeFiniteNumber(resolveFreshSessionTotalTokens(entry));
  const usageByFallbackModel =
    params.skipTranscriptUsageFallback !== true
      ? resolveTranscriptUsageFallbacks({
          cfg,
          key,
          entry,
          storePath,
          freshTotalTokens: freshSessionTotalTokens,
          fallbackModelRefs: [
            undefined,
            ...(rowContext.subagentRunsByChildSessionKey.get(key) ?? []).map((run) => run.model),
          ],
          allowPluginNormalization: !lightweight,
          maxTranscriptBytes: params.transcriptUsageMaxBytes,
          rowContext,
          agentId,
          storeAgentId: params.storeAgentId,
        })
      : undefined;
  const { provider, model } = selectedModel;
  const rowModelIdentity = resolveSessionDisplayModelIdentityRefCached({
    cfg,
    provider,
    model,
    rowContext,
  });

  // Display aliases do not change the selected route's catalog or runtime policy.
  const activeModel = resolveGatewaySessionActiveModel({
    cfg,
    active: params.active,
    storeAgentId: params.storeAgentId,
    selectedModel,
    projectedAgentRuns: (rowContext.projectedAgentRuns ??= buildProjectedAgentRunIndex()),
    entry,
    agentId,
    sessionId: entry?.sessionId,
    sessionKey: key,
    storePath,
  });

  let derivedTitle: string | undefined;
  let lastMessagePreview: string | undefined;
  if (entry?.sessionId && (params.includeDerivedTitles || params.includeLastMessage)) {
    const fields = readScopedSessionTitleFieldsFromTranscript({
      agentId: params.storeAgentId ?? agentId,
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey: key,
      storePath,
    });
    if (params.includeDerivedTitles) {
      derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage, displayName);
    }
    lastMessagePreview = (params.includeLastMessage && fields.lastMessagePreview) || undefined;
  }

  // Entries and provider policy must stay bound to the same prepared agent owner;
  // the Gateway startup registry can contain a different set of plugins.
  const rowModelCatalog =
    params.modelCatalog instanceof Map ? preparedCatalog?.entries : params.modelCatalog;

  // Event/list rows must not rediscover plugin-backed configured catalog metadata.
  // Lightweight projections may use an already-active provider policy, but must
  // not fall through to public artifacts that reload the manifest registry.
  const thinkingProjection = resolveGatewaySessionThinkingProjectionInternal({
    cfg,
    agentId,
    provider: provider ?? DEFAULT_PROVIDER,
    model: model ?? DEFAULT_MODEL,
    sessionKey: resolveStoredSessionKeyForAgentStore({
      cfg,
      agentId,
      sessionKey: key,
    }),
    entry,
    modelCatalog: rowModelCatalog ?? (lightweight ? [] : undefined),
    modelCatalogRouteVariants: preparedCatalog?.routeVariants,
    metadataSnapshot,
    rowContext,
    providerPolicySource: preparedCatalog?.pluginRegistry ?? (lightweight ? "active" : undefined),
  });
  const catalogEntry =
    rowModelCatalog && provider && model ? thinkingProjection.catalogEntry : undefined;
  const contextWindowProfile = resolveModelContextWindowProfile({
    catalogEntry,
    selected: entry?.contextWindow,
  });
  const modelContext = resolveModelContextTokenProjection({
    cfg,
    provider,
    model,
    modelContextTokens: catalogEntry?.contextTokens,
    modelContextWindow: contextWindowProfile.contextTokens,
    allowAsyncLoad: false,
  });
  const resolvedModelContextTokens = resolvePositiveNumber(modelContext.contextTokens);

  const pluginExtensions =
    !lightweight && entry ? projectPluginSessionExtensionsSync({ sessionKey: key, entry }) : [];
  const repositoryWorkspace = entry?.repositoryWorkspaceId
    ? getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId)
    : undefined;

  return {
    inputs: {
      cfg,
      key,
      entry,
      lightweight,
      swarm: buildSessionSwarmSummary(
        params.rowContext?.subagentRuns.swarmRunsByRequesterSessionKey.get(key) ?? [],
        key,
        agentId,
        { includeChildren: params.includeSwarmChildren },
      ),
      permissionModePending: isSessionPermissionChangePending(entry?.sessionId),
      repository:
        repositoryWorkspace?.agentId === agentId && repositoryWorkspace.sessionKey === key
          ? {
              url: repositoryWorkspace.url,
              ...(repositoryWorkspace.requestedRef
                ? { ref: repositoryWorkspace.requestedRef }
                : {}),
              branch: repositoryWorkspace.branch,
            }
          : undefined,
      createdActor: projectSessionActor(
        entry?.createdActor,
        rowContext.userProfileIdentityById,
        cfg,
        Boolean(sessionCreatorProfileId(entry?.createdActor)),
      ),
      owner,
      participants,
      agentId,
      displayName,
      derivedTitle,
      lastMessagePreview,
      archivedBy: projectSessionActor(entry?.archivedBy, rowContext.userProfileIdentityById, cfg),
      thinkingProjection,
      agentRuntime: projectWorkerPlacementAgentRuntime(thinkingProjection.agentRuntime),
      contextWindowProfile,
      fastModeState: resolveFastModeState({
        cfg,
        provider,
        model,
        agentId,
        sessionEntry: entry,
      }),
      hasAutomation: sessionHasAutomation(key, cfg, agentId) ? true : undefined,
      rowModelIdentity,
      selectedModel,
      contextTokens: resolveProjectedSessionContextTokens({
        entry,
        provider,
        model,
        agentHarnessId: thinkingProjection.agentRuntime.id,
        resolvedContextTokens: contextWindowProfile.contextTokens
          ? Math.min(
              resolvedModelContextTokens ?? contextWindowProfile.contextTokens,
              contextWindowProfile.contextTokens,
            )
          : resolvedModelContextTokens,
        authoredContextTokens: resolvePositiveNumber(modelContext.authoredContextTokens),
      }),
      pluginExtensions,
      includeSwarmSummary: params.rowContext !== undefined,
      childLinks: (
        params.storeChildSessionLinksByKey ??
        runSynchronousWork(
          buildStoreChildSessionLinksWork({
            store,
            keys: [key],
            subagentRunsByChildSessionKey: rowContext.subagentRunsByChildSessionKey,
          }),
        )
      ).get(key),
      usageByFallbackModel,
      freshSessionTotalTokens,
      estimatedCostUsd: lightweight
        ? asNonNegativeFiniteNumber(entry?.estimatedCostUsd)
        : resolveEstimatedSessionCostUsd({
            cfg,
            provider,
            model,
            entry,
            rowContext,
          }),
      subagentRunInputs: rowContext.subagentRuns.inputs,
    },
    presentation: {
      now,
      subagentRuns: rowContext.subagentRuns,
      activeModel,
      excludedChildKeys: params.excludedChildKeys,
    },
  };
}

export function buildGatewaySessionRow(
  params: Parameters<typeof readSessionRowInputs>[0],
): GatewaySessionRow {
  const { inputs, presentation } = readSessionRowInputs(params);
  return presentSessionRow(materializeSessionRow(inputs), presentation);
}

function resolveGatewaySessionActiveModel(params: {
  cfg: OpenClawConfig;
  active?: boolean;
  agentId?: string;
  storeAgentId?: string;
  sessionId?: string;
  sessionKey: string;
  projectedAgentRuns: ProjectedAgentRunIndex;
  selectedModel?: { provider: string; model: string };
  modelSource?: GatewaySessionModelSource;
  entry?: InternalSessionEntry;
  storePath?: string;
}): { provider: string; model: string } | undefined {
  if (!params.agentId) {
    return undefined;
  }
  const liveModel = resolveProjectedAgentRunModel({
    agentId: params.agentId,
    sessionId: params.sessionId,
    index: params.projectedAgentRuns,
  });
  if (params.active ?? (liveModel !== undefined || params.entry?.status === "running")) {
    return liveModel ?? undefined;
  }
  if (!params.entry?.fallbackNotice || params.storePath === undefined) {
    return undefined;
  }
  const selectedModel =
    params.selectedModel ??
    (params.modelSource
      ? resolveSessionSelectedModelRef({
          cfg: params.cfg,
          source: params.modelSource,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        })
      : undefined);
  if (!selectedModel) {
    return undefined;
  }

  const { selected, active } = resolveSelectedAndActiveModel({
    selectedProvider: selectedModel.provider,
    selectedModel: selectedModel.model,
    sessionEntry:
      readSessionFallbackModel({
        selectedProvider: selectedModel.provider,
        selectedModel: selectedModel.model,
        sessionEntry: params.entry,
        config: params.cfg,
        sessionScope: {
          agentId: params.storeAgentId ?? params.agentId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        },
      }) ?? params.entry,
  });
  return resolveActiveFallbackState({
    selectedModelRef: selected.label,
    activeModelRef: active.label,
    config: params.cfg,
    state: params.entry,
  }).active
    ? { provider: active.provider, model: active.model }
    : undefined;
}

/** Opaque cache-busting revision for the channel-avatar route; never leaks the reference. */
function channelAvatarRevision(reference: string): string {
  return createHash("sha256").update(reference).digest("base64url").slice(0, 12);
}

export function materializeSessionRow(input: ReturnType<typeof readSessionRowInputs>["inputs"]) {
  const { cfg, key, entry } = input;
  const observerDigest =
    entry?.observerDigest &&
    // Strictly newer: a run end and restart can share a millisecond, and the
    // prior run's digest must not project onto the replacement run.
    (entry.startedAt === undefined || entry.observerDigest.updatedAt > entry.startedAt)
      ? entry.observerDigest
      : undefined;
  const deliveryFields = projectSessionDeliveryFields(entry?.delivery);
  const channel = deliveryFields.channel ?? parseGroupKey(key)?.channel;
  const storedOrigin = deliveryFields.origin;
  const avatar = normalizeOptionalString(storedOrigin?.avatar);
  const controlUiBasePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  const pinnedAt =
    entry?.pinnedAt !== undefined && isPinnableSessionEntry(key, entry)
      ? entry.pinnedAt
      : undefined;
  const compactionSummary = resolveSessionCompactionSummary(entry);

  const participants = input.participants.size ? [...input.participants.values()] : undefined;
  // Reserve temporal fields in wire order; presentation fills a fresh copy.
  const row: GatewaySessionRow = {
    key,
    // Only explicitly requested summaries may clear swarm state in event merges.
    ...(input.includeSwarmSummary ? { swarm: input.swarm } : {}),
    visibility: entry ? (entry.visibility ?? "shared") : undefined,
    incognito: entry?.incognito,
    spawnedBy: undefined,
    controlOwnerSessionKey: undefined,
    swarmGroupId: entry?.swarmGroupId,
    spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
    spawnedCwd: entry?.spawnedCwd,
    workspaceDir: entry?.spawnedCwd ?? entry?.spawnedWorkspaceDir,
    projectId: entry?.projectId,
    permissionMode: entry?.permissionMode,
    permissionModePending: input.permissionModePending,
    ...(entry?.permissionMode !== undefined && entry.sessionRoot !== undefined
      ? { sessionRoot: entry.sessionRoot }
      : {}),
    worktree: entry?.worktree,
    repositoryWorkspaceId: entry?.repositoryWorkspaceId,
    ...(input.repository ? { repository: input.repository } : {}),
    execNode: entry?.execNode,
    execCwd: entry?.execCwd,
    forkedFromParent: sessionEntryForkedFromParent(entry) ? true : undefined,
    spawnDepth: entry?.spawnDepth,
    subagentRole: entry?.subagentRole,
    subagentControlScope: entry?.subagentControlScope,
    createdVia: entry?.createdVia,
    createdActor: input.createdActor,
    owner: input.owner,
    // Keep the released v4 summary stable; expanded identities are additive for newer clients.
    participants: participants?.slice(0, SESSION_PARTICIPANT_LIMIT),
    expandedParticipants: participants?.slice(0, MAX_SESSION_PARTICIPANTS),
    participantCount: participants?.length,
    createdAt: entry?.createdAt,
    forkSource: entry?.forkSource,
    previousSessionId: entry?.previousSessionId,
    kind: resolveGatewaySessionKind(key, entry),
    label: entry?.label,
    autoLabel: entry?.autoLabel,
    icon: entry?.icon,
    color: entry?.color,
    channelAvatarUrl: avatar
      ? buildControlUiChannelAvatarUrl(controlUiBasePath, key, channelAvatarRevision(avatar))
      : undefined,
    category: entry?.category,
    boardFace: entry?.boardFace,
    boardPresentation: entry?.boardPresentation,
    ...sessionClassificationForRow(cfg, key, input.agentId, entry),
    displayName: input.displayName,
    derivedTitle: input.derivedTitle,
    lastMessagePreview: input.lastMessagePreview,
    channel,
    subject: entry?.subject,
    groupChannel: entry?.groupChannel,
    space: entry?.space,
    chatType: entry?.chatType,
    origin: storedOrigin
      ? (({ avatar: _avatar, ...safeOrigin }) => safeOrigin)(storedOrigin)
      : undefined,
    updatedAt: entry?.updatedAt ?? null,
    archived: entry?.archivedAt !== undefined,
    archivedAt: entry?.archivedAt,
    archivedBy: input.archivedBy,
    archiveReason: entry?.archiveReason,
    pinned: pinnedAt !== undefined,
    pinnedAt,
    unread: deriveSessionUnread(entry),
    lastReadAt: entry?.lastReadAt,
    markedUnreadAt: entry?.markedUnreadAt,
    agentStatus: undefined,
    observerDigest: observerDigest
      ? {
          ...(observerDigest.agentId ? { agentId: observerDigest.agentId } : {}),
          runId: observerDigest.runId,
          headline: observerDigest.headline,
          health: observerDigest.health,
          updatedAt: observerDigest.updatedAt,
          revision: observerDigest.revision,
        }
      : undefined,
    lastInteractionAt: entry?.lastInteractionAt,
    lastActivityAt: entry?.lastActivityAt,
    sessionId: entry?.sessionId,
    systemSent: entry?.systemSent,
    abortedLastRun: entry?.abortedLastRun,
    restartRecoveryStatus: entry?.mainRestartRecovery?.tombstone ? "tombstoned" : undefined,
    thinkingLevel: input.thinkingProjection.thinkingLevel,
    contextWindow: input.contextWindowProfile.contextWindow,
    contextWindows: input.contextWindowProfile.contextWindows,
    contextWindowDefault: input.contextWindowProfile.contextWindowDefault,
    thinkingLevels: input.thinkingProjection.thinkingLevels,
    thinkingOptions: input.thinkingProjection.thinkingOptions,
    thinkingDefault: input.thinkingProjection.thinkingDefault,
    fastMode: entry?.fastMode,
    toolOverrides: entry?.toolOverrides,
    effectiveFastMode: input.fastModeState.mode,
    effectiveFastModeSource: input.fastModeState.source,
    fastAutoOnSeconds: input.fastModeState.fastAutoOnSeconds,
    verboseLevel: entry?.verboseLevel,
    traceLevel: entry?.traceLevel,
    reasoningLevel: entry?.reasoningLevel,
    elevatedLevel: entry?.elevatedLevel,
    sendPolicy: entry?.sendPolicy,
    inputTokens: entry?.inputTokens,
    outputTokens: entry?.outputTokens,
    totalTokens: undefined,
    totalTokensFresh: undefined,
    goal: undefined,
    estimatedCostUsd: undefined,
    status: undefined,
    subagentRunState: undefined,
    hasActiveSubagentRun: undefined,
    startedAt: undefined,
    endedAt: undefined,
    runtimeMs: undefined,
    lastRunError: entry?.lastRunError,
    lastRunId: entry?.lastRunId,
    hasAutomation: input.hasAutomation,
    // Navigation lineage is persisted; runtime control is exposed separately above.
    parentSessionKey: entry?.parentSessionKey,
    parentSessionId: entry?.parentSessionId,
    childSessions: undefined,
    responseUsage: entry?.responseUsage,
    effectiveResponseUsage: resolveEffectiveResponseUsage(
      entry?.responseUsage,
      cfg.messages?.responseUsage,
      channel,
    ),
    queueMode: entry?.queueMode,
    effectiveQueueMode: resolveQueueSettingsCore({
      cfg,
      channel: INTERNAL_MESSAGE_CHANNEL,
      sessionEntry: entry,
    }).mode,
    modelProvider: input.rowModelIdentity.provider,
    model: input.rowModelIdentity.model,
    activeModelProvider: undefined,
    activeModel: undefined,
    modelOverrideSource:
      input.selectedModel.storedOverrideSource === "parent"
        ? "inherited"
        : resolveSessionModelOverrideSource(entry),
    modelSelectionLocked: entry?.modelSelectionLocked,
    runtimeSelectionLocked: input.thinkingProjection.runtimeSelectionLocked,
    agentRuntime: input.agentRuntime,
    contextTokens: input.contextTokens,
    contextBudgetStatus: resolveProjectedSessionContextBudgetStatus({
      entry,
      provider: input.selectedModel.provider,
      model: input.selectedModel.model,
      contextTokens: input.contextTokens,
    }),
    deliveryContext: deliveryFields.deliveryContext,
    lastChannel: deliveryFields.lastChannel,
    lastTo: deliveryFields.lastTo,
    lastAccountId: deliveryFields.lastAccountId,
    lastThreadId: deliveryFields.lastThreadId,
    compactionCheckpointCount: compactionSummary.compactionCheckpointCount,
    latestCompactionCheckpoint: compactionSummary.latestCompactionCheckpoint,
    pluginExtensions: input.pluginExtensions.length > 0 ? input.pluginExtensions : undefined,
  };
  return { row, source: input };
}

export function presentSessionRow(
  materialized: ReturnType<typeof materializeSessionRow>,
  options: Partial<ReturnType<typeof readSessionRowInputs>["presentation"]> & { now: number },
): GatewaySessionRow {
  const row = { ...materialized.row };
  const { source } = materialized;
  const { entry, freshSessionTotalTokens } = source;
  const { now } = options;
  // Stamp the temporal projection, not the reusable materialized inputs.
  // Completed list caches retain this sample when they replay the finished row.
  row.snapshotAt = now;
  const subagentRuns =
    options.subagentRuns ?? buildSubagentRunReadIndexFromRuns({ ...source.subagentRunInputs, now });
  const { subagentRun, subagentOwner, fields } = projectGatewaySessionRunState({
    key: row.key,
    entry,
    now,
    rowContext: { subagentRuns },
  });
  Object.assign(row, fields);
  const usage = source.usageByFallbackModel?.get(subagentRun?.model);
  row.totalTokens = freshSessionTotalTokens ?? asNonNegativeFiniteNumber(usage?.totalTokens);
  row.totalTokensFresh =
    freshSessionTotalTokens !== undefined ||
    (typeof row.totalTokens === "number" && row.totalTokens > 0) ||
    usage?.totalTokensFresh === true;
  row.agentStatus = resolveActiveSessionAgentStatus(entry?.agentStatus, now);
  row.spawnedBy = row.controlOwnerSessionKey = subagentOwner || entry?.spawnedBy;
  row.goal = resolveGatewaySessionGoal(entry, now, {
    totalTokens: row.totalTokens,
    totalTokensFresh: row.totalTokensFresh,
    totalTokensVersion: row.totalTokensFresh ? SESSION_TOTAL_TOKENS_VERSION : undefined,
  });
  row.estimatedCostUsd =
    source.estimatedCostUsd ??
    asNonNegativeFiniteNumber(source.lightweight ? undefined : usage?.estimatedCostUsd);
  const children = source.childLinks?.flatMap(({ key, entry: childEntry }) =>
    !options.excludedChildKeys?.has(key) &&
    resolveSessionChildOwners({ key, entry: childEntry, now, subagentRuns }).includes(row.key)
      ? [key]
      : [],
  );
  row.childSessions = children?.length ? children : undefined;
  row.activeModelProvider = options.activeModel?.provider;
  row.activeModel = options.activeModel?.model;
  return row;
}
