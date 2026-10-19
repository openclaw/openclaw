import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SubagentRequestSessionOrigin } from "../../agents/subagents/registry/subagent-exec-request-ownership.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { isCurrentSessionControllerTurnInput } from "../../sessions/session-controller.context.js";
import {
  getRpcSourceIdentity,
  listRpcSourceEntriesForSession,
  isRpcSourceQueued,
  type RpcSourceRef,
  type RpcSourceAdapter,
  type RpcSourceIdentity,
} from "../../sessions/session-controller.rpc-sources.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { chatRunBelongsToAgent, resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { createChatAbortMarker } from "../server-chat-state.js";
import { pendingChatSendDedupeKey, type DedupeEntry } from "../server-shared.js";
import type { ChatAbortSessionSnapshot } from "./chat-aborted-partial.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  SessionMutationAuthorization,
} from "./types.js";

export type ChatAbortRequester = {
  connId?: string;
  deviceId?: string;
  isAdmin: boolean;
  /** Host-only tool authority for the exact session admitted by the router. */
  sessionAuthority?: {
    target: NonNullable<SessionMutationAuthorization["admittedTarget"]>;
    assertCurrent: () => void;
  };
};

export function captureSessionAbortRequestOrigin(
  params: {
    session?: ChatAbortSessionSnapshot;
    requiredSessionId?: string;
    sessionId?: string;
  },
  acceptsRequest: SubagentRequestSessionOrigin["acceptsRequest"],
): SubagentRequestSessionOrigin | undefined {
  const session = params.session?.ok ? params.session.value : undefined;
  return session?.entry &&
    (params.requiredSessionId === undefined ||
      session.entry.sessionId === params.requiredSessionId) &&
    (params.sessionId === undefined || session.entry.sessionId === params.sessionId)
    ? {
        target: {
          agentId: session.agentId,
          storePath: session.storePath,
          sessionKey: session.canonicalKey,
          sessionId: session.entry.sessionId,
          lifecycleRevision: session.entry.lifecycleRevision ?? null,
        },
        acceptsRequest,
      }
    : undefined;
}

type PreRegisteredAgentDedupePayload = {
  goalFingerprint?: unknown;
  agentId?: unknown;
  attemptId?: unknown;
  controlUiVisible?: unknown;
  dedupeKeys?: unknown;
  expiresAtMs?: unknown;
  ownerConnId?: unknown;
  ownerDeviceId?: unknown;
  reservationId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
  sessionKeyAliases?: unknown;
  status?: unknown;
  turnKind?: unknown;
};

type PreRegisteredAgentRun = {
  runId: string;
  sessionKey: string;
  payload: PreRegisteredAgentDedupePayload;
};

export function buildAbortedChatSendPayload(params: {
  runId: string;
  endedAt: number;
  stopReason?: string;
}) {
  return {
    runId: params.runId,
    status: "timeout" as const,
    summary: "aborted",
    ...(params.stopReason ? { stopReason: params.stopReason } : {}),
    endedAt: params.endedAt,
  };
}

export function resolveChatAbortRequester(
  client: GatewayRequestHandlerOptions["client"],
  authorization?: SessionMutationAuthorization,
): ChatAbortRequester {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const caller = client?.internal?.syntheticClient ? client.internal.agentToolCaller : undefined;
  const assertCallerCurrent = caller?.assertCurrent;
  const sessionTarget = authorization?.admittedTarget;
  const assertCurrent =
    assertCallerCurrent && authorization && sessionTarget
      ? composeSessionSourceAssertion([assertCallerCurrent, authorization.assertCurrent])
      : undefined;
  assertCurrent?.();
  return {
    connId: normalizeOptionalString(client?.connId),
    deviceId: normalizeOptionalString(client?.connect?.device?.id),
    isAdmin: scopes.includes(ADMIN_SCOPE),
    ...(assertCurrent && sessionTarget
      ? { sessionAuthority: { target: sessionTarget, assertCurrent } }
      : {}),
  };
}

type ChatRunAbortAuthority = Partial<RpcSourceIdentity> & {
  requester?: RpcSourceAdapter["requester"];
};

