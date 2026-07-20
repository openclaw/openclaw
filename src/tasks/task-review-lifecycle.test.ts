// Verifies durable, idempotent managed review handoff and closed lifecycle transitions.
import { afterEach, describe, expect, it } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { captureEnv } from "../test-utils/env.js";
import { reloadTaskRuntimeStateFromStore } from "./runtime-internal.js";
import { recordTaskRunProgressByRunId } from "./task-executor.js";
import { createManagedTaskFlow } from "./task-flow-registry.js";
import { listTasksForFlowId } from "./task-registry.js";
import {
  previewTaskRegistryMaintenance,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import {
  applyTaskReviewDecision,
  beginTaskReviewRecovery,
  dispatchTaskReview,
  markTaskReviewReverifyPending,
  parseTaskReviewDetail,
  reconcileStaleTaskReviews,
  resumeTaskReviewVerification,
  type TaskReviewRequest,
} from "./task-review-lifecycle.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);
const OWNER_KEY = "agent:main:main";
const COMMIT = "1".repeat(40);

function buildRequest(overrides: Partial<TaskReviewRequest> = {}): TaskReviewRequest {
  return {
    reviewerAgentId: "reviewer",
    staleAfterMs: 1_000,
    proofBundle: {
      commit: COMMIT,
      baseCommit: "2".repeat(40),
      diff: {
        sha256: "3".repeat(64),
        summary: "Add durable review handoff.",
        files: ["src/review.ts"],
      },
      tests: [
        {
          name: "focused",
          command: "vitest review",
          status: "passed",
          evidence: "12 tests passed",
        },
      ],
      screenshots: [],
      criteria: [{ id: "criterion-1", description: "Review remains durable." }],
    },
    ...overrides,
  };
}

async function withReviewState(run: () => Promise<void> | void): Promise<void> {
  await withStateDirEnv("openclaw-task-review-", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    stopTaskRegistryMaintenance();
    resetTaskRegistryMaintenanceRuntimeForTests();
    await run();
  });
}

function createReviewFlow(request = buildRequest()) {
  const flow = createManagedTaskFlow({
    ownerKey: OWNER_KEY,
    controllerId: "tests/review",
    goal: "Review exact proof",
    stateJson: { reviewRequest: request },
  });
  if (!flow) {
    throw new Error("Expected managed flow creation to succeed.");
  }
  return flow;
}

function dispatch(flowId: string, request = buildRequest(), now = 10_000) {
  return dispatchTaskReview({
    flowId,
    callerOwnerKey: OWNER_KEY,
    request,
    continuity: {
      ownerKey: OWNER_KEY,
      sessionKey: OWNER_KEY,
      sessionId: "session-before-compact",
      compactionCount: 3,
      sourceTaskId: "source-task",
    },
    parentTaskId: "source-task",
    now,
  });
}

