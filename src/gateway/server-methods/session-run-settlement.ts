import {
  hasCommittedReplyOperationOutcome,
  resolveReplyOperationsForSession,
  waitForReplyOperationOwnerSettlement,
} from "../../auto-reply/reply/reply-run-registry.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  getSessionWorkAdmissionRelease,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  waitForSessionWorkAdmissionRelease,
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
  const matchingRuns = [...params.context.chatAbortControllers].filter(
    ([, entry]) =>
      (sessionKeys.includes(entry.sessionKey.trim()) || entry.sessionId === params.sessionId) &&
      chatRunBelongsToAgent({ ...entry, defaultAgentId: params.defaultAgentId }, params.agentId),
  );
  // In-band commands cannot join their own execution or reply completion.
  if (matchingRuns.some(([, entry]) => isCurrentChatAbortExecution(entry))) {
    return true;
  }
  const terminalRuns = matchingRuns
    .filter(([, entry]) => entry.projectSessionTerminalObservedAt !== undefined)
    .map(([runId, entry]) => ({ runId, entry }));
  const terminalReplies = resolveReplyOperationsForSession({ ...params, sessionKeys }).filter(
    (operation) => operation.result !== null || hasCommittedReplyOperationOutcome(operation),
  );
  if (terminalRuns.length === 0 && terminalReplies.length === 0) {
    return true;
  }
  const timeoutMs = SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS;
  const admittedWork = getSessionWorkAdmissionRelease({
    scope: params.storePath,
    identities: [...sessionKeys, params.sessionId],
    excludeCurrent: true,
  });
  return await racePromiseWithAbortSignal(
    Promise.all([
      waitForChatAbortControllerRemoval({
        entries: params.context.chatAbortControllers,
        targets: terminalRuns,
        timeoutMs,
      }),
      ...(admittedWork ? [waitForSessionWorkAdmissionRelease(admittedWork, timeoutMs)] : []),
      ...terminalReplies.map((operation) =>
        waitForReplyOperationOwnerSettlement(operation, timeoutMs),
      ),
    ]).then((results) => results.every(Boolean)),
    params.signal,
  );
}