export function canRequesterAbortChatRun(
  entry: ChatRunAbortAuthority,
  requester: ChatAbortRequester,
  options: { requireOwnerMatch?: boolean } = {},
): boolean {
  if (requester.sessionAuthority) {
    requester.sessionAuthority.assertCurrent();
    const { target } = requester.sessionAuthority;
    return (
      entry.sessionKey === target.sessionKey &&
      entry.sessionId === target.sessionId &&
      resolveChatRunOwnerAgentId(entry) === target.agentId
    );
  }
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalString(entry.requester?.deviceId);
  const ownerConnId = normalizeOptionalString(entry.requester?.connectionId);
  return Boolean(
    (!options.requireOwnerMatch && !ownerDeviceId && !ownerConnId) ||
    (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) ||
    (ownerConnId && requester.connId && ownerConnId === requester.connId),
  );
}

/** Returns the protocol-facing rejection for one exact run target, if any. */
export function resolveChatAbortTargetRejection(params: {
  target: ChatRunAbortAuthority;
  requester: ChatAbortRequester;
  requestedSessionKey: string;
  canonicalSessionKey: string;
  requestedAgentId: string;
  defaultAgentId?: string;
  requiredSessionId?: string;
  discardPendingInput?: boolean;
  narrow: boolean;
}): string | undefined {
  const { target } = params;
  const matchesSessionKey =
    target.sessionKey === params.requestedSessionKey ||
    target.sessionKey === params.canonicalSessionKey;
  if (params.discardPendingInput && !matchesSessionKey) {
    return "discarded input runId does not match sessionKey";
  }
  if (params.narrow && target.sessionId !== params.requiredSessionId) {
    return "runId does not match session incarnation";
  }
  if (
    !matchesSessionKey &&
    (params.narrow ||
      !canRequesterAbortChatRun(target, params.requester, { requireOwnerMatch: true }))
  ) {
    return "runId does not match sessionKey";
  }
  if (
    !chatRunBelongsToAgent(
      {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        defaultAgentId: params.defaultAgentId,
      },
      params.requestedAgentId,
    )
  ) {
    return "runId does not match agentId";
  }
  return canRequesterAbortChatRun(target, params.requester) ? undefined : "unauthorized";
}

export function readPreRegisteredRun(params: {
  key: string;
  entry: DedupeEntry | undefined;
  keyPrefix: string;
  includeHidden?: boolean;
}): PreRegisteredAgentRun | undefined {
  if (!params.key.startsWith(params.keyPrefix) || !params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (!params.includeHidden && payload.controlUiVisible === false) {
    return undefined;
  }
  const runId =
    (typeof payload.runId === "string" ? payload.runId : undefined) ??
    params.key.slice(params.keyPrefix.length);
  const sessionKey = normalizeOptionalString(payload.sessionKey);
  if (!runId || !sessionKey) {
    return undefined;
  }
  return { runId, sessionKey, payload };
}

export function writePreRegisteredChatAbort(params: {
  context: GatewayRequestContext;
  runId: string;
  stopReason: string;
  endedAt?: number;
  attemptId?: string;
  requestIdentity?: string;
  expectedPayload?: PreRegisteredAgentDedupePayload;
}) {
  if (
    params.expectedPayload &&
    params.context.dedupe.get(pendingChatSendDedupeKey(params.runId))?.payload !==
      params.expectedPayload
  ) {
    return false;
  }
  const endedAt = params.endedAt ?? Date.now();
  const payload = buildAbortedChatSendPayload({
    runId: params.runId,
    stopReason: params.stopReason,
    endedAt,
  });
  params.context.chatRunState.getOrCreate(params.runId).abortMarker =
    createChatAbortMarker(endedAt);
  const pendingKey = pendingChatSendDedupeKey(params.runId);
  const pendingEntry = params.context.dedupe.get(pendingKey);
  const pendingAttemptId = normalizeOptionalString(
    (pendingEntry?.payload as PreRegisteredAgentDedupePayload | undefined)?.attemptId,
  );
  const ownsPendingAttempt = !params.attemptId || pendingAttemptId === params.attemptId;
  // Eviction removes the reservation, not the admission's immutable input identity.
  const requestIdentity = pendingEntry
    ? ownsPendingAttempt
      ? pendingEntry.requestIdentity
      : undefined
    : params.requestIdentity;
  if (ownsPendingAttempt) {
    params.context.dedupe.delete(pendingKey);
  }
  setGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    key: `chat:${params.runId}`,
    entry: {
      ts: endedAt,
      ok: true,
      payload,
      ...(requestIdentity ? { requestIdentity } : {}),
    },
  });
  return true;
}

