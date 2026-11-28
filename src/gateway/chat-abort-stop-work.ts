import { captureExecRequestCancellation } from "../agents/bash-process-control.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getRpcSourceIdentity,
  isRpcSourceQueued,
  listRpcSourceEntries,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { getResidentUserProfileDisplay } from "../state/user-profile-list.js";
import { waitForChatAbortTerminalPersistence } from "./chat-abort-lifecycle-internal.js";
import { createChatAbortOps } from "./chat-abort-ops.js";
import { accessLossStopText } from "./operator-refusal.js";
import { stopExactClientRun } from "./server-methods/chat-abort-exact-run.js";
import {
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  prepareChatAbortSessionSnapshot,
  type AbortedPartialSnapshot,
} from "./server-methods/chat-aborted-partial.js";
import { injectGatewayAssistantMessage } from "./server-methods/chat-inject.js";
import { persistAbortedPartials } from "./server-methods/chat-transcript-persistence.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { captureGatewayScopeMatcher } from "./session-runtime-scope.js";

/** Stop labels on the aborted run; its partial output shows as interrupted. */
type AccessLossStopReason = "access-removed" | "access-reduced";

/**
 * Stops the work one person started, because a permission writer removed or lowered that
 * person's access (AGENTS.md "Decide authority once"). Only permission writers call it, after
 * their write commits. It selects work by the requester that admission recorded when the work
 * started, and never reads roles, membership or admission, so it cannot become a re-check.
 *
 * Accepted edge: admission records the requester after awaited preparation. A run admitted with
 * the old access in the same instant as the write is not recorded yet, so it finishes.
 */
export async function stopWorkStartedBy(
  context: GatewayRequestContext,
  params: { profileId: string; sessionKey?: string; stopReason: AccessLossStopReason },
): Promise<void> {
  const { profileId, sessionKey } = params;
  const startedBy = (identity: { sessionKey?: string }, initiator?: { profileId?: string }) =>
    initiator?.profileId === profileId &&
    (sessionKey === undefined || identity.sessionKey === sessionKey);
  const matchesGateway = captureGatewayScopeMatcher(context.resolveGatewayContext);
  // Queued input is not started work; its own start is admitted again.
  const runs = listRpcSourceEntries().filter(
    ([, entry]) =>
      matchesGateway(entry.input) &&
      !isRpcSourceQueued(entry) &&
      startedBy(getRpcSourceIdentity(entry), entry.adapter.initiatingPersonalOperator),
  );
  const commands = captureExecRequestCancellation(sessionKey ? { sessionKey } : {}, (identity) =>
    startedBy(identity, identity.initiatingPersonalOperator),
  );
  commands.cancel();
  const stopped = await Promise.all(
    runs.map(([runId, active]) =>
      stopRun(context, runId, active, params.stopReason).catch((error: unknown) => {
        context.logGateway.warn(
          `Could not stop run ${runId} after access loss: ${formatErrorMessage(error)}`,
        );
        return undefined;
      }),
    ),
  );
  await commands.settle().catch((error: unknown) => {
    context.logGateway.warn(`Commands stopped after access loss: ${formatErrorMessage(error)}`);
  });
  const bySession = new Map<string, { agentId?: string; runs: number }>();
  for (const session of stopped) {
    if (session) {
      const current = bySession.get(session.sessionKey);
      bySession.set(session.sessionKey, {
        agentId: session.agentId,
        runs: (current?.runs ?? 0) + 1,
      });
    }
  }
  for (const [stoppedKey, { agentId, runs: count }] of bySession) {
    // A stopped run recorded this profile when it started, so its display entry exists.
    const name = getResidentUserProfileDisplay(profileId).displayName ?? "a former member";
    const notice = await injectGatewayAssistantMessage(context, {
      sessionKey: stoppedKey,
      agentId,
      message: accessLossStopText(count, name),
      literal: true,
    });
    if (!notice.ok) {
      context.logGateway.warn(
        `Could not record stopped runs in ${stoppedKey}: ${notice.error.message}`,
      );
    }
  }
}

/** The ordinary exact-run Stop: partial output, its children, then transcript settlement. */
async function stopRun(
  context: GatewayRequestContext,
  runId: string,
  active: RpcSourceRef,
  stopReason: AccessLossStopReason,
) {
  const { sessionKey, sessionId, agentId } = getRpcSourceIdentity(active);
  const cfg = context.getRuntimeConfig();
  const session = await prepareChatAbortSessionSnapshot({ cfg, key: sessionKey, agentId });
  let snapshot: AbortedPartialSnapshot | undefined;
  const { aborted, descendants, failure } = await stopExactClientRun({
    ops: createChatAbortOps(context),
    cfg,
    runId,
    active,
    stopReason,
    hookContext: {},
    stoppedSession: { agentId, sessionKey },
    onAbortPrepared: () => {
      const text = context.chatRunState.resolveBuffer(runId, { final: true }).text;
      if (active.adapter.controlUiVisible === false || !text?.trim()) {
        return undefined;
      }
      snapshot = captureAbortedPartial({
        runId,
        sessionKey,
        sessionId,
        agentId,
        text,
        abortOrigin: "rpc",
        resolveTerminalProducer: active.adapter.resolveTerminalProducer,
        session,
      });
      return deferAbortedPartialPersistence(snapshot, context);
    },
  });
  if (aborted) {
    await Promise.all([
      snapshot && persistAbortedPartials({ context, snapshots: [snapshot] }),
      waitForChatAbortTerminalPersistence(active),
    ]);
  }
  if (failure) {
    throw failure.error;
  }
  if (descendants?.status === "error") {
    throw new Error(descendants.error);
  }
  return aborted ? { sessionKey, agentId } : undefined;
}
