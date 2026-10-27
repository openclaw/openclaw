import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { isCurrentSessionControllerTurnInput } from "../../sessions/session-controller.context.js";
import { selectedOperations } from "../../sessions/session-controller.lifecycle-projections.js";
import {
  getCurrentSessionControllerOwner,
  getTerminalSessionWorkAdmissionRelease,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceIdentity,
  isRpcSourceWaitingForTurn,
  listRpcSourceEntriesForTarget,
} from "../../sessions/session-controller.rpc-sources.js";
import { waitForReplyOperationOwnerSettlement } from "../../sessions/session-controller.settlement.js";
import {
  hasCommittedReplyOperationOutcome,
  isReplyOperationAbortable,
} from "../../sessions/session-controller.state.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { settlesWithin } from "../../shared/settle-within.js";
import { waitForChatAbortControllerRemoval } from "../chat-abort-lifecycle-internal.js";
import { chatRunBelongsToAgent } from "../chat-run-owner.js";
import { captureGatewayScopeMatcher } from "../session-runtime-scope.js";
import type { GatewayRequestContext } from "./types.js";

/** Join terminal writers before taking lifecycle locks; live turns retain the caller's idle gate. */
export async function waitForTerminalSessionRunSettlement(params: {
  context: Pick<GatewayRequestContext, "resolveGatewayContext">;
  storePath: string;
  requestedKey: string;
  canonicalKey: string;
  sessionId: string;
  agentId: string;
  defaultAgentId?: string;
  signal?: AbortSignal;
  /** Compaction owns preemption; independent admissions still require an idle gate. */
  liveRuns?: "preempt";
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  const sessionKeys = [params.requestedKey, params.canonicalKey];
  const target = captureSessionTarget({
    storeScope: params.storePath,
    sessionKey: params.canonicalKey,
    aliases: sessionKeys,
    incarnation: params.sessionId,
    agentId: params.agentId,
  });
  const matchesGateway = captureGatewayScopeMatcher(params.context.resolveGatewayContext);
  const matchingRuns = listRpcSourceEntriesForTarget(target).filter(([, entry]) => {
    const identity = getRpcSourceIdentity(entry);
    return (
      matchesGateway(entry.input) &&
      !isRpcSourceWaitingForTurn(entry) &&
      !isCurrentSessionControllerTurnInput(entry.input) &&
      (sessionKeys.includes(identity.sessionKey.trim()) ||
        identity.sessionId === params.sessionId) &&
      chatRunBelongsToAgent({ ...identity, defaultAgentId: params.defaultAgentId }, params.agentId)
    );
  });
  const current = getCurrentSessionControllerOwner();
  const replies = [...selectedOperations([target])].filter(
    (operation) =>
      operation !== current &&
      matchesGateway(operation) &&
      operation.sessionId === params.sessionId &&
      chatRunBelongsToAgent(
        {
          agentId: operation.agentId,
          sessionKey: operation.key,
          defaultAgentId: params.defaultAgentId,
        },
        params.agentId,
      ),
  );
  const liveReplies = new Set(
    replies.filter(
      (operation) => operation.result === null && !hasCommittedReplyOperationOutcome(operation),
    ),
  );
  const preemptingOperations =
    params.liveRuns === "preempt"
      ? new Set([...liveReplies].filter(isReplyOperationAbortable))
      : undefined;
  const admissions = getTerminalSessionWorkAdmissionRelease({
    scope: params.storePath,
    identities: [...sessionKeys, params.sessionId],
    resolveGatewayContext: params.context.resolveGatewayContext,
    preemptingOperations,
  });
  const terminalRuns = matchingRuns.filter(
    ([, entry]) =>
      !entry.input.claim?.operation || !preemptingOperations?.has(entry.input.claim.operation),
  );
  if (
    admissions === false ||
    terminalRuns.some(
      ([, entry]) =>
        !entry.adapter.terminalOutcomeObserved &&
        entry.adapter.projectSessionTerminalObservedAt === undefined,
    ) ||
    [...liveReplies].some((operation) => !preemptingOperations?.has(operation))
  ) {
    return false;
  }
  const timeoutMs = SESSION_CONTROLLER_DRAIN_TIMEOUT_MS;
  return await racePromiseWithAbortSignal(
    Promise.all([
      settlesWithin(admissions, timeoutMs),
      waitForChatAbortControllerRemoval({
        targets: terminalRuns.map(([runId, entry]) => ({ runId, entry })),
        timeoutMs,
      }),
      ...replies
        .filter((operation) => !preemptingOperations?.has(operation))
        .map((operation) => waitForReplyOperationOwnerSettlement(operation, timeoutMs)),
    ]).then((results) => results.every(Boolean)),
    params.signal,
  );
}