type AuthorizedRpcSourceRun = RpcSourceIdentity & { runId: string; entry: RpcSourceRef };

function selectAuthorizedRpcSourceRuns(
  entries: ReadonlyArray<{ runId: string; entry: RpcSourceRef }>,
  params: {
    requester: ChatAbortRequester;
    preserveSideRuns?: boolean;
    includeProtectedRuns?: boolean;
  },
) {
  const authorizedByRunId = new Map<string, AuthorizedRpcSourceRun>();
  const matchedRunIds = new Set<string>();
  const authorization = {
    hasUnauthorizedRuns: false,
    hasUnauthorizedProtectedRuns: false,
    hasProtectedRuns: false,
  };
  for (const { runId, entry } of entries) {
    const { adapter } = entry;
    const identity = getRpcSourceIdentity(entry);
    const requesterCanAbort = canRequesterAbortChatRun(
      { ...identity, requester: adapter.requester },
      params.requester,
    );
    matchedRunIds.add(runId);
    if (
      params.includeProtectedRuns !== true &&
      (adapter.controlUiVisible === false ||
        (params.preserveSideRuns && adapter.turnKind === "btw"))
    ) {
      // Lifecycle cleanup still checks ownership of hidden and preserved work.
      authorization.hasProtectedRuns = true;
      authorization.hasUnauthorizedProtectedRuns ||= !requesterCanAbort;
    } else if (requesterCanAbort) {
      authorizedByRunId.set(runId, { runId, ...identity, entry });
    } else {
      authorization.hasUnauthorizedRuns = true;
    }
  }
  return {
    authorizedRuns: [...authorizedByRunId.values()],
    matchedRunIds: [...matchedRunIds],
    ...authorization,
  };
}

export function resolveAuthorizedRunsForSessionKeys(params: {
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  requiredSessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  requester: ChatAbortRequester;
  preserveSideRuns?: boolean;
  includeProtectedRuns?: boolean;
  matchesScope: (entry: RpcSourceRef) => boolean;
}) {
  return selectAuthorizedRpcSourceRuns(
    listRpcSourceEntriesForSession(params).filter(
      ({ entry }) => params.matchesScope(entry) && !isRpcSourceQueued(entry),
    ),
    params,
  );
}

export function resolveAuthorizedQueuedTurnsForSession(params: {
  sessionKeys: string[];
  sessionId?: string;
  requiredSessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
  requester: ChatAbortRequester;
  preserveSideRuns?: boolean;
  includeProtectedRuns?: boolean;
  matchesScope: (entry: RpcSourceRef) => boolean;
}) {
  const matches = listRpcSourceEntriesForSession({
    queuedOnly: true,
    sessionKeys: params.sessionKeys,
    sessionIds: [params.sessionId],
    requiredSessionId: params.requiredSessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
  });
  const { authorizedRuns, ...result } = selectAuthorizedRpcSourceRuns(
    matches.filter(({ entry }) => params.matchesScope(entry)),
    params,
  );
  return { authorized: authorizedRuns, ...result };
}

/** Competing active, pending, or queued Gateway owner for an exact session. */
export function hasGatewaySessionAbortOwner(params: {
  context: GatewayRequestContext;
  storePath: string;
  sessionKeys: string[];
  sessionId?: string;
  agentId?: string;
  defaultAgentId?: string;
}): boolean {
  return listRpcSourceEntriesForSession({
    storeScope: params.storePath,
    resolveGatewayContext: params.context.resolveGatewayContext,
    sessionKeys: params.sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
  }).some(({ entry }) => !isCurrentSessionControllerTurnInput(entry.input));
}
