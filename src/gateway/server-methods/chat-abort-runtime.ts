import {
  abortChatRunById,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
} from "../chat-abort.js";
import {
  abortQueuedChatTurns,
  listQueuedChatTurnsForSession,
  type QueuedChatTurnMap,
} from "../chat-queued-turns.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
// Cancellation orchestration across active, queued, pending, and worker runs.
import { loadSessionEntry } from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import {
  canRequesterAbortQueuedChatTurn,
  resolveAuthorizedPreRegisteredRunsForSessionKeys,
  resolveAuthorizedRunsForSessionKeys,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
  type ChatAbortRequester,
} from "./chat-abort-authorization.js";
import {
  normalizeOptionalChatText as normalizeOptionalText,
  normalizeUnknownChatText as normalizeUnknownText,
} from "./chat-text-normalization.js";
import { appendAssistantTranscriptMessage } from "./chat-transcript-persistence.js";
import type { GatewayRequestContext } from "./types.js";

type AbortOrigin = "rpc" | "stop-command";

type AbortedPartialSnapshot = {
  runId: string;
  sessionId: string;
  agentId?: string;
  text: string;
  abortOrigin: AbortOrigin;
};

function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  runIds: ReadonlySet<string>;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (!params.runIds.has(runId)) {
      continue;
    }
    const text = params.chatRunBuffers.get(runId);
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      runId,
      sessionId: active.sessionId,
      agentId: active.agentId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

export async function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}): Promise<void> {
  if (params.snapshots.length === 0) {
    return;
  }
  for (const snapshot of params.snapshots) {
    const sessionLoadOptions =
      params.sessionKey === "global" && snapshot.agentId
        ? { agentId: snapshot.agentId }
        : undefined;
    const { cfg, storePath, entry } = loadSessionEntry(params.sessionKey, sessionLoadOptions);
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = await appendAssistantTranscriptMessage({
      sessionKey: params.sessionKey,
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      ...(snapshot.agentId ? { agentId: snapshot.agentId } : {}),
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      cfg,
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
    });
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

export function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    chatAbortedRuns: context.chatAbortedRuns,
    clearChatRunState: context.clearChatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    getRuntimeConfig: context.getRuntimeConfig,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
    onRunAborted: context.cancelRunBoundApprovals,
  };
}

export function ensureChatQueuedTurns(context: GatewayRequestContext): QueuedChatTurnMap {
  return context.chatQueuedTurns;
}

function resolveAuthorizedQueuedTurnsForSession(params: {
  context: GatewayRequestContext;
  sessionKeys: string[];
  sessionId?: string;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
}) {
  const chatQueuedTurns = ensureChatQueuedTurns(params.context);
  const matches = listQueuedChatTurnsForSession({
    chatQueuedTurns,
    sessionKeys: params.sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
  });
  if (matches.length === 0) {
    return { authorized: [], matched: 0, unauthorizedOnly: false };
  }
  const authorized = matches.filter((m) =>
    canRequesterAbortQueuedChatTurn(m.entry, params.requester),
  );
  if (authorized.length === 0) {
    return { authorized, matched: matches.length, unauthorizedOnly: true };
  }
  return { authorized, matched: matches.length, unauthorizedOnly: false };
}

export function cancelWorkerInferenceForSession(params: {
  context: GatewayRequestContext;
  sessionId?: string;
  runId?: string;
}): string[] {
  const sessionId = normalizeOptionalText(params.sessionId);
  if (!sessionId) {
    return [];
  }
  return (
    asWorkerInferenceControl(params.context.workerEnvironmentService)?.cancelInferenceForSession({
      sessionId,
      ...(params.runId ? { runId: params.runId } : {}),
    }) ?? []
  );
}

