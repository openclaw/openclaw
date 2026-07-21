// Bridges durable review tasks to the production subagent launcher and completion registry.
import { getSubagentRunByRunId } from "../agents/subagent-registry.js";
import { spawnSubagentDirect } from "../agents/subagent-spawn.js";
import type { TaskReviewerRuntime } from "./task-review-lifecycle.js";

export const taskReviewerRuntime: TaskReviewerRuntime = {
  async launch({ task, detail, recoveryAttempt }) {
    if (!task.runId) {
      return { ok: false, reason: "Review task has no stable run id." };
    }
    const result = await spawnSubagentDirect(
      {
        task: task.task,
        taskName: `review-${detail.dispatchKey.slice(0, 12)}`,
        label: task.label,
        agentId: detail.reviewerAgentId,
        mode: "run",
        cleanup: "keep",
        expectsCompletionMessage: false,
        taskRunId: task.runId,
        externalTaskLifecycle: true,
        externalLaunchReplayKey: `${detail.dispatchKey}:${recoveryAttempt}`,
      },
      {
        agentSessionKey: detail.continuity.sessionKey,
        completionOwnerKey: detail.continuity.ownerKey,
        requesterRunId: `${detail.dispatchKey}:${recoveryAttempt}`,
      },
    );
    if (result.status !== "accepted" || !result.runId || !result.childSessionKey) {
      return { ok: false, reason: result.error ?? "Reviewer launch was not accepted." };
    }
    return {
      ok: true,
      reviewerRunId: result.runId,
      childSessionKey: result.childSessionKey,
    };
  },

  async inspect({ reviewerRunId, childSessionKey }) {
    const run = getSubagentRunByRunId(reviewerRunId);
    if (!run || run.childSessionKey !== childSessionKey) {
      return { state: "missing" };
    }
    if (typeof run.endedAt !== "number") {
      return { state: "live" };
    }
    if (run.outcome?.status !== "ok") {
      return {
        state: "failed",
        reason:
          run.outcome?.status === "error"
            ? (run.outcome.error ?? "Reviewer failed.")
            : `Reviewer ended with ${run.outcome?.status ?? "unknown"}.`,
      };
    }
    const text = run.completion?.resultText?.trim();
    if (!text) {
      return { state: "failed", reason: "Reviewer returned no decision payload." };
    }
    try {
      return { state: "completed", decision: JSON.parse(text) as unknown };
    } catch {
      return { state: "failed", reason: "Reviewer decision payload was not valid JSON." };
    }
  },
};
