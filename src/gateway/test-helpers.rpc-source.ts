import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import * as lifecycle from "../sessions/session-controller.lifecycle.js";
import * as mailbox from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import * as rpc from "../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";

/** Presentation fixtures retain real controller-owned inputs, never a second abort primitive. */
export function createRpcSourceForTest(
  metadata: Partial<rpc.RpcSourceAdapter> & { projectSessionActive?: boolean } = {},
  options: {
    runId?: string;
    storeScope?: string;
    phase?: "preparing" | "waiting" | "consumed";
    accepted?: boolean;
  } & Partial<rpc.RpcSourceIdentity> = {},
): rpc.RpcSourceRef {
  const { projectSessionActive, ...adapter } = metadata;
  const identity = {
    sessionKey: options.sessionKey ?? "agent:main:fixture",
    sessionId: options.sessionId ?? "fixture-session",
    agentId: options.agentId,
  };
  const target = lifecycle.captureSessionTarget({
    storeScope: options.storeScope ?? `/synthetic/rpc-source-fixture/${randomUUID()}/sessions`,
    sessionKey: identity.sessionKey,
    agentId: identity.agentId,
    incarnation: identity.sessionId,
  });
  const input = mailbox.reserveSessionControllerSource(target.sessionKey, {
    target,
    adapter,
    protocolRunId: options.runId,
    sourceSessionId: identity.sessionId,
    policy: { mode: "followup" },
  });
  input.custody.rpcAccepted = options.accepted === true ? true : undefined;
  input.retirementRequested = false;
  if (options.phase === "waiting") {
    const run = createQueueTestRun(
      { prompt: "queued RPC fixture", abortSignal: input.abortSignal },
      {
        sessionKey: target.sessionKey,
        sessionId: identity.sessionId,
        ...(target.agentId == null ? {} : { agentId: target.agentId }),
        config: { session: { store: target.storeScope } },
      },
    );
    mailbox.bindSessionControllerSource(input, run);
    enqueueFollowupRun(target.sessionKey, run, { mode: "followup" }, "none");
  } else if (options.phase === "consumed") {
    mailbox.retireSessionControllerInput(input);
  }
  onTestFinished(async () => {
    const claim = input.claim;
    claim?.operation?.complete();
    if (claim) {
      mailbox.releaseSessionControllerClaim(claim);
      await Promise.allSettled([claim.settlement.promise]);
    }
    mailbox.retireSessionControllerInput(input);
    await Promise.allSettled([input.settlement.promise]);
  });
  return { input, adapter, projectSessionActive } as rpc.RpcSourceRef;
}

/** Claim through the controller selector before exercising an active projection. */
export async function claimRpcSourceForTest(
  ref: rpc.RpcSourceRef,
  options: { executionStarted?: boolean } = {},
): Promise<() => void> {
  const claim = await mailbox.claimSessionControllerTask(ref.input, (selectedClaim) => {
    const operation = createReplyOperation({
      ...rpc.getRpcSourceIdentity(ref),
      resetTriggered: false,
      upstreamAbortSignal: ref.input.abortSignal,
      mailboxClaim: selectedClaim,
      target: ref.input.mailbox.owner.target,
    });
    if (options.executionStarted !== false) {
      markReplyOperationExecutionStarted(operation);
    }
    const projectSessionActive = (ref as rpc.RpcSourceRef & { projectSessionActive?: boolean })
      .projectSessionActive;
    if (projectSessionActive !== undefined) {
      rpc.setRpcSourceProjectSessionActive(ref, projectSessionActive);
    }
  });
  const release = () => {
    try {
      claim.operation?.complete();
    } finally {
      mailbox.releaseSessionControllerClaim(claim);
    }
  };
  onTestFinished(async () => {
    release();
    await Promise.allSettled([claim.settlement.promise]);
  });
  return release;
}

/** Admit a queued source at its destination before exercising exact-identity adoption. */
export async function adoptRpcSourceSessionKeyForTest(
  ref: rpc.RpcSourceRef,
  target: lifecycle.SessionTarget,
) {
  const destination = await mailbox.submitSessionControllerTask(target.sessionKey, {
    target,
    start: (claim) =>
      ref.input.claim!.operation!.updateSessionKey(target.sessionKey, target.agentId, claim),
  });
  onTestFinished(() => mailbox.releaseSessionControllerClaim(destination));
}
