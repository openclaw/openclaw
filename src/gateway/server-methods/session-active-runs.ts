import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunLive,
  isSubagentRunQueued,
  listActiveSubagentSessionKeys,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import { getSubagentRunRuntimeKey } from "../../agents/subagents/registry/subagent-run-generation.js";
import { isSwarmRunWaitingForCapacity } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { isAgentRunWaitingForCapacity } from "../../infra/agent-run-capacity-wait.js";
import {
  resolveProjectedAgentRunProgressState,
  buildProjectedAgentRunIndex,
  type ProjectedAgentRunIndex,
} from "../../infra/agent-run-registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  listActiveSessionRunIds,
  listActiveSessionRunKeys,
} from "../../sessions/session-controller.queries.js";
import {
  getRpcSourceIdentity,
  getRpcSourceProjectSessionActive,
  isRpcSourceParkedFollowup,
  isRpcSourceWaitingForTurn,
  listRpcSourceEntries,
  resolveRpcSourceSessionProgressState,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  getSessionControllerEntryForOperation,
  hasReplyOperationExecutionStarted,
  resolveReplyRunForCurrentSessionId,
} from "../../sessions/session-controller.state.js";
import { chatRunBelongsToAgent, resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import {
  captureGatewayScopeMatcher,
  captureRpcSourceScopeMatcher,
  type SessionRuntimeScope,
} from "../session-runtime-scope.js";
import type {
  VisibleActiveSessionRunProjector,
  VisibleActiveSessionRunSelection,
  VisibleActiveSessionRunState,
} from "./shared-types.js";

export type { VisibleActiveSessionRunProjector } from "./shared-types.js";

/** Active-run matcher including hidden remote lifecycle projections. */
type TrackedActiveSessionRun = {
  runId: string;
  storePaths: readonly string[];
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  terminalPersistence?: boolean;
  progress?: "queued" | "running";
  /** Accepted input parked in follow-up custody behind another owner. */
  parked?: true;
};

function collectTrackedActiveSessionRuns(
  includeTerminalPersistence = false,
  selection?: { requestedKey: string; canonicalKey: string; sessionId?: string },
  captured?: Iterable<readonly [string, RpcSourceRef]>,
  matchesGateway = captureGatewayScopeMatcher(
    getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
  ),
  physicalPaths?: (locator: string, agentId?: string) => readonly string[],
  trackedRpcSourceRefs?: RpcSourceRef[],
): TrackedActiveSessionRun[] {
  const runs: TrackedActiveSessionRun[] = [];
  for (const [runId, ref] of captured ?? listRpcSourceEntries()) {
    if (!matchesGateway(ref.input)) {
      continue;
    }
    // Hidden and queued sources still correlate native operations in this Gateway.
    trackedRpcSourceRefs?.push(ref);
    const active = ref.adapter;
    const identity = getRpcSourceIdentity(ref);
    const terminalPersistence =
      includeTerminalPersistence &&
      getRpcSourceProjectSessionActive(ref) === false &&
      active.projectSessionTerminalPending === true;
    const progress = resolveRpcSourceSessionProgressState(ref);
    if ((progress || terminalPersistence) && active.controlUiVisible !== false) {
      const sessionKey = identity.sessionKey.trim();
      const sessionId = identity.sessionId.trim();
      if (!sessionKey && !sessionId) {
        continue;
      }
      if (
        selection &&
        sessionKey !== selection.requestedKey &&
        sessionKey !== selection.canonicalKey &&
        (selection.sessionId === undefined || sessionId !== selection.sessionId)
      ) {
        continue;
      }
      runs.push({
        runId,
        storePaths: ref.input.target
          ? (physicalPaths?.(ref.input.target.storeScope, identity.agentId) ?? [
              ref.input.target.storeScope,
            ])
          : [],
        ...(sessionKey ? { sessionKey } : {}),
        ...(sessionId ? { sessionId } : {}),
        agentId: identity.agentId ? normalizeAgentId(identity.agentId) : undefined,
        ...(progress ? { progress } : {}),
        ...(isRpcSourceParkedFollowup(ref) ? { parked: true as const } : {}),
        ...(terminalPersistence ? { terminalPersistence: true } : {}),
      });
    }
  }
  return runs;
}

function isTrackedActiveSessionRunForKey(
  active: Pick<TrackedActiveSessionRun, "sessionKey" | "agentId">,
  key: string,
  agentId?: string,
  defaultAgentId?: string,
): boolean {
  if (!active.sessionKey || active.sessionKey !== key) {
    return false;
  }
  const requestedAgentId = resolveChatRunOwnerAgentId({
    agentId,
    sessionKey: key,
    defaultAgentId,
  });
  if (!requestedAgentId) {
    return false;
  }
  return chatRunBelongsToAgent(
    { agentId: active.agentId, sessionKey: active.sessionKey, defaultAgentId },
    requestedAgentId,
  );
}

function isTrackedActiveSessionRunForSessionId(
  active: TrackedActiveSessionRun,
  sessionId: string,
  agentId?: string,
  defaultAgentId?: string,
): boolean {
  if (active.sessionId !== sessionId) {
    return false;
  }
  const requestedAgentId = agentId ?? defaultAgentId;
  if (!requestedAgentId) {
    return false;
  }
  return chatRunBelongsToAgent(
    { agentId: active.agentId, sessionKey: active.sessionKey, defaultAgentId },
    requestedAgentId,
  );
}

export function hasRegisteredChatRunForSessionKey(
  params: SessionRuntimeScope & {
    sessionKey: string;
    agentId: string | undefined;
    defaultAgentId?: string;
  },
): boolean {
  const matchesScope = captureRpcSourceScopeMatcher(params);
  return listRpcSourceEntries().some(
    ([, active]) =>
      matchesScope(active) &&
      isTrackedActiveSessionRunForKey(
        getRpcSourceIdentity(active),
        params.sessionKey,
        params.agentId,
        params.defaultAgentId,
      ),
  );
}

export function resolveVisibleActiveSessionRunState(
  params: VisibleActiveSessionRunSelection & {
    trackedActiveRuns?: readonly TrackedActiveSessionRun[];
    trackedRpcSourceRefs?: readonly RpcSourceRef[];
    projectedAgentRunIndex?: ProjectedAgentRunIndex;
    includeTerminalPersistence?: boolean;
  },
  matchesGateway = captureGatewayScopeMatcher(params.resolveGatewayContext),
): VisibleActiveSessionRunState {
  const { canonicalKey, requestedKey, defaultAgentId } = params;
  const sessionId = params.sessionId?.trim();
  const resolvedAgentId =
    params.agentId ??
    parseAgentSessionKey(canonicalKey)?.agentId ??
    parseAgentSessionKey(requestedKey)?.agentId;
  // SDK publication callbacks may select by logical identity; core rows supply their exact store.
  const storePaths =
    params.storePath === undefined
      ? undefined
      : (params.physicalPaths?.(params.storePath, resolvedAgentId) ?? [params.storePath]);
  const matchesStore = (paths: readonly string[]) =>
    storePaths === undefined || paths.some((storePath) => storePaths.includes(storePath));
  const trackedRuns =
    params.trackedActiveRuns ??
    collectTrackedActiveSessionRuns(
      params.includeTerminalPersistence,
      { requestedKey, canonicalKey, sessionId },
      undefined,
      matchesGateway,
      params.physicalPaths,
    );
  const runIds: string[] = [];
  let hasTerminalPersistence = false;
  let trackedRunning = false;
  let trackedQueued = false;
  let trackedParked = false;
  for (const active of trackedRuns) {
    if (
      !matchesStore(active.storePaths) ||
      !(
        isTrackedActiveSessionRunForKey(active, canonicalKey, resolvedAgentId, defaultAgentId) ||
        isTrackedActiveSessionRunForKey(active, requestedKey, resolvedAgentId, defaultAgentId) ||
        (sessionId !== undefined &&
          isTrackedActiveSessionRunForSessionId(active, sessionId, resolvedAgentId, defaultAgentId))
      )
    ) {
      continue;
    }
    if (active.terminalPersistence) {
      hasTerminalPersistence = true;
    } else {
      runIds.push(active.runId);
    }
    trackedRunning ||= active.progress === "running" && !isAgentRunWaitingForCapacity(active.runId);
    trackedQueued ||= active.progress === "queued";
    trackedParked ||= active.parked === true;
  }
  const directSubagent = getLatestLiveSubagentRunByChildSessionKey(
    canonicalKey,
    undefined,
    resolvedAgentId,
  );
  const matchesDirectSubagentSession = Boolean(
    directSubagent &&
    isTrackedActiveSessionRunForKey(
      { sessionKey: directSubagent.childSessionKey },
      canonicalKey,
      resolvedAgentId,
      defaultAgentId,
    ),
  );
  const hasLiveSubagent = matchesDirectSubagentSession && isSubagentRunLive(directSubagent);
  const hasQueuedSubagent = matchesDirectSubagentSession && isSubagentRunQueued(directSubagent);
  if (
    (hasLiveSubagent || hasQueuedSubagent) &&
    directSubagent &&
    !runIds.includes(directSubagent.runId)
  ) {
    runIds.push(directSubagent.runId);
  }
  const subagentCapacityWait =
    (hasLiveSubagent || hasQueuedSubagent) &&
    directSubagent &&
    (isAgentRunWaitingForCapacity(directSubagent.runId) ||
      isSwarmRunWaitingForCapacity(
        directSubagent.schedulerSlotId ?? directSubagent.runId,
        getSubagentRunRuntimeKey(directSubagent),
      ));
  const projectedRunState = resolveProjectedAgentRunProgressState({
    sessionKeys: [requestedKey, canonicalKey],
    sessionId: sessionId || undefined,
    agentId: resolvedAgentId || undefined,
    defaultAgentId: defaultAgentId || undefined,
    index: params.projectedAgentRunIndex,
  });
  const localResolution = sessionId ? resolveReplyRunForCurrentSessionId(sessionId) : undefined;
  const ownedOperations = (
    localResolution?.kind === "one"
      ? [localResolution.operation]
      : localResolution?.kind === "ambiguous"
        ? localResolution.operations
        : []
  ).filter((operation) => {
    const entry = getSessionControllerEntryForOperation(operation);
    const operationStorePaths = entry.target
      ? (params.physicalPaths?.(entry.target.storeScope, operation.agentId) ?? [
          entry.target.storeScope,
        ])
      : [];
    return (
      matchesStore(operationStorePaths) &&
      matchesGateway(operation) &&
      chatRunBelongsToAgent(
        {
          agentId: operation.agentId,
          sessionKey: operation.key,
          defaultAgentId,
        },
        resolvedAgentId ?? defaultAgentId ?? "",
      ) &&
      !operation.result
    );
  });
  const localOperations = ownedOperations.filter(
    (operation) =>
      getSessionControllerEntryForOperation(operation).attachment?.projectSessionActive !== false,
  );
  // A quiet owner stays off the row until a human parks input behind it; then
  // the session is visibly working on their behalf, not merely queued.
  const quietOwnerRunning =
    trackedParked &&
    ownedOperations.some(
      (operation) =>
        !localOperations.includes(operation) && hasReplyOperationExecutionStarted(operation),
    );
  // RPC metadata is correlation for this very same logical owner, not another
  // liveness vote. Include hidden/queued refs in representation, not visibility.
  const representedLocally =
    localOperations.length > 0 &&
    (params.trackedRpcSourceRefs ?? listRpcSourceEntries().map(([, ref]) => ref)).some((ref) => {
      const operation = ref.input.claim?.operation;
      return operation !== undefined && localOperations.includes(operation);
    });
  // Native attempts without RPC metadata still belong to one captured physical owner.
  const embeddedRunState =
    localOperations.length === 0 || representedLocally
      ? undefined
      : localOperations.every(
            (operation) =>
              operation.phase === "waiting_for_global_lane" ||
              !hasReplyOperationExecutionStarted(operation),
          )
        ? "queued"
        : "running";
  // Remote lifecycle/subagent facts remain separately attributed projections.
  const running =
    ((hasLiveSubagent || hasQueuedSubagent) && !subagentCapacityWait) ||
    trackedRunning ||
    quietOwnerRunning ||
    projectedRunState === "running" ||
    embeddedRunState === "running";
  const active =
    running ||
    hasTerminalPersistence ||
    runIds.length > 0 ||
    embeddedRunState === "queued" ||
    projectedRunState === "queued";
  // Terminal persistence is history visibility, not operational run identity.
  // Omit the exact set until the persisted terminal projection releases it.
  const identitiesComplete =
    projectedRunState !== "running" &&
    projectedRunState !== "queued" &&
    embeddedRunState === undefined &&
    !hasTerminalPersistence;
  return {
    active,
    ...(identitiesComplete ? { runIds: runIds.toSorted() } : {}),
    ...(active &&
    !running &&
    (embeddedRunState === "queued" ||
      subagentCapacityWait ||
      trackedQueued ||
      projectedRunState === "queued" ||
      projectedRunState === "capacity-wait")
      ? { status: "queued" as const }
      : {}),
  };
}

/** History cuts may retire waiting input; admitted producers and terminal writers still block. */
export function createSessionMessageCutRunProjector(
  resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
) {
  return createVisibleActiveSessionRunProjector(
    undefined,
    listRpcSourceEntries().filter(([, source]) => !isRpcSourceWaitingForTurn(source)),
    resolveGatewayContext,
  );
}

/** Request-scoped index; candidate selection must not rescan all controllers per row. */
export function createVisibleActiveSessionRunProjector(
  projectedAgentRunIndex = buildProjectedAgentRunIndex(),
  captured?: Iterable<readonly [string, RpcSourceRef]>,
  resolveGatewayContext = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
  physicalPaths?: (locator: string, agentId?: string) => readonly string[],
) {
  const matchesGateway = captureGatewayScopeMatcher(resolveGatewayContext);
  const trackedRpcSourceRefs: RpcSourceRef[] = [];
  const byKey = new Map<string, TrackedActiveSessionRun[]>();
  const byId = new Map<string, TrackedActiveSessionRun[]>();
  const candidateKeys = new Set([
    ...projectedAgentRunIndex.ownerlessSessionKeys.keys(),
    ...listActiveSessionRunKeys(),
  ]);
  const candidateIds = new Set([
    ...projectedAgentRunIndex.ownerlessSessionIds.keys(),
    ...listActiveSessionRunIds(),
  ]);
  for (const [source, candidates] of [
    [projectedAgentRunIndex.sessionKeys, candidateKeys],
    [projectedAgentRunIndex.sessionIds, candidateIds],
  ] as const) {
    for (const identity of source.keys()) {
      candidates.add(identity.slice(identity.indexOf("\0") + 1));
    }
  }
  for (const run of collectTrackedActiveSessionRuns(
    false,
    undefined,
    captured,
    matchesGateway,
    physicalPaths,
    trackedRpcSourceRefs,
  )) {
    for (const [index, key] of [
      [byKey, run.sessionKey],
      [byId, run.sessionId],
    ] as const) {
      if (key) {
        const entries = index.get(key) ?? [];
        entries.push(run);
        index.set(key, entries);
      }
    }
  }
  const project: VisibleActiveSessionRunProjector = (params) => {
    const sessionId = params.sessionId?.trim() ?? "";
    // Inventory excludes absent owners; positive matches retain canonical agent policy.
    if (
      !byKey.has(params.canonicalKey) &&
      !byKey.has(params.requestedKey) &&
      !byId.has(sessionId) &&
      !candidateKeys.has(params.canonicalKey) &&
      !candidateKeys.has(params.requestedKey) &&
      !candidateIds.has(sessionId) &&
      (!sessionId || resolveReplyRunForCurrentSessionId(sessionId).kind === "none") &&
      !getLatestLiveSubagentRunByChildSessionKey(
        params.canonicalKey,
        (run) => isSubagentRunLive(run) || isSubagentRunQueued(run),
      )
    ) {
      return { active: false, runIds: [] };
    }
    return resolveVisibleActiveSessionRunState(
      {
        ...params,
        resolveGatewayContext,
        physicalPaths,
        projectedAgentRunIndex,
        trackedRpcSourceRefs,
        trackedActiveRuns: [
          ...new Set([
            ...(byKey.get(params.canonicalKey) ?? []),
            ...(byKey.get(params.requestedKey) ?? []),
            ...(byId.get(sessionId) ?? []),
          ]),
        ],
      },
      matchesGateway,
    );
  };
  const candidateSessionIdsOrKeys = (): ReadonlySet<string> =>
    new Set(
      [
        ...candidateKeys,
        ...candidateIds,
        ...byKey.keys(),
        ...byId.keys(),
        ...listActiveSubagentSessionKeys(),
      ].filter((identity) => identity.length > 0),
    );
  return Object.assign(project, { candidateSessionIdsOrKeys });
}
