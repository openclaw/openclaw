import { randomUUID } from "node:crypto";
import { onTestFinished } from "vitest";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import {
  captureSessionTarget,
  type SessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  bindSessionControllerSource,
  retireSessionControllerInput,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  submitSessionControllerTask,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import {
  getRpcSourceIdentity,
  setRpcSourceProjectSessionActive,
  type RpcSourceAdapter,
  type RpcSourceIdentity,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";

/** Presentation fixtures retain real controller-owned inputs, never a second abort primitive. */
export function createRpcSourceForTest(
  metadata: Partial<RpcSourceAdapter> & { projectSessionActive?: boolean } = {},
  options: {
    runId?: string;
    storeScope?: string;
    phase?: "preparing" | "waiting" | "consumed";
    retirementRequested?: boolean;
    accepted?: boolean;
  } & Partial<RpcSourceIdentity> = {},
): RpcSourceRef {
  const { projectSessionActive, ...adapterMetadata } = metadata;
  const identity = {
    sessionKey: options.sessionKey ?? "agent:main:fixture",
    sessionId: options.sessionId ?? "fixture-session",
    agentId: options.agentId,
  };
  const adapter: RpcSourceAdapter = { ...adapterMetadata };
  const target = captureSessionTarget({
    storeScope: options.storeScope ?? `/synthetic/rpc-source-fixture/${randomUUID()}/sessions`,
    sessionKey: identity.sessionKey,
    agentId: identity.agentId,
    incarnation: identity.sessionId,
  });
  const input = reserveSessionControllerSource(target.sessionKey, {
    target,
    adapter,
    protocolRunId: options.runId,
    sourceSessionId: identity.sessionId,
    policy: { mode: "followup" },
  });
  input.custody.rpcAccepted = options.accepted === true ? true : undefined;
  input.retirementRequested = options.retirementRequested === true;
  if (options.phase === "waiting") {
    const run = createQueueTestRun({ prompt: "queued RPC fixture" });
    run.run = {
      ...run.run,
      sessionKey: target.sessionKey,
      sessionId: identity.sessionId,
      agentId: target.agentId ?? run.run.agentId,
      config: { ...run.run.config, session: { store: target.storeScope } },
    };
    run.abortSignal = input.abortSignal;
    bindSessionControllerSource(input, run);
    enqueueFollowupRun(target.sessionKey, run, { mode: "followup" }, "none");
  } else if (options.phase === "consumed") {
    retireSessionControllerInput(input);
  }
  onTestFinished(async () => {
    const claim = input.claim;
    claim?.operation?.complete();
    if (claim) {
      releaseSessionControllerClaim(claim);
      await Promise.allSettled([claim.settlement.promise]);
    }
    retireSessionControllerInput(input);
    await Promise.allSettled([input.settlement.promise]);
  });
  return { input, adapter, projectSessionActive } as RpcSourceRef;
}

/** Claim through the controller selector before exercising an active projection. */
export async function claimRpcSourceForTest(
  ref: RpcSourceRef,
  options: { executionStarted?: boolean } = {},
): Promise<() => void> {
  const claim = await claimSessionControllerTask(ref.input, (selectedClaim) => {
    const identity = getRpcSourceIdentity(ref);
    const operation = createReplyOperation({
      sessionKey: identity.sessionKey,
      sessionId: identity.sessionId,
      agentId: identity.agentId,
      resetTriggered: false,
      upstreamAbortSignal: ref.input.abortSignal,
      mailboxClaim: selectedClaim,
      target: ref.input.mailbox.owner.target,
    });
    if (options.executionStarted !== false) {
      markReplyOperationExecutionStarted(operation);
    }
    const projectSessionActive = (ref as RpcSourceRef & { projectSessionActive?: boolean })
      .projectSessionActive;
    if (projectSessionActive !== undefined) {
      setRpcSourceProjectSessionActive(ref, projectSessionActive);
    }
  });
  const release = () => {
    try {
      claim.operation?.complete();
    } finally {
      releaseSessionControllerClaim(claim);
    }
  };
  onTestFinished(async () => {
    release();
    await Promise.allSettled([claim.settlement.promise]);
  });
  return release;
}

/** Admit a queued source at its destination before exercising exact-identity adoption. */
export async function adoptRpcSourceSessionKeyForTest(ref: RpcSourceRef, target: SessionTarget) {
  const destination = await submitSessionControllerTask(target.sessionKey, {
    target,
    start: (claim) =>
      ref.input.claim!.operation!.updateSessionKey(target.sessionKey, target.agentId, claim),
  });
  onTestFinished(() => releaseSessionControllerClaim(destination));
}
