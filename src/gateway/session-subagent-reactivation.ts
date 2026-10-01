// Subagent session reactivation helper.
// Continues yielded or completed subagent work when a user messages the child session.
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "../agents/subagents/registry/subagent-registry-persistence.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  getLatestSubagentRunByChildSessionKey,
} from "../agents/subagents/registry/subagent-registry-read.js";
import { restoreSubagentRunsFromDisk } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  isSameSubagentRun,
  isSameSubagentRunOwner,
} from "../agents/subagents/registry/subagent-run-generation.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

/**
 * Reactivates a yielded or completed subagent session under its next run id.
 *
 * `task` is the canonical user-supplied prompt text that just dispatched the
 * follow-up. When provided, it is persisted on the new run record so a later
 * orphan recovery / gateway restart rewraps the follow-up prompt rather than
 * the stale original task. Without this, sessions.send and agent.run callers
 * could reactivate a completed run with the new run id but lose the new
 * prompt text from restart redispatch.
 */
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
  if (
    !getLatestLiveSubagentRunByChildSessionKey(
      params.sessionKey,
      (entry) => entry.runId === existing.runId,
    )
  ) {
    await restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true,
      context: stateContext,
      assertCurrent: params.assertCurrent,
    });
  }
  const selected = getLatestLiveSubagentRunByChildSessionKey(
    params.sessionKey,
    (entry) => entry.runId === existing.runId,
  );
  if (!selected || !isSameSubagentRun(selected, existing)) {
    return false;
  }
  const latest = getLatestLiveSubagentRunByChildSessionKey(params.sessionKey);
  const source = selected;
  const assertOriginalOwnerCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getLatestLiveSubagentRunByChildSessionKey(
      params.sessionKey,
      (entry) => entry.runId === existing.runId,
    );
    const currentLatest = getLatestLiveSubagentRunByChildSessionKey(params.sessionKey);
    if (
      !isSameSubagentRunOwner(current, selected) ||
      (latest ? !isSameSubagentRunOwner(currentLatest, latest) : currentLatest !== undefined) ||
      (current && typeof current.execution.endedAt !== "number")
    ) {
      throw new Error("subagent follow-up source changed while its writes settled");
    }
    params.assertCurrent?.();
    if (params.gatewayContextResolver && !params.gatewayContextResolver()) {
      throw new Error("subagent follow-up Gateway owner retired");
    }
  };
  const runtime = await import("../agents/subagents/registry/subagent-registry-runtime.js");
  assertOriginalOwnerCurrent();
  const task = params.task;
  const hasTask = typeof task === "string" && task.trim().length > 0;
  // A yielded child still owes its parent completion; operator follow-ups must
  // preserve that wake rather than treating the task as already completed.
  const gatewayBinding = params.gatewayContextResolver
    ? { gatewayContextResolver: params.gatewayContextResolver }
    : {};
  const replaced =
    source.pauseReason === "sessions_yield"
      ? await runtime.adoptPausedSubagentRunForFollowUp({
          childSessionKey: params.sessionKey,
          runId,
          task: hasTask ? task : source.task,
          assertCurrent: assertOriginalOwnerCurrent,
          ...gatewayBinding,
        })
      : await runtime.replaceSubagentRunAfterSteer({
          previousRunId: source.runId,
          nextRunId: runId,
          runTimeoutSeconds: source.runTimeoutSeconds ?? 0,
          persistenceFailure: "throw",
          ...(hasTask ? { task } : {}),
          assertCurrent: assertOriginalOwnerCurrent,
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
