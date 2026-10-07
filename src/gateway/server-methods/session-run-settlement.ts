import {
  hasCommittedReplyOperationOutcome,
  replyRunRegistry,
  resolveReplyOperationsForSession,
  waitForReplyOperationOwnerSettlement,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getAttachedBackend } from "../../auto-reply/reply/reply-run-registry.state.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  isCompetingSessionWorkAdmissionActive,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import {
  isCurrentChatAbortExecution,
  waitForChatAbortControllerRemoval,
} from "../chat-abort-lifecycle-internal.js";
import { chatRunBelongsToAgent } from "../chat-run-owner.js";
import type { GatewayRequestContext } from "./types.js";

/** Join terminal writers before taking lifecycle locks; live turns retain the caller's idle gate. */
export async function waitForTerminalSessionRunSettlement(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  storePath: string;
  requestedKey: string;
  canonicalKey: string;
  sessionId: string;
  agentId: string;
  defaultAgentId?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  const sessionKeys = [params.requestedKey, params.canonicalKey];
  // Admissions have no run identity; never wait on a possibly live competing turn.
  if (isCompetingSessionWorkAdmissionActive(params.storePath, [...sessionKeys, params.sessionId])) {
    return false;
  }
  const matchingRuns = [...params.context.chatAbortControllers].filter(
    ([, entry]) =>
      (sessionKeys.includes(entry.sessionKey.trim()) || entry.sessionId === params.sessionId) &&
      chatRunBelongsToAgent({ ...entry, defaultAgentId: params.defaultAgentId }, params.agentId),
  );
  const currentRunId = matchingRuns.find(([, entry]) => isCurrentChatAbortExecution(entry))?.[0];
  const terminalRuns = matchingRuns
    .filter(([, entry]) => entry.projectSessionTerminalObservedAt !== undefined)
    .map(([runId, entry]) => ({ runId, entry }));
  const replies = resolveReplyOperationsForSession({ ...params, sessionKeys }).filter(
    (operation) =>
      currentRunId === undefined ||
      (replyRunRegistry.getSourceTurnId(operation.key) !== currentRunId &&
        getAttachedBackend(operation)?.runId !== currentRunId),
  );
  if (
    matchingRuns.some(
      ([runId, entry]) =>
        runId !== currentRunId && entry.projectSessionTerminalObservedAt === undefined,
    ) ||
    replies.some(
      (operation) => operation.result === null && !hasCommittedReplyOperationOutcome(operation),
    )
  ) {
    return false;
  }
  const timeoutMs = SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS;
  return await racePromiseWithAbortSignal(
    Promise.all([
      waitForChatAbortControllerRemoval({
        entries: params.context.chatAbortControllers,
        targets: terminalRuns,
        timeoutMs,
      }),
      ...replies.map((operation) => waitForReplyOperationOwnerSettlement(operation, timeoutMs)),
    ]).then((results) => results.every(Boolean)),
    params.signal,
  );
}