export async function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  sessionKeyAliases?: string[];
  agentId?: string;
  sessionId?: string;
  persistSessionKey?: string;
  defaultAgentId: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
  requester: ChatAbortRequester;
  preserveSideRuns?: boolean;
  /** Internal sessions.* cleanup after exact agent/session resolution under operator.write. */
  onAuthorizedBeforeAbort?: () => boolean;
}): Promise<{ aborted: boolean; runIds: string[]; unauthorized: boolean }> {
  const sessionKeys = [params.sessionKey, ...(params.sessionKeyAliases ?? [])];
  const queuedPlan = resolveAuthorizedQueuedTurnsForSession({
    context: params.context,
    sessionKeys,
    sessionId: params.sessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
  });
  const { matchedSessionRuns, authorizedRuns } = resolveAuthorizedRunsForSessionKeys({
    chatAbortControllers: params.context.chatAbortControllers,
    sessionKeys,
    sessionIds: [params.sessionId],
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    preserveSideRuns: params.preserveSideRuns,
  });
  const {
    matchedSessionRuns: matchedPendingAgentRuns,
    authorizedRuns: authorizedPendingAgentRuns,
  } = resolveAuthorizedPreRegisteredRunsForSessionKeys({
    context: params.context,
    sessionKeys,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    keyPrefix: "agent:",
    preserveSideRuns: params.preserveSideRuns,
  });
  const { matchedSessionRuns: matchedPendingChatRuns, authorizedRuns: authorizedPendingChatRuns } =
    resolveAuthorizedPreRegisteredRunsForSessionKeys({
      context: params.context,
      sessionKeys,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
      requester: params.requester,
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
      preserveSideRuns: params.preserveSideRuns,
    });
  const unauthorizedOnly =
    matchedSessionRuns > 0 ||
    matchedPendingAgentRuns > 0 ||
    matchedPendingChatRuns > 0 ||
    queuedPlan.unauthorizedOnly;
  if (
    authorizedRuns.length === 0 &&
    authorizedPendingAgentRuns.length === 0 &&
    authorizedPendingChatRuns.length === 0 &&
    queuedPlan.authorized.length === 0
  ) {
    const workerService = asWorkerInferenceControl(params.context.workerEnvironmentService);
    const hasWorkerRun = Boolean(
      params.sessionId && workerService?.hasInferenceForSession(params.sessionId),
    );
    // With no connection-owned run, the exact persisted session is the owner
    // boundary, matching sessions.steer's operator.write behavior. Foreign
    // tracked chat/worker runs stay untouched, but do not block that cleanup.
    const additionalAborted = params.onAuthorizedBeforeAbort?.() ?? false;
    const hasAuthorizedSessionCleanup = params.onAuthorizedBeforeAbort !== undefined;
    if (
      (unauthorizedOnly || (hasWorkerRun && !params.requester.isAdmin)) &&
      !hasAuthorizedSessionCleanup
    ) {
      return { aborted: false, runIds: [], unauthorized: true };
    }
    if (!hasWorkerRun || !params.sessionId || !params.requester.isAdmin) {
      return { aborted: additionalAborted, runIds: [], unauthorized: false };
    }
    const workerRunIds = cancelWorkerInferenceForSession({
      context: params.context,
      sessionId: params.sessionId,
    });
    return {
      aborted: additionalAborted || workerRunIds.length > 0,
      runIds: workerRunIds,
      unauthorized: false,
    };
  }
  // Authorization is now complete. Run injected session cleanup before any
  // abort signal can let a draining active run promote queued successor work.
  const additionalAborted = params.onAuthorizedBeforeAbort?.() ?? false;
  const authorizedRunIdSet = new Set(authorizedRuns.map((run) => run.runId));
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    runIds: authorizedRunIdSet,
    abortOrigin: params.abortOrigin,
  });
  // Queued cancellations stay first so they cannot promote between cleanup and
  // the active abort, and callers retain the established runIds ordering.
  const runIds: string[] = abortQueuedChatTurns(
    ensureChatQueuedTurns(params.context),
    queuedPlan.authorized,
    params.stopReason,
  );
  for (const { runId, sessionKey } of authorizedRuns) {
    const res = abortChatRunById(params.ops, {
      runId,
      sessionKey,
      stopReason: params.stopReason,
    });
    if (res.aborted) {
      runIds.push(runId);
    }
  }
  const endedAt = Date.now();
  const stopReason = params.stopReason ?? "rpc";
  for (const { runId, sessionKey, payload } of authorizedPendingAgentRuns) {
    writePreRegisteredAgentAbort({
      context: params.context,
      runId,
      sessionKey,
      payload,
      stopReason,
      endedAt,
    });
    runIds.push(runId);
  }
  for (const { runId, payload } of authorizedPendingChatRuns) {
    writePreRegisteredChatAbort({
      context: params.context,
      runId,
      stopReason,
      endedAt,
      attemptId: normalizeUnknownText(payload.attemptId),
    });
    runIds.push(runId);
  }
  if (params.requester.isAdmin) {
    for (const runId of cancelWorkerInferenceForSession({
      context: params.context,
      sessionId: params.sessionId,
    })) {
      if (!runIds.includes(runId)) {
        runIds.push(runId);
      }
    }
  }
  const res = { aborted: additionalAborted || runIds.length > 0, runIds, unauthorized: false };
  if (res.aborted && snapshots.length > 0) {
    const abortedRunIds = new Set(runIds);
    await persistAbortedPartials({
      context: params.context,
      sessionKey: params.persistSessionKey ?? params.sessionKey,
      snapshots: snapshots.filter((snapshot) => abortedRunIds.has(snapshot.runId)),
    });
  }
  return res;
}
