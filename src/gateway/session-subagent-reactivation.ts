import {
  assertSubagentRegistryWriteSourceCurrent,
  waitForPendingSubagentRegistryWrites,
} from "../agents/subagents/registry/subagent-registry-persistence.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  getLatestSubagentRunByChildSessionKey,
} from "../agents/subagents/registry/subagent-registry-read.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

/** Persist the dispatched follow-up prompt so restart recovery cannot reuse the original task. */
export async function reactivateCompletedSubagentSession(params: {
  sessionKey: string;
  runId?: string;
  task?: string;
  gatewayContextResolver?: GatewayContextResolver;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const paused = getLatestLiveSubagentRunByChildSessionKey(
    params.sessionKey,
    (entry) => entry.pauseReason === "sessions_yield",
  );
  const existing = paused ?? getLatestSubagentRunByChildSessionKey(params.sessionKey);
  if (!existing || typeof existing.execution.endedAt !== "number") {
    return false;
  }
  const stateContext = captureOpenClawStateWorkerContext();
  const selected = getLatestLiveSubagentRunByChildSessionKey(
    params.sessionKey,
    (entry) => entry.runId === existing.runId,
  );
  const selectedGeneration = selected?.generation;
  const latest = getLatestLiveSubagentRunByChildSessionKey(params.sessionKey);
  const latestGeneration = latest?.generation;
  const source = selected ?? existing;
  const isOriginalOwnerCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    if (
      getLatestLiveSubagentRunByChildSessionKey(
        params.sessionKey,
        (entry) => entry.runId === existing.runId,
      ) !== selected ||
      selected?.generation !== selectedGeneration ||
      (selected && selectedGeneration !== existing.generation) ||
      getLatestLiveSubagentRunByChildSessionKey(params.sessionKey) !== latest ||
      latest?.generation !== latestGeneration ||
      typeof source.execution.endedAt !== "number"
    ) {
      throw new Error("subagent follow-up source changed while its writes settled");
    }
    params.assertCurrent?.();
    return !params.gatewayContextResolver || Boolean(params.gatewayContextResolver());
  };
  const runtime = await import("../agents/subagents/registry/subagent-registry.js");
  for (;;) {
    if (!isOriginalOwnerCurrent()) {
      return false;
    }
    const pending = waitForPendingSubagentRegistryWrites([source.runId], stateContext.admission);
    if (!pending) {
      break;
    }
    // Completion cleanup can admit another write while the previous one settles.
    // Join its publication before comparing the replacement's exact durable source.
    await pending;
  }
  const task = params.task;
  const hasTask = typeof task === "string" && task.trim().length > 0;
  // A yielded child still owes its parent completion; operator follow-ups must
  // preserve that wake rather than treating the task as already completed.
  const gatewayBinding = params.gatewayContextResolver
    ? { gatewayContextResolver: params.gatewayContextResolver }
    : {};
  const replaced = paused
    ? runtime.adoptPausedSubagentRunForFollowUp({
        childSessionKey: params.sessionKey,
        runId,
        task: hasTask ? task : paused.task,
        ...gatewayBinding,
      })
    : runtime.replaceSubagentRunAfterSteerCore({
        previousRunId: source.runId,
        nextRunId: runId,
        fallback: source,
        runTimeoutSeconds: source.runTimeoutSeconds ?? 0,
        ...(hasTask ? { task } : {}),
        ...gatewayBinding,
      });
  if (replaced) {
    return true;
  }
  const currentOwner = getLatestLiveSubagentRunByChildSessionKey(params.sessionKey);
  if (currentOwner?.runId === runId) {
    return true;
  }
  throw new Error("subagent follow-up owner replacement was rejected");
}