describe("task review lifecycle", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("atomically persists one reviewer, linkage, continuity, and exact proof across reload", async () => {
    await withReviewState(() => {
      const flow = createReviewFlow();
      const first = dispatch(flow.flowId);
      expect(first.ok).toBe(true);
      if (!first.ok) {
        return;
      }
      expect(first.created).toBe(true);
      expect(first.task.parentFlowId).toBe(flow.flowId);
      expect(first.task.parentTaskId).toBe("source-task");
      expect(first.task.agentId).toBe("reviewer");
      expect(first.detail.proofBundle.commit).toBe(COMMIT);
      expect(first.detail.continuity.compactionCount).toBe(3);

      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      reloadTaskRuntimeStateFromStore();

      const replay = dispatch(flow.flowId);
      expect(replay.ok).toBe(true);
      if (!replay.ok) {
        return;
      }
      expect(replay.created).toBe(false);
      expect(replay.task.taskId).toBe(first.task.taskId);
      expect(listTasksForFlowId(flow.flowId)).toHaveLength(1);
      expect(parseTaskReviewDetail(replay.task)).toEqual(first.detail);
    });
  });

  it("accepts merge_ready only for the exact commit with passing proof and criteria", async () => {
    await withReviewState(() => {
      const flow = createReviewFlow();
      const result = dispatch(flow.flowId);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(() =>
        applyTaskReviewDecision({
          taskId: result.task.taskId,
          decision: {
            outcome: "merge_ready",
            reviewedCommit: "4".repeat(40),
            criteria: [{ id: "criterion-1", status: "passed", evidence: "verified" }],
            findings: [],
          },
        }),
      ).toThrow(/commit does not match/u);

      const updated = applyTaskReviewDecision({
        taskId: result.task.taskId,
        now: 11_000,
        decision: {
          outcome: "merge_ready",
          reviewedCommit: COMMIT,
          criteria: [{ id: "criterion-1", status: "passed", evidence: "verified" }],
          findings: [],
        },
      });
      expect(updated.status).toBe("succeeded");
      expect(updated.terminalOutcome).toBe("succeeded");
      expect(parseTaskReviewDetail(updated)?.state).toBe("merge_ready");
    });
  });

  it("persists actionable changes_requested and genuine awaiting_owner outcomes", async () => {
    await withReviewState(() => {
      const changesFlow = createReviewFlow();
      const changes = dispatch(changesFlow.flowId);
      if (!changes.ok) {
        throw new Error(changes.reason);
      }
      expect(() =>
        applyTaskReviewDecision({
          taskId: changes.task.taskId,
          decision: {
            outcome: "changes_requested",
            reviewedCommit: COMMIT,
            criteria: [{ id: "criterion-1", status: "failed", evidence: "missing" }],
            findings: [],
          },
        }),
      ).toThrow(/actionable finding/u);
      const changed = applyTaskReviewDecision({
        taskId: changes.task.taskId,
        decision: {
          outcome: "changes_requested",
          reviewedCommit: COMMIT,
          criteria: [{ id: "criterion-1", status: "failed", evidence: "missing" }],
          findings: ["Persist the recovery marker."],
        },
      });
      expect(parseTaskReviewDetail(changed)?.state).toBe("changes_requested");
      expect(changed.terminalOutcome).toBe("blocked");

      const ownerFlow = createReviewFlow({ ...buildRequest(), reviewerAgentId: "owner-reviewer" });
      const owner = dispatch(ownerFlow.flowId, {
        ...buildRequest(),
        reviewerAgentId: "owner-reviewer",
      });
      if (!owner.ok) {
        throw new Error(owner.reason);
      }
      expect(() =>
        applyTaskReviewDecision({
          taskId: owner.task.taskId,
          decision: {
            outcome: "awaiting_owner",
            reviewedCommit: COMMIT,
            criteria: [{ id: "criterion-1", status: "passed", evidence: "verified" }],
            ownerQuestion: "",
            whyAutomationCannotDecide: "Product policy choice.",
          },
        }),
      ).toThrow(/ownerQuestion/u);
      const awaitingOwner = applyTaskReviewDecision({
        taskId: owner.task.taskId,
        decision: {
          outcome: "awaiting_owner",
          reviewedCommit: COMMIT,
          criteria: [{ id: "criterion-1", status: "passed", evidence: "verified" }],
          ownerQuestion: "Should this policy exception be accepted?",
          whyAutomationCannotDecide: "The product owner must choose the policy tradeoff.",
        },
      });
      expect(parseTaskReviewDetail(awaitingOwner)?.state).toBe("awaiting_owner");
      expect(awaitingOwner.terminalOutcome).toBe("blocked");
    });
  });

  it("escalates stale unclaimed reviews and records recovery and reverify states", async () => {
    await withReviewState(() => {
      const flow = createReviewFlow();
      const result = dispatch(flow.flowId, buildRequest(), 1_000);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      if (result.task.lastEventAt === undefined) {
        throw new Error("Expected review task activity timestamp.");
      }
      const stale = reconcileStaleTaskReviews({
        tasks: listTasksForFlowId(flow.flowId),
        now: result.task.lastEventAt + 1_001,
      });
      expect(stale).toEqual({ escalated: 1, taskIds: [result.task.taskId] });
      expect(parseTaskReviewDetail(listTasksForFlowId(flow.flowId)[0]!)?.state).toBe(
        "recovery_pending",
      );
      expect(
        parseTaskReviewDetail(beginTaskReviewRecovery({ taskId: result.task.taskId, now: 3_000 }))
          ?.state,
      ).toBe("recovering");
      expect(
        parseTaskReviewDetail(
          markTaskReviewReverifyPending({ taskId: result.task.taskId, now: 4_000 }),
        )?.state,
      ).toBe("reverify_pending");
      expect(
        parseTaskReviewDetail(
          resumeTaskReviewVerification({ taskId: result.task.taskId, now: 5_000 }),
        )?.state,
      ).toBe("review_pending");
    });
  });

  it("escalates an unclaimed reviewer through the registry maintenance pass", async () => {
    await withReviewState(async () => {
      const flow = createReviewFlow();
      const result = dispatch(flow.flowId);
      if (!result.ok || !result.task.runId) {
        throw new Error(result.ok ? "Expected stable review run id." : result.reason);
      }
      recordTaskRunProgressByRunId({
        runId: result.task.runId,
        lastEventAt: Date.now() - 2_000,
      });

      expect(previewTaskRegistryMaintenance().reconciled).toBe(1);
      expect((await runTaskRegistryMaintenance()).reconciled).toBe(1);
      expect(parseTaskReviewDetail(listTasksForFlowId(flow.flowId)[0]!)?.state).toBe(
        "recovery_pending",
      );
    });
  });
});
