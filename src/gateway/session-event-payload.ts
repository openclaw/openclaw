import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { deriveSessionUnread } from "../shared/session-unread.js";
import {
  deriveGatewaySessionLifecycleProjectionPatch,
  isStaleLifecycleEventForSession,
} from "./session-lifecycle-state.js";
import type { GatewaySessionRow } from "./session-utils.js";

export function buildGatewaySessionSnapshot(params: {
  sessionRow: GatewaySessionRow | null | undefined;
  agentId?: string;
  includeSession?: boolean;
  lifecycle?: boolean;
  event?: AgentEventRuntimePayload;
  lifecycleRunId?: string;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
  activeRunState?: { active: boolean; runIds?: string[]; status?: "queued" } | null;
  status?: GatewaySessionRow["status"];
}): Record<string, unknown> {
  const { event, sessionRow: storedRow } = params;
  if (!storedRow) {
    return {};
  }
  const lifecycleRow = event
    ? { ...storedRow, updatedAt: storedRow.updatedAt ?? undefined }
    : undefined;
  const patch =
    event &&
    !isStaleLifecycleEventForSession({
      owningSessionId: event.sessionId,
      currentSessionId: storedRow.sessionId,
      eventRunId: event.runId,
      currentRunId: params.lifecycleRunId,
      eventStartedAt: event.data?.startedAt,
      currentStartedAt: storedRow.startedAt,
    })
      ? deriveGatewaySessionLifecycleProjectionPatch({ entry: lifecycleRow, event })
      : {};
  const sessionRow = { ...storedRow, ...patch };
  if (Object.hasOwn(patch, "lastActivityAt")) {
    sessionRow.unread = deriveSessionUnread(sessionRow);
  }
  for (const key of ["thinkingLevels", "thinkingOptions", "thinkingDefault"] as const) {
    delete sessionRow[key];
  }
  if (params.lifecycle && sessionRow.totalTokensFresh !== true) {
    delete sessionRow.totalTokens;
    delete sessionRow.totalTokensFresh;
    delete sessionRow.contextTokens;
    delete sessionRow.estimatedCostUsd;
  }
  // Accepted terminal events outrank retained cleanup liveness; otherwise the
  // active owner, not a stale persisted row, supplies current run status.
  const activeStatus = params.activeRunState?.active
    ? (params.activeRunState.status ?? "running")
    : undefined;
  const status = params.status ?? patch.status ?? activeStatus;
  // Picker metadata belongs to catalog-backed list/patch responses; emitting a
  // reconstructed subset here would replace richer client state. Null tombstones
  // and false flags clear subscribed metadata during reconciliation.
  const omitUnscopedGlobalGoal = sessionRow.key === "global" && !params.agentId;
  const omitUnscopedSwarm =
    (sessionRow.key === "global" || sessionRow.key === "unknown") && !params.agentId;
  const eventFields: Record<string, unknown> = {
    updatedAt: sessionRow.updatedAt ?? undefined,
    sessionId: sessionRow.sessionId,
    createdActor: sessionRow.createdActor ?? null,
    owner: sessionRow.owner ?? null,
    participants: sessionRow.participants ?? [],
    participantCount: sessionRow.participantCount ?? 0,
    kind: sessionRow.kind,
    visibility: sessionRow.visibility,
    channel: sessionRow.channel,
    subject: sessionRow.subject,
    groupChannel: sessionRow.groupChannel,
    space: sessionRow.space,
    chatType: sessionRow.chatType,
    origin: sessionRow.origin,
    archived: sessionRow.archived ?? false,
    archivedAt: sessionRow.archivedAt ?? null,
    archivedBy: sessionRow.archivedBy ?? null,
    archiveReason: sessionRow.archiveReason ?? null,
    pinned: sessionRow.pinned ?? false,
    pinnedAt: sessionRow.pinnedAt ?? null,
    snoozedUntil: sessionRow.snoozedUntil ?? null,
    snoozedAt: sessionRow.snoozedAt ?? null,
    unread: sessionRow.unread ?? false,
    lastReadAt: sessionRow.lastReadAt,
    markedUnreadAt: sessionRow.markedUnreadAt ?? null,
    agentStatus: sessionRow.agentStatus ?? null,
    observerDigest: sessionRow.observerDigest ?? null,
    ...(sessionRow.activitySummary ? { activitySummary: sessionRow.activitySummary } : {}),
    lastActivityAt: sessionRow.lastActivityAt,
    spawnedBy: sessionRow.spawnedBy,
    controlOwnerSessionKey: sessionRow.controlOwnerSessionKey ?? null,
    swarmGroupId: sessionRow.swarmGroupId,
    ...(!Object.hasOwn(sessionRow, "swarm") || omitUnscopedSwarm
      ? {}
      : {
          swarm: sessionRow.swarm
            ? {
                ...sessionRow.swarm,
                groups: sessionRow.swarm.groups.map(({ children: _children, ...counts }) => counts),
              }
            : null,
        }),
    spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
    spawnedCwd: sessionRow.spawnedCwd,
    permissionMode: sessionRow.permissionMode ?? null,
    permissionModePending: sessionRow.permissionModePending ?? false,
    ...(sessionRow.permissionMode !== undefined && sessionRow.sessionRoot !== undefined
      ? { sessionRoot: sessionRow.sessionRoot }
      : {}),
    forkedFromParent: sessionEntryForkedFromParent(sessionRow) ? true : undefined,
    spawnDepth: sessionRow.spawnDepth,
    subagentRole: sessionRow.subagentRole,
    subagentControlScope: sessionRow.subagentControlScope,
    createdVia: sessionRow.createdVia,
    createdAt: sessionRow.createdAt,
    forkSource: sessionRow.forkSource,
    previousSessionId: sessionRow.previousSessionId,
    label: params.label ?? sessionRow.label ?? null,
    autoLabel: sessionRow.autoLabel ?? null,
    icon: sessionRow.icon ?? null,
    color: sessionRow.color ?? null,
    channelAvatarUrl: sessionRow.channelAvatarUrl ?? null,
    category: sessionRow.category ?? null,
    boardPresentation: sessionRow.boardPresentation ?? null,
    displayName: params.displayName ?? sessionRow.displayName ?? null,
    deliveryContext: sessionRow.deliveryContext,
    parentSessionKey: params.parentSessionKey ?? sessionRow.parentSessionKey,
    childSessions: sessionRow.childSessions,
    thinkingLevel: sessionRow.thinkingLevel ?? null,
    fastMode: sessionRow.fastMode,
    effectiveFastMode: sessionRow.effectiveFastMode,
    effectiveFastModeSource: sessionRow.effectiveFastModeSource,
    fastAutoOnSeconds: sessionRow.fastAutoOnSeconds,
    toolOverrides: sessionRow.toolOverrides ?? null,
    verboseLevel: sessionRow.verboseLevel,
    traceLevel: sessionRow.traceLevel,
    reasoningLevel: sessionRow.reasoningLevel,
    elevatedLevel: sessionRow.elevatedLevel,
    sendPolicy: sessionRow.sendPolicy,
    systemSent: sessionRow.systemSent,
    abortedLastRun: sessionRow.abortedLastRun,
    restartRecoveryStatus: sessionRow.restartRecoveryStatus ?? null,
    interruptedAction: sessionRow.interruptedAction ?? null,
    inputTokens: sessionRow.inputTokens,
    outputTokens: sessionRow.outputTokens,
    lastChannel: sessionRow.lastChannel,
    lastTo: sessionRow.lastTo,
    lastAccountId: sessionRow.lastAccountId,
    lastThreadId: sessionRow.lastThreadId,
    totalTokens: sessionRow.totalTokens,
    totalTokensFresh: sessionRow.totalTokensFresh,
    ...(omitUnscopedGlobalGoal ? {} : { goal: sessionRow.goal ?? null }),
    contextTokens: sessionRow.contextTokens,
    contextBudgetStatus: sessionRow.contextBudgetStatus ?? null,
    estimatedCostUsd: sessionRow.estimatedCostUsd,
    responseUsage: sessionRow.responseUsage,
    effectiveResponseUsage: sessionRow.effectiveResponseUsage,
    modelProvider: sessionRow.modelProvider,
    model: sessionRow.model,
    activeModelProvider: sessionRow.activeModelProvider ?? null,
    activeModel: sessionRow.activeModel ?? null,
    modelOverrideSource: sessionRow.modelOverrideSource,
    agentRuntime: sessionRow.agentRuntime,
    runtimeSelectionLocked: sessionRow.runtimeSelectionLocked,
    status: status ?? sessionRow.status,
    lastRunError: sessionRow.lastRunError ?? null,
    providerReview: sessionRow.providerReview ?? null,
    lastRunId: sessionRow.lastRunId ?? null,
    hasAutomation: sessionRow.hasAutomation ?? false,
    ...(params.activeRunState == null
      ? {}
      : {
          hasActiveRun: params.activeRunState.active,
          // Presence means an exact set; null clears IDs when only liveness is known.
          activeRunIds: params.activeRunState.runIds ?? null,
        }),
    startedAt: sessionRow.startedAt,
    endedAt: sessionRow.endedAt ?? null,
    runtimeMs: sessionRow.runtimeMs ?? null,
    pluginExtensions: sessionRow.pluginExtensions,
  };
  if (params.lifecycle) {
    // Lifecycle snapshots cannot replace selection metadata or clear an active fallback.
    for (const field of [
      "modelProvider",
      "model",
      "activeModelProvider",
      "activeModel",
      "modelOverrideSource",
      "agentRuntime",
      "runtimeSelectionLocked",
    ] as const) {
      delete sessionRow[field];
      delete eventFields[field];
    }
  }
  const session: Record<string, unknown> | undefined = params.includeSession
    ? Object.assign(
        sessionRow,
        Object.fromEntries(Object.entries(eventFields).filter(([, value]) => value !== undefined)),
      )
    : undefined;
  if (session && sessionRow.key === "global" && !params.agentId) {
    delete session.goal;
  }
  if (session && (sessionRow.key === "global" || sessionRow.key === "unknown") && !params.agentId) {
    delete session.swarm;
  }
  return {
    ...(session ? { session } : {}),
    ...eventFields,
    subagentRunState: sessionRow.subagentRunState,
    hasActiveSubagentRun: sessionRow.hasActiveSubagentRun,
  };
}
