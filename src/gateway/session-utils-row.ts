import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readAgentConfigEntry } from "../agents/agent-scope-config.js";
import { countRunningBackgroundProcesses } from "../agents/bash-process-observation.js";
import { resolveModelContextTokenProjection } from "../agents/context.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import type { AgentHarnessSessionRuntimeOwnership } from "../agents/harness/types.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import {
  sessionWorktreeAvailability,
  type SessionWorktreeObservation,
} from "../agents/worktrees/session-lifecycle.js";
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
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import { projectPluginSessionExtensionsSync } from "../plugins/host-hook-state.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionCommunicationPolicy } from "../sessions/communication-policy.js";
import { resolveActiveSessionAgentStatus } from "../sessions/session-agent-status.js";
import { freezeTrustedJsonSnapshot } from "../shared/immutable-data.js";
import { deriveSessionUnread } from "../shared/session-unread.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import { projectSessionDeliveryFields } from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { channelAvatarRevision } from "./channel-avatar-reference.js";
import { buildControlUiChannelAvatarUrl } from "./control-ui-contract.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { sessionHasAutomation } from "./session-automation-index.js";
import { sessionClassificationForRow } from "./session-classification.js";
import { projectSessionRowProfiles } from "./session-identity-projection.js";
import { sessionModelRevision } from "./session-model-revision.js";
import { isSessionPermissionChangePending } from "./session-permission-change.js";
import {
  definedSessionRowField,
  definedSessionRowFields,
  freezeSessionRow,
  freezeSessionRowPatch,
} from "./session-row-identity.js";
import {
  readSessionRowModelFacts,
  resolveGatewaySessionActiveModel,
} from "./session-row-model-facts.js";
import { projectSessionRowProviderReview } from "./session-row-provider-review.js";
import type { SessionRuntimeResolution } from "./session-runtime-resolution.js";
import { buildSessionSwarmSummary } from "./session-swarm-summary.js";
import type { SessionTranscriptUsageSnapshot } from "./session-transcript-derived-readers.js";
import type {
  GatewaySessionModelSource,
  SessionChildActivity,
  SessionListRowContext,
} from "./session-utils-contracts.js";
import {
  resolveEstimatedSessionCostUsd,
  prepareGatewaySessionBackgroundProcessScope,
  readStoreChildSessionLinks,
  type SessionChildLink,
  resolveSessionChildController,
} from "./session-utils-core.js";
import {
  resolveGatewaySessionDisplayName,
  projectGatewaySessionRunState,
  projectPreparedSessionChild,
  resolveGatewaySessionKind,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import {
  buildSessionListRowMetadataContext,
  projectSessionRowChildLinks,
  resolveTranscriptUsageFallbacks,
} from "./session-utils-projection.js";
import { parseGroupKey } from "./session-utils-store.js";
import type { GatewaySessionRow, SessionListModelCatalog } from "./session-utils.types.js";
import { isUnscopedSessionHostWorkspace } from "./session-workspace-roots.js";
import { projectWorkerPlacementAgentRuntime } from "./worker-environments/placement-session-runtime.js";

export function readSessionRowInputs(params: {
  cfg: OpenClawConfig;
  storePath: string;
  storeAgentId?: string;
  active?: boolean;
  /** A supplied resident model avoids transcript reads; null uses only stored model facts. */
  activeModel?: { provider: string; model: string } | null;
  terminalModel?: { modelProvider: string; model: string } | null;
  store: Record<string, SessionEntry>;
  modelSource?: GatewaySessionModelSource;
  key: string;
  entry?: InternalSessionEntry;
  preparedAcpMeta?: SessionEntry["acp"] | null;
  preparedRuntimeOwnership?: AgentHarnessSessionRuntimeOwnership | null;
  runtimeResolution?: SessionRuntimeResolution;
  preparedModelMetadata?: PluginMetadataSnapshot | null;
  preparedRepositoryWorkspace?: Readonly<SessionRepositoryWorkspaceRecord> | null;
  preparedWorktree?: SessionWorktreeObservation | null;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  now?: number;
  preparedTitle?: Pick<
    GatewaySessionRow,
    "derivedTitle" | "lastMessagePreview" | "lastAssistantMessage"
  >;
  childLinks?: readonly SessionChildLink[];
  excludedChildKeys?: ReadonlySet<string>;
  rowContext?: SessionListRowContext;
  configuredAgentIds?: ReadonlySet<string>;
  agentId: string;
  skipTranscriptUsageFallback?: boolean;
  transcriptUsage?: SessionTranscriptUsageSnapshot | null;
  lightweightListRow?: boolean;
  hasMessages?: boolean;
  includeSwarmChildren?: boolean;
}) {
  const { cfg, storePath, store, key, entry, agentId } = params;
  const lightweight = params.lightweightListRow === true;
  const now = params.now ?? Date.now();
  const rowContext =
    params.rowContext ??
    buildSessionListRowMetadataContext({ now, sessionKeys: [key, ...Object.keys(store)] });
  const displayName = resolveGatewaySessionDisplayName(key, entry);
  const { selectedModel, rowModelIdentity, thinkingProjection, catalogEntry } =
    readSessionRowModelFacts({
      cfg,
      key,
      entry,
      preparedAcpMeta: params.preparedAcpMeta,
      preparedRuntimeOwnership: params.preparedRuntimeOwnership,
      runtimeResolution: params.runtimeResolution,
      preparedModelMetadata: params.preparedModelMetadata,
      source: params.modelSource ?? { entry, readSourceEntry: (parentKey) => store[parentKey] },
      agentId,
      rowContext,
      modelCatalog: params.modelCatalog,
      lightweightListRow: lightweight,
    });
  const freshSessionTotalTokens = resolveFreshSessionTotalTokens(entry);
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
          rowContext,
          agentId,
          storeAgentId: params.storeAgentId,
          transcriptUsage: params.transcriptUsage,
        })
      : undefined;
  const { provider, model } = selectedModel ?? {};
  // Display aliases do not change the selected route's catalog or runtime policy.
  const activeModel = resolveGatewaySessionActiveModel({
    cfg,
    active: params.active,
    activeModel: params.activeModel,
    terminalModel: params.terminalModel,
    storeAgentId: params.storeAgentId,
    selectedModel,
    projectedAgentRuns: (rowContext.projectedAgentRuns ??= buildProjectedAgentRunIndex()),
    entry,
    agentId,
    sessionId: entry?.sessionId,
    sessionKey: key,
    storePath,
  });

  const contextWindowProfile = resolveModelContextWindowProfile({
    catalogEntry,
    selected: entry?.contextWindow,
  });
  const modelContext = (params.runtimeResolution?.context ?? resolveModelContextTokenProjection)({
    cfg,
    provider,
    model,
    modelContextTokens: catalogEntry?.contextTokens,
    modelContextWindow: contextWindowProfile.contextTokens,
    allowAsyncLoad: false,
    allowCacheLookup: false,
  });
  const resolvedModelContextTokens = asPositiveFiniteNumber(modelContext.contextTokens);

  const pluginExtensions =
    !lightweight && entry ? projectPluginSessionExtensionsSync({ sessionKey: key, entry }) : [];
  if (entry?.repositoryWorkspaceId && params.preparedRepositoryWorkspace === undefined) {
    throw new Error("Repository workspace facts must be prepared before presenting the session");
  }
  const repositoryWorkspace = params.preparedRepositoryWorkspace;

  return {
    inputs: {
      worktreeState:
        entry?.worktree && params.preparedWorktree !== undefined
          ? sessionWorktreeAvailability(params.preparedWorktree, key)
          : undefined,
      cfg,
      key,
      entry,
      lightweight,
      preparedRuntimeOwnership: params.preparedRuntimeOwnership,
      swarm: buildSessionSwarmSummary(
        params.rowContext?.subagentRuns.swarmRunsByRequesterSessionKey.get(key) ?? [],
        key,
        agentId,
        { includeChildren: params.includeSwarmChildren },
      ),
      permissionModePending: isSessionPermissionChangePending(entry?.sessionId),
      repository:
        repositoryWorkspace?.workspaceId === entry?.repositoryWorkspaceId &&
        repositoryWorkspace?.agentId === agentId &&
        repositoryWorkspace.sessionKey === key
          ? {
              url: repositoryWorkspace.url,
              ...(repositoryWorkspace.requestedRef
                ? { ref: repositoryWorkspace.requestedRef }
                : {}),
              branch: repositoryWorkspace.branch,
            }
          : undefined,
      userProfileIdentityById: rowContext.userProfileIdentityById,
      identityProjection: rowContext.identityProjection,
      configuredAgentIds: params.configuredAgentIds,
      agentId,
      displayName,
      derivedTitle: params.preparedTitle?.derivedTitle,
      lastMessagePreview: params.preparedTitle?.lastMessagePreview,
      hasMessages: params.hasMessages,
      lastAssistantMessage: params.preparedTitle?.lastAssistantMessage,
      thinkingProjection,
      agentRuntime: (params.runtimeResolution?.placement ?? projectWorkerPlacementAgentRuntime)(
        thinkingProjection.agentRuntime,
      ),
      contextWindowProfile,
      // Fast mode is a model property; a session without a model has none.
      fastModeState:
        provider && model
          ? resolveFastModeState({ cfg, provider, model, agentId, sessionEntry: entry })
          : undefined,
      hasAutomation: sessionHasAutomation(key, cfg, agentId) ? true : undefined,
      rowModelIdentity,
      selectedModel,
      contextTokens: resolveProjectedSessionContextTokens({
        entry,
        provider,
        model,
        agentHarnessId: thinkingProjection.capacityRuntime,
        resolvedContextTokens: contextWindowProfile.contextTokens
          ? Math.min(
              resolvedModelContextTokens ?? contextWindowProfile.contextTokens,
              contextWindowProfile.contextTokens,
            )
          : resolvedModelContextTokens,
        authoredContextTokens: asPositiveFiniteNumber(modelContext.authoredContextTokens),
      }),
      pluginExtensions,
      includeSwarmSummary: params.rowContext !== undefined,
      childLinks:
        params.childLinks ??
        readStoreChildSessionLinks({
          store,
          key,
          subagentRunsByChildSessionKey: rowContext.subagentRunsByChildSessionKey,
        }),
      usageByFallbackModel,
      freshSessionTotalTokens,
      estimatedCostUsd: lightweight
        ? asNonNegativeFiniteNumber(entry?.estimatedCostUsd)
        : resolveEstimatedSessionCostUsd({
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
      projectedAgentRuns: rowContext.projectedAgentRuns,
      projectedSubagentActivity: rowContext.projectedSubagentActivity,
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

export function refreshSessionRowProfiles(materialized: ReturnType<typeof materializeSessionRow>) {
  return replaceSessionRowFacts(materialized, projectSessionRowProfiles(materialized.source));
}

export function materializeSessionRow(
  input: ReturnType<typeof readSessionRowInputs>["inputs"],
  previous?: {
    publicationIdentity: object;
    row: Readonly<GatewaySessionRow>;
    source: { childLinks?: Readonly<ReturnType<typeof projectSessionRowChildLinks>> };
  },
) {
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
  // Snooze shares the pin root-session rule.
  const pinnable = isPinnableSessionEntry(key, entry);
  const pinnedAt = pinnable ? entry?.pinnedAt : undefined;
  const classification = sessionClassificationForRow(cfg, key, input.agentId, entry);
  // Custody identifiers stay in storage for recovery; clients receive their friendly display name.
  // Explicit human labels and ordinary conversations retain normal label precedence.
  const generatedPublicationLabel =
    classification.classification === "github-publication" &&
    /^github-publication-(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/iu.test(
      entry?.label ?? "",
    );

  const row: GatewaySessionRow = {
    key,
    sessionModelRevision: sessionModelRevision(entry, undefined, input.preparedRuntimeOwnership),
    // Only explicitly requested summaries may clear swarm state in event merges.
    ...definedSessionRowField("swarm", input.includeSwarmSummary ? input.swarm : undefined),
    ...definedSessionRowField("visibility", entry ? (entry.visibility ?? "shared") : undefined),
    ...definedSessionRowField("incognito", entry?.incognito),
    ...definedSessionRowField("swarmGroupId", entry?.swarmGroupId),
    ...definedSessionRowField("spawnedWorkspaceDir", entry?.spawnedWorkspaceDir),
    ...definedSessionRowField("spawnedCwd", entry?.spawnedCwd),
    ...definedSessionRowField("workspaceDir", entry?.spawnedCwd ?? entry?.spawnedWorkspaceDir),
    ...definedSessionRowField("projectId", entry?.projectId),
    ...definedSessionRowField("permissionMode", entry?.permissionMode),
    ...definedSessionRowField("communication", entry?.communication),
    effectiveCommunication: resolveSessionCommunicationPolicy({ config: input.cfg, entry }),
    ...definedSessionRowField("sandboxMode", entry?.sandboxMode),
    ...definedSessionRowField("nativeRuntimeConsent", entry?.nativeRuntimeConsent),
    permissionModePending: input.permissionModePending,
    ...(entry?.permissionMode !== undefined && entry.sessionRoot !== undefined
      ? { sessionRoot: entry.sessionRoot }
      : {}),
    ...definedSessionRowField("worktree", entry?.worktree),
    ...definedSessionRowField("worktreeState", input.worktreeState),
    ...definedSessionRowField("deviceFolder", entry?.deviceFolder),
    ...definedSessionRowField("repositoryWorkspaceId", entry?.repositoryWorkspaceId),
    ...(input.repository ? { repository: input.repository } : {}),
    ...definedSessionRowField("execNode", entry?.execNode),
    ...definedSessionRowField("execCwd", entry?.execCwd),
    ...definedSessionRowField(
      "forkedFromParent",
      sessionEntryForkedFromParent(entry) ? true : undefined,
    ),
    ...definedSessionRowField("spawnDepth", entry?.spawnDepth),
    ...definedSessionRowField("subagentRole", entry?.subagentRole),
    ...definedSessionRowField("subagentControlScope", entry?.subagentControlScope),
    ...definedSessionRowField("createdVia", entry?.createdVia),
    ...definedSessionRowField("createdSurface", entry?.createdSurface),
    ...definedSessionRowFields(projectSessionRowProfiles(input)),
    ...definedSessionRowField("createdAt", entry?.createdAt),
    ...definedSessionRowField("forkSource", entry?.forkSource),
    ...definedSessionRowField("previousSessionId", entry?.previousSessionId),
    kind: resolveGatewaySessionKind(key, entry),
    ...definedSessionRowField("label", generatedPublicationLabel ? undefined : entry?.label),
    ...definedSessionRowField("autoLabel", entry?.autoLabel),
    ...definedSessionRowField("icon", entry?.icon),
    ...definedSessionRowField("color", entry?.color),
    ...definedSessionRowField(
      "channelAvatarUrl",
      avatar
        ? buildControlUiChannelAvatarUrl(controlUiBasePath, key, channelAvatarRevision(avatar))
        : undefined,
    ),
    ...definedSessionRowField("category", entry?.category),
    ...definedSessionRowField("boardFace", entry?.boardFace),
    ...definedSessionRowField("boardPresentation", entry?.boardPresentation),
    ...classification,
    ...definedSessionRowField(
      "displayName",
      generatedPublicationLabel
        ? (normalizeOptionalString(entry?.displayName) ?? "GitHub publication")
        : input.displayName,
    ),
    ...definedSessionRowField("derivedTitle", input.derivedTitle),
    ...definedSessionRowField("lastMessagePreview", input.lastMessagePreview),
    ...definedSessionRowField("hasMessages", input.hasMessages),
    ...definedSessionRowField("lastAssistantMessage", input.lastAssistantMessage),
    ...definedSessionRowField("channel", channel),
    ...definedSessionRowField("subject", entry?.subject),
    ...definedSessionRowField("groupChannel", entry?.groupChannel),
    ...definedSessionRowField("space", entry?.space),
    ...definedSessionRowField("chatType", entry?.chatType),
    ...definedSessionRowField(
      "origin",
      storedOrigin ? (({ avatar: _avatar, ...safeOrigin }) => safeOrigin)(storedOrigin) : undefined,
    ),
    updatedAt: entry?.updatedAt ?? null,
    archived: entry?.archivedAt !== undefined,
    ...definedSessionRowField("archivedAt", entry?.archivedAt),
    ...definedSessionRowField("archiveReason", entry?.archiveReason),
    pinned: pinnedAt !== undefined,
    sidebarRoot: entry?.sidebarRoot === true,
    ...definedSessionRowField("pinnedAt", pinnedAt),
    ...definedSessionRowField("snoozedUntil", pinnable ? entry?.snoozedUntil : undefined),
    ...definedSessionRowField("snoozedAt", pinnable ? entry?.snoozedAt : undefined),
    unread: deriveSessionUnread(entry),
    ...definedSessionRowField("lastReadAt", entry?.lastReadAt),
    ...definedSessionRowField("markedUnreadAt", entry?.markedUnreadAt),
    ...definedSessionRowField(
      "observerDigest",
      observerDigest
        ? {
            ...(observerDigest.agentId ? { agentId: observerDigest.agentId } : {}),
            runId: observerDigest.runId,
            headline: observerDigest.headline,
            health: observerDigest.health,
            updatedAt: observerDigest.updatedAt,
            revision: observerDigest.revision,
          }
        : undefined,
    ),
    ...definedSessionRowField("lastInteractionAt", entry?.lastInteractionAt),
    ...definedSessionRowField("lastActivityAt", entry?.lastActivityAt),
    ...definedSessionRowField("sessionId", entry?.sessionId),
    ...definedSessionRowField("lifecycleRevision", entry?.lifecycleRevision),
    ...definedSessionRowField("systemSent", entry?.systemSent),
    ...definedSessionRowField("abortedLastRun", entry?.abortedLastRun),
    ...definedSessionRowField("thinkingLevel", input.thinkingProjection.thinkingLevel),
    ...definedSessionRowField("contextWindow", input.contextWindowProfile.contextWindow),
    ...definedSessionRowField("contextWindows", input.contextWindowProfile.contextWindows),
    ...definedSessionRowField(
      "contextWindowDefault",
      input.contextWindowProfile.contextWindowDefault,
    ),
    ...definedSessionRowField("thinkingLevels", input.thinkingProjection.thinkingLevels),
    ...definedSessionRowField("thinkingOptions", input.thinkingProjection.thinkingOptions),
    ...definedSessionRowField("thinkingDefault", input.thinkingProjection.thinkingDefault),
    ...definedSessionRowField("cyberAccessProgram", entry?.cyberAccessProgram),
    ...definedSessionRowField("fastMode", entry?.fastMode),
    ...definedSessionRowField("toolOverrides", entry?.toolOverrides),
    ...definedSessionRowField("effectiveFastMode", input.fastModeState?.mode),
    ...definedSessionRowField("effectiveFastModeSource", input.fastModeState?.source),
    ...definedSessionRowField("fastAutoOnSeconds", input.fastModeState?.fastAutoOnSeconds),
    ...definedSessionRowField("verboseLevel", entry?.verboseLevel),
    ...definedSessionRowField("traceLevel", entry?.traceLevel),
    ...definedSessionRowField("reasoningLevel", entry?.reasoningLevel),
    ...definedSessionRowField(
      "reasoningDefault",
      readAgentConfigEntry(cfg, input.agentId)?.reasoningDefault ??
        cfg.agents?.defaults?.reasoningDefault,
    ),
    ...definedSessionRowField("elevatedLevel", entry?.elevatedLevel),
    ...definedSessionRowField("sendPolicy", entry?.sendPolicy),
    ...definedSessionRowField("inputTokens", entry?.inputTokens),
    ...definedSessionRowField("outputTokens", entry?.outputTokens),
    ...definedSessionRowField("usageReport", entry?.usageReport),
    ...definedSessionRowField("providerReview", projectSessionRowProviderReview(key, entry)),
    ...definedSessionRowField("lastRunId", entry?.lastRunId),
    ...definedSessionRowField("hasAutomation", input.hasAutomation),
    // Navigation lineage is persisted; runtime control is exposed separately above.
    ...definedSessionRowField("parentSessionKey", entry?.parentSessionKey),
    ...definedSessionRowField("parentSessionId", entry?.parentSessionId),
    ...definedSessionRowField("responseUsage", entry?.responseUsage),
    ...definedSessionRowField(
      "effectiveResponseUsage",
      resolveEffectiveResponseUsage(entry?.responseUsage, cfg.messages?.responseUsage, channel),
    ),
    ...definedSessionRowField("queueMode", entry?.queueMode),
    effectiveQueueMode: resolveQueueSettingsCore({
      cfg,
      channel: INTERNAL_MESSAGE_CHANNEL,
      sessionEntry: entry,
    }).mode,
    ...definedSessionRowField("modelProvider", input.rowModelIdentity.provider),
    ...definedSessionRowField("model", input.rowModelIdentity.model),
    ...definedSessionRowField("modelDisplayName", input.thinkingProjection.catalogEntry?.name),
    ...definedSessionRowField(
      "modelOverrideSource",
      input.selectedModel?.storedOverrideSource === "parent"
        ? "inherited"
        : resolveSessionModelOverrideSource(entry),
    ),
    ...definedSessionRowField("modelSelectionLocked", entry?.modelSelectionLocked),
    ...definedSessionRowField(
      "runtimeSelectionLocked",
      input.thinkingProjection.runtimeSelectionLocked,
    ),
    ...definedSessionRowField("agentRuntime", input.agentRuntime),
    ...definedSessionRowField("contextTokens", input.contextTokens),
    ...definedSessionRowField(
      "contextBudgetStatus",
      resolveProjectedSessionContextBudgetStatus({
        entry,
        provider: input.selectedModel?.provider,
        model: input.selectedModel?.model,
        contextTokens: input.contextTokens,
      }),
    ),
    ...definedSessionRowField("deliveryContext", deliveryFields.deliveryContext),
    ...definedSessionRowField("lastChannel", deliveryFields.lastChannel),
    ...definedSessionRowField("lastTo", deliveryFields.lastTo),
    ...definedSessionRowField("lastAccountId", deliveryFields.lastAccountId),
    ...definedSessionRowField("lastThreadId", deliveryFields.lastThreadId),
    ...definedSessionRowField(
      "pluginExtensions",
      input.pluginExtensions.length > 0 ? input.pluginExtensions : undefined,
    ),
  };
  return Object.freeze({
    publicationIdentity: previous?.publicationIdentity ?? {},
    row: freezeSessionRow(row, previous?.row),
    source: Object.freeze({
      parsedKey: parseAgentSessionKey(key),
      backgroundProcessScope: prepareGatewaySessionBackgroundProcessScope(input),
      // Materialization already owns config and workspace-entry invalidation.
      unscopedHostRoot: Boolean(
        entry &&
        isUnscopedSessionHostWorkspace({ cfg, agentId: input.agentId, sessionKey: key, entry }),
      ),
      agentId: input.agentId,
      cfg,
      entry,
      selectedModel: input.selectedModel,
      rowModelIdentity: input.rowModelIdentity,
      thinkingProjection: {
        acpMeta: input.thinkingProjection.acpMeta,
        agentRuntime: input.thinkingProjection.agentRuntime,
      },
      userProfileIdentityById: input.userProfileIdentityById,
      identityProjection: input.identityProjection,
      configuredAgentIds: input.configuredAgentIds,
      lightweight: input.lightweight,
      usageByFallbackModel: input.usageByFallbackModel,
      freshSessionTotalTokens: input.freshSessionTotalTokens,
      estimatedCostUsd: input.estimatedCostUsd,
      subagentRunInputs: input.subagentRunInputs,
      // The relation reader returns the previous frozen list when its child facts match.
      childLinks:
        input.childLinks === previous?.source.childLinks
          ? previous?.source.childLinks
          : freezeTrustedJsonSnapshot(projectSessionRowChildLinks(input.childLinks)),
    }),
  });
}

/** Writers replace published facts; config and live indexes keep their own owners. */
export function replaceSessionRowFacts(
  materialized: ReturnType<typeof materializeSessionRow>,
  row?: Partial<GatewaySessionRow>,
  source?: Partial<ReturnType<typeof materializeSessionRow>["source"]>,
): ReturnType<typeof materializeSessionRow> {
  const nextRow = row ? freezeSessionRowPatch(materialized.row, row) : materialized.row;
  if (!source && nextRow === materialized.row) {
    return materialized;
  }
  freezeTrustedJsonSnapshot(source?.childLinks);
  return Object.freeze({
    publicationIdentity: materialized.publicationIdentity,
    row: nextRow,
    source: source ? Object.freeze({ ...materialized.source, ...source }) : materialized.source,
  });
}

export function presentSessionRow(
  materialized: ReturnType<typeof materializeSessionRow>,
  options: Partial<ReturnType<typeof readSessionRowInputs>["presentation"]> & {
    now: number;
    childActivity?: SessionChildActivity;
    backgroundProcessCount?: number;
    preparedRunState?: ReturnType<typeof projectGatewaySessionRunState>;
  },
): GatewaySessionRow {
  const row = { ...materialized.row };
  const { source } = materialized;
  const { entry, freshSessionTotalTokens } = source;
  const { now } = options;
  // Stamp the temporal projection, not the reusable materialized inputs.
  // Completed list caches retain this sample when they replay the finished row.
  row.snapshotAt = now;
  const backgroundProcessCount =
    options.backgroundProcessCount ??
    countRunningBackgroundProcesses(source.backgroundProcessScope);
  if (backgroundProcessCount > 0) {
    row.backgroundProcessCount = backgroundProcessCount;
  }
  const subagentRuns =
    options.subagentRuns ?? buildSubagentRunReadIndexFromRuns({ ...source.subagentRunInputs, now });
  const { subagentRun, fields } =
    options.preparedRunState ??
    projectGatewaySessionRunState({
      key: row.key,
      parsedKey: source.parsedKey,
      entry,
      now,
      rowContext: {
        subagentRuns,
        projectedAgentRuns: options.projectedAgentRuns,
        projectedSubagentActivity: options.projectedSubagentActivity,
      },
    });
  Object.assign(row, fields);
  const usage = source.usageByFallbackModel?.get(subagentRun?.model);
  row.usageReport ??= usage?.usageReport;
  row.totalTokens = freshSessionTotalTokens ?? asNonNegativeFiniteNumber(usage?.totalTokens);
  row.totalTokensFresh =
    freshSessionTotalTokens !== undefined ||
    (typeof row.totalTokens === "number" && row.totalTokens > 0) ||
    usage?.totalTokensFresh === true;
  row.agentStatus = resolveActiveSessionAgentStatus(entry?.agentStatus, now);
  row.spawnedBy = entry?.spawnedBy;
  row.controlOwnerSessionKey = entry ? resolveSessionChildController(row.key, entry) : undefined;
  row.goal = resolveGatewaySessionGoal(entry, now, {
    totalTokens: row.totalTokens,
    totalTokensFresh: row.totalTokensFresh,
    totalTokensVersion: row.totalTokensFresh ? SESSION_TOTAL_TOKENS_VERSION : undefined,
  });
  row.estimatedCostUsd =
    source.estimatedCostUsd ??
    asNonNegativeFiniteNumber(source.lightweight ? undefined : usage?.estimatedCostUsd);
  let children = options.childActivity;
  if (!children) {
    const keys: string[] = [];
    let active = false;
    for (const child of source.childLinks ?? []) {
      if (options.excludedChildKeys?.has(child.key)) {
        continue;
      }
      const contribution = projectPreparedSessionChild(child, row.key, now, {
        subagentRuns,
        projectedAgentRuns: options.projectedAgentRuns,
        projectedSubagentActivity: options.projectedSubagentActivity,
      });
      if (contribution.included) {
        keys.push(child.key);
        active ||= contribution.active === true;
      }
    }
    children = { childSessions: keys.length ? keys : undefined, hasActiveSubagentRun: active };
  }
  row.childSessions = children.childSessions;
  if (children.hasActiveSubagentRun) {
    row.hasActiveSubagentRun = true;
  }
  row.activeModelProvider = options.activeModel?.provider;
  row.activeModel = options.activeModel?.model;
  return row;
}
