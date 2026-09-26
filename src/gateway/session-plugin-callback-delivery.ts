import { getLatestLiveSubagentRunByChildSessionKey } from "../agents/subagents/registry/subagent-registry-read.js";
import {
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
} from "../infra/session-delivery-queue.records.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { TrustedSubagentResume } from "./in-process-subagent-resume.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { dispatchGatewayLifecycleMethod } from "./server-recovery-runtime-context.js";

// A child that never yields cannot hold a completed result or expiry indefinitely.
// The queue owner moves overdue entries to its visible failed/dead-letter store.
const CALLBACK_YIELD_GRACE_MS = 60 * 60_000;

/** The durable outbox, not the plugin, owns this exact native task continuation. */
export async function deliverNativeChildCallback(params: {
  entry: Extract<QueuedSessionDelivery, { kind: "nativeChildFollowup" }>;
  queueContext: OpenClawStateWorkerContext;
  resolveGatewayContext?: GatewayContextResolver;
}): Promise<void> {
  const { entry, queueContext } = params;
  const runId = `plugin-callback:${entry.id}`;
  queueContext.admission.assertCurrent();
  if (entry.callbackExpiryKey) {
    const { runPluginAsyncCallbackCommand } = await import("../agents/plugin-async-callback.js");
    const expired = await runPluginAsyncCallbackCommand(
      { type: "pluginCallback.expire", input: { key: entry.callbackExpiryKey } },
      () => queueContext.admission.assertCurrent(),
      queueContext,
    );
    if (!expired) {
      return;
    }
  }
  const current = getLatestLiveSubagentRunByChildSessionKey(entry.sessionKey);
  // Registry adoption is durable before execution. After a crash between
  // adoption and queue acknowledgement, the registry owns recovery, not us.
  if (current?.runId === runId) {
    return;
  }
  const assertCurrent = () => {
    queueContext.admission.assertCurrent();
    const child = getLatestLiveSubagentRunByChildSessionKey(entry.sessionKey);
    if (
      !child ||
      child.runId !== entry.pausedRunId ||
      child.generation !== entry.pausedGeneration ||
      child.createdAt !== entry.pausedCreatedAt ||
      child.collect ||
      child.killIntent ||
      child.killReconciliation ||
      child.terminalOwner ||
      child.endedReason ||
      child.suppressAnnounceReason ||
      child.cleanupCompletedAt !== undefined ||
      child.execution.suppressSessionEffects ||
      child.expectsCompletionMessage === false
    ) {
      throw new SessionDeliveryDeadLetteredError(
        "Callback child was cancelled, replaced, or settled",
      );
    }
    if (child.pauseReason !== "sessions_yield") {
      if (child.execution.status === "running" || child.execution.status === "queued") {
        const deadline = entry.yieldDeadline ?? entry.enqueuedAt + CALLBACK_YIELD_GRACE_MS;
        if (Date.now() >= deadline) {
          throw new SessionDeliveryDeadLetteredError(
            "Callback child did not yield before its delivery deadline",
          );
        }
        throw new SessionDeliveryDeferredError(
          "Callback is waiting for its originating child to yield",
        );
      }
      throw new SessionDeliveryDeadLetteredError("Callback child is not waiting for its result");
    }
    return child;
  };
  const child = assertCurrent();
  const resume: TrustedSubagentResume = Object.freeze({
    assertCallbackCurrent: assertCurrent,
    childSessionKey: entry.sessionKey,
    childSessionId: entry.expectedSessionId,
    previousRunId: child.runId,
    taskRunId: child.taskRunId ?? child.runId,
    generation: child.generation,
    createdAt: child.createdAt,
  });
  const accepted = await dispatchGatewayLifecycleMethod<{ status: string; taskRunId?: string }>(
    "agent",
    {
      sessionKey: entry.sessionKey,
      expectedExistingSessionId: entry.expectedSessionId,
      message: entry.message,
      idempotencyKey: runId,
      deliver: false,
      inputProvenance: { kind: "internal_system", sourceTool: "plugin-async-callback" },
    },
    {
      subagentResume: resume,
      resolveGatewayContext: params.resolveGatewayContext,
      timeoutMs: 10_000,
    },
  );
  if (accepted.status !== "accepted" || accepted.taskRunId !== resume.taskRunId) {
    throw new Error("Callback continuation was not confirmed by its native task owner");
  }
}
