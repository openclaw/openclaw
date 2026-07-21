// Verifies durable, idempotent managed review handoff and closed lifecycle transitions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTasksCommand } from "../auto-reply/reply/commands-tasks.js";
import type { HandleCommandsParams } from "../auto-reply/reply/commands-types.js";
import { setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { captureEnv } from "../test-utils/env.js";
import { reloadTaskRuntimeStateFromStore } from "./runtime-internal.js";
import { mapTaskFlowDetail } from "./task-domain-views.js";
import { recordTaskRunProgressByRunId } from "./task-executor.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import { listTasksForFlowId } from "./task-registry.js";
import {
  previewTaskRegistryMaintenance,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceReviewerRuntimeForTests,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  applyTaskReviewDecision,
  beginTaskReviewRecovery,
  dispatchTaskReview,
  markTaskReviewReverifyPending,
  parseTaskReviewDetail,
  reconcileTaskReviewRuntime,
  reconcileStaleTaskReviews,
  resumeTaskReviewVerification,
  type TaskReviewRequest,
  type TaskReviewerRuntime,
} from "./task-review-lifecycle.js";
import {
  commitReviewTaskAndFlowAtomically,
  createReviewDispatchAtomically,
} from "./task-review-store.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";
import { formatTaskStatusDetail } from "./task-status.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);
const OWNER_KEY = "agent:main:main";
const COMMIT = "1".repeat(40);
const reviewerRuntime: TaskReviewerRuntime = {
  async launch({ detail, recoveryAttempt }) {
    return {
      ok: true,
      reviewerRunId: `reviewer-${detail.dispatchKey}-${recoveryAttempt}`,
      childSessionKey: `agent:reviewer:subagent:${detail.dispatchKey}-${recoveryAttempt}`,
    };
  },
  async inspect() {
    return { state: "live" };
  },
};

function buildRequest(overrides: Partial<TaskReviewRequest> = {}): TaskReviewRequest {
  return {
    reviewerAgentId: "reviewer",
    staleAfterMs: 1_000,
    maxRecoveryAttempts: 2,
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

function buildRequestForCommit(digit: string, overrides: Partial<TaskReviewRequest> = {}) {
  const base = buildRequest();
  return {
    ...base,
    proofBundle: {
      ...base.proofBundle,
      commit: digit.repeat(40),
      diff: { ...base.proofBundle.diff, sha256: digit.repeat(64) },
    },
    ...overrides,
  } satisfies TaskReviewRequest;
}

function replaceReviewRequest(flowId: string, request: TaskReviewRequest): void {
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    throw new Error("Expected review flow.");
  }
  const state =
    flow.stateJson && typeof flow.stateJson === "object" && !Array.isArray(flow.stateJson)
      ? flow.stateJson
      : {};
  const updated = updateFlowRecordByIdExpectedRevision({
    flowId,
    expectedRevision: flow.revision,
    patch: { stateJson: { ...state, reviewRequest: request } },
  });
  if (!updated.applied) {
    throw new Error("Expected review request update.");
  }
}

function reopenReviewState(): void {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  closeOpenClawStateDatabaseForTest();
  reloadTaskRuntimeStateFromStore();
}

async function renderTasksCommand(): Promise<string> {
  const result = await handleTasksCommand(
    {
      cfg: {},
      command: {
        commandBodyNormalized: "/tasks",
        isAuthorizedSender: true,
        senderIsOwner: true,
        channel: "whatsapp",
        ownerList: [],
      },
      sessionKey: OWNER_KEY,
    } as unknown as HandleCommandsParams,
    true,
  );
  return result?.reply?.text ?? "";
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
    runtime: reviewerRuntime,
  });
}

describe("task review lifecycle", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("atomically persists one reviewer, linkage, continuity, and exact proof across reload", async () => {
    await withReviewState(async () => {
      const flow = createReviewFlow();
      const first = await dispatch(flow.flowId);
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

      const replay = await dispatch(flow.flowId);
      expect(replay.ok).toBe(true);
      if (!replay.ok) {
        return;
      }
      expect(replay.created).toBe(false);
      expect(replay.task.taskId).toBe(first.task.taskId);
      expect(listTasksForFlowId(flow.flowId)).toHaveLength(1);
      expect(parseTaskReviewDetail(replay.task)).toEqual(first.detail);

      const successor = await dispatchTaskReview({
        flowId: flow.flowId,
        callerOwnerKey: OWNER_KEY,
        request: buildRequest(),
        continuity: {
          ownerKey: OWNER_KEY,
          sessionKey: OWNER_KEY,
          sessionId: "session-after-compact",
          compactionCount: 4,
          sourceTaskId: "source-task",
        },
        parentTaskId: "source-task",
        now: 12_000,
        runtime: reviewerRuntime,
      });
      expect(successor.ok).toBe(true);
      if (successor.ok) {
        expect(successor.created).toBe(false);
        expect(successor.detail.continuity).toMatchObject({
          sessionId: "session-after-compact",
          compactionCount: 4,
        });
      }
    });
  });

  it("admits one launch under concurrent duplicate dispatch", async () => {
    await withReviewState(async () => {
      const flow = createReviewFlow();
      const launch = vi.fn((params) => reviewerRuntime.launch(params));
      const runtime = { ...reviewerRuntime, launch };
      const dispatchOnce = () =>
        dispatchTaskReview({
          flowId: flow.flowId,
          callerOwnerKey: OWNER_KEY,
          request: buildRequest(),
          continuity: { ownerKey: OWNER_KEY, sessionKey: OWNER_KEY },
          runtime,
        });
      const results = await Promise.all([dispatchOnce(), dispatchOnce()]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
      expect(launch).toHaveBeenCalledTimes(1);
      expect(listTasksForFlowId(flow.flowId)).toHaveLength(1);
    });
  });

  it("does not recover a fresh initial launch claim while launch is held", async () => {
    await withReviewState(async () => {
      const flow = createReviewFlow();
      let releaseLaunch:
        | ((value: Awaited<ReturnType<TaskReviewerRuntime["launch"]>>) => void)
        | undefined;
      const launch = vi.fn(
        async () =>
          await new Promise<Awaited<ReturnType<TaskReviewerRuntime["launch"]>>>((resolve) => {
            releaseLaunch = resolve;
          }),
      );
      const runtime: TaskReviewerRuntime = { ...reviewerRuntime, launch };
      const dispatching = dispatchTaskReview({
        flowId: flow.flowId,
        callerOwnerKey: OWNER_KEY,
        request: buildRequest(),
        continuity: { ownerKey: OWNER_KEY, sessionKey: OWNER_KEY },
        now: 10_000,
        runtime,
      });
      await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
      const claimed = listTasksForFlowId(flow.flowId)[0]!;
      expect(parseTaskReviewDetail(claimed)?.launch).toMatchObject({
        phase: "claimed",
        attempt: 0,
      });

      const maintained = await reconcileTaskReviewRuntime({
        taskId: claimed.taskId,
        runtime,
        now: 10_500,
      });
      expect(maintained.state).toBe("adopted");
      expect(launch).toHaveBeenCalledTimes(1);

      releaseLaunch?.({
        ok: true,
        reviewerRunId: "run-0",
        childSessionKey: "agent:reviewer:subagent:attempt-0",
      });
      const dispatched = await dispatching;
      expect(dispatched.ok).toBe(true);
      if (dispatched.ok) {
        expect(dispatched.detail.launch).toMatchObject({ phase: "bound", attempt: 0 });
      }
    });
  });

  it("replays an accepted-but-unbound claim after reopen using the same attempt and child", async () => {
    await withReviewState(async () => {
      const flow = createReviewFlow();
      const launches: number[] = [];
      let holdInitial = true;
      const runtime: TaskReviewerRuntime = {
        ...reviewerRuntime,
        async launch({ recoveryAttempt }) {
          launches.push(recoveryAttempt);
          if (holdInitial) {
            holdInitial = false;
            return await new Promise(() => {
              // Simulate process loss after external acceptance but before durable binding.
            });
          }
          return {
            ok: true,
            reviewerRunId: "accepted-run-0",
            childSessionKey: "agent:reviewer:subagent:accepted-attempt-0",
          };
        },
      };
      void dispatchTaskReview({
        flowId: flow.flowId,
        callerOwnerKey: OWNER_KEY,
        request: buildRequest(),
        continuity: { ownerKey: OWNER_KEY, sessionKey: OWNER_KEY },
        now: 10_000,
        runtime,
      });
      await vi.waitFor(() => expect(launches).toEqual([0]));

      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      reloadTaskRuntimeStateFromStore();
      const claimed = listTasksForFlowId(flow.flowId)[0]!;
      const replayed = await reconcileTaskReviewRuntime({
        taskId: claimed.taskId,
        runtime,
        now: 11_001,
      });
      expect(replayed.state).toBe("recovered");
      expect(launches).toEqual([0, 0]);
      expect(parseTaskReviewDetail(replayed.task)).toMatchObject({
        recoveryAttempt: 0,
        launch: {
          phase: "bound",
          attempt: 0,
          reviewerRunId: "accepted-run-0",
          childSessionKey: "agent:reviewer:subagent:accepted-attempt-0",
        },
      });
      expect(listTasksForFlowId(flow.flowId)).toHaveLength(1);
    });
  });

  it("rejects attempt zero while attempt one is still claimed and accounts for both children", async () => {
    await withReviewState(async () => {
      const flow = createReviewFlow();
      let releaseInitial:
        | ((value: Awaited<ReturnType<TaskReviewerRuntime["launch"]>>) => void)
        | undefined;
      let releaseAttemptOne:
        | ((value: Awaited<ReturnType<TaskReviewerRuntime["launch"]>>) => void)
        | undefined;
      const launches: number[] = [];
      const acceptedChildren = new Set<string>();
      const settledNonOwners = new Set<string>();
      const runtime: TaskReviewerRuntime = {
        ...reviewerRuntime,
        async launch({ recoveryAttempt }) {
          launches.push(recoveryAttempt);
          if (launches.length === 1) {
            return await new Promise((resolve) => {
              releaseInitial = resolve;
            });
          }
          if (launches.length === 2) {
            return { ok: false, reason: "attempt zero was not found" };
          }
          return await new Promise((resolve) => {
            releaseAttemptOne = resolve;
          });
        },
        async settleNonOwningLaunch({ childSessionKey }) {
          settledNonOwners.add(childSessionKey);
        },
      };
      const dispatching = dispatchTaskReview({
        flowId: flow.flowId,
        callerOwnerKey: OWNER_KEY,
        request: buildRequest(),
        continuity: { ownerKey: OWNER_KEY, sessionKey: OWNER_KEY },
        now: 10_000,
        runtime,
      });
      await vi.waitFor(() => expect(launches).toEqual([0]));
      const task = listTasksForFlowId(flow.flowId)[0]!;
      const recovering = reconcileTaskReviewRuntime({
        taskId: task.taskId,
        runtime,
        now: 11_001,
      });
      await vi.waitFor(() => expect(launches).toEqual([0, 0, 1]));
      expect(parseTaskReviewDetail(listTasksForFlowId(flow.flowId)[0]!)?.launch).toMatchObject({
        phase: "claimed",
        attempt: 1,
      });

      acceptedChildren.add("agent:reviewer:subagent:late-attempt-0");
      releaseInitial?.({
        ok: true,
        reviewerRunId: "late-run-0",
        childSessionKey: "agent:reviewer:subagent:late-attempt-0",
      });
      const settled = await dispatching;
      expect(settled.ok).toBe(true);
      if (settled.ok) {
        expect(settled.detail.launch).toMatchObject({
          phase: "claimed",
          attempt: 1,
        });
        expect(settled.task.childSessionKey).toBeUndefined();
      }
      expect(settledNonOwners).toEqual(new Set(["agent:reviewer:subagent:late-attempt-0"]));

      acceptedChildren.add("agent:reviewer:subagent:attempt-1");
      releaseAttemptOne?.({
        ok: true,
        reviewerRunId: "run-1",
        childSessionKey: "agent:reviewer:subagent:attempt-1",
      });
      const recovered = await recovering;
      expect(recovered.state).toBe("recovered");
      expect(parseTaskReviewDetail(recovered.task)?.launch).toMatchObject({
        phase: "bound",
        attempt: 1,
        reviewerRunId: "run-1",
        childSessionKey: "agent:reviewer:subagent:attempt-1",
      });
      expect(recovered.task.childSessionKey).toBe("agent:reviewer:subagent:attempt-1");
      const accountedChildren = new Set([...settledNonOwners, recovered.task.childSessionKey!]);
      expect(accountedChildren).toEqual(acceptedChildren);
    });
  });

  it("rolls back the flow CAS and task insert when the coupled delivery insert fails", async () => {
    await withReviewState(() => {
      const flow = createReviewFlow();
      const task: TaskRecord = {
        taskId: null as unknown as string,
        runtime: "subagent",
        requesterSessionKey: OWNER_KEY,
        ownerKey: OWNER_KEY,
        scopeKind: "session",
        task: "rollback fixture",
        status: "queued",
        notifyPolicy: "state_changes",
        deliveryStatus: "pending",
        createdAt: 20_000,
      };
      expect(() =>
        createReviewDispatchAtomically({
          flow,
          expectedRevision: flow.revision,
          nextStateJson: { review: { state: "review_pending" } },
          task,
        }),
      ).toThrow();
      reloadTaskRuntimeStateFromStore();
      expect(listTasksForFlowId(flow.flowId)).toHaveLength(0);
      expect(getTaskFlowById(flow.flowId)?.revision).toBe(flow.revision);
      expect(getTaskFlowById(flow.flowId)?.status).toBe(flow.status);
    });
  });

  it("rolls back a terminal flow projection when the task detail CAS loses", async () => {
    await withReviewState(async () => {
      const flow = createReviewFlow();
      const dispatched = await dispatch(flow.flowId);
      if (!dispatched.ok) {
        throw new Error(dispatched.reason);
      }
      const beforeFlow = getTaskFlowById(flow.flowId)!;
      const beforeTask = listTasksForFlowId(flow.flowId)[0]!;
      const result = commitReviewTaskAndFlowAtomically({
        task: beforeTask,
        expectedDetail: { wrong: "detail" },
        nextTask: {
          ...beforeTask,
          status: "succeeded",
          endedAt: 30_000,
          terminalSummary: "must roll back",
        },
        reviewProjection: { state: "merge_ready", taskId: beforeTask.taskId },
        flowStatus: "waiting",
        currentStep: "merge_ready",
        now: 30_000,
      });
      expect(result).toEqual({ status: "task_conflict" });
      reopenReviewState();
      expect(getTaskFlowById(flow.flowId)?.revision).toBe(beforeFlow.revision);
      expect(getTaskFlowById(flow.flowId)?.currentStep).toBe(beforeFlow.currentStep);
      expect(listTasksForFlowId(flow.flowId)[0]).toMatchObject({
        status: beforeTask.status,
        childSessionKey: beforeTask.childSessionKey,
      });
    });
  });

  it("accepts merge_ready only for the exact commit with passing proof and criteria", async () => {
    await withReviewState(async () => {
      const flow = createReviewFlow();
      const result = await dispatch(flow.flowId);
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
    await withReviewState(async () => {
      const changesFlow = createReviewFlow();
      const changes = await dispatch(changesFlow.flowId);
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
      const owner = await dispatch(ownerFlow.flowId, {
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
    await withReviewState(async () => {
      const flow = createReviewFlow();
      const result = await dispatch(flow.flowId, buildRequest(), 1_000);
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
      const result = await dispatch(flow.flowId);
      if (!result.ok || !result.task.runId) {
        throw new Error(result.ok ? "Expected stable review run id." : result.reason);
      }
      recordTaskRunProgressByRunId({
        runId: result.task.runId,
        lastEventAt: Date.now() - 2_000,
      });

      const replacementRuntime: TaskReviewerRuntime = {
        ...reviewerRuntime,
        inspect: async () => ({ state: "missing" }),
      };
      setTaskRegistryMaintenanceReviewerRuntimeForTests(replacementRuntime);

      expect(previewTaskRegistryMaintenance().reconciled).toBe(0);
      expect((await runTaskRegistryMaintenance()).reconciled).toBe(0);
      expect(parseTaskReviewDetail(listTasksForFlowId(flow.flowId)[0]!)?.state).toBe(
        "review_pending",
      );
      expect(parseTaskReviewDetail(listTasksForFlowId(flow.flowId)[0]!)?.recoveryAttempt).toBe(1);
    });
  });

  it("adopts one live child or creates one bounded deterministic replacement", async () => {
    await withReviewState(async () => {
      const flow = createReviewFlow();
      const result = await dispatch(flow.flowId);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      const launch = vi.fn((params) => reviewerRuntime.launch(params));
      const adopted = await reconcileTaskReviewRuntime({
        taskId: result.task.taskId,
        runtime: { ...reviewerRuntime, launch },
        now: 11_000,
      });
      expect(adopted.state).toBe("adopted");
      expect(launch).not.toHaveBeenCalled();

      const replaced = await reconcileTaskReviewRuntime({
        taskId: result.task.taskId,
        runtime: { ...reviewerRuntime, launch, inspect: async () => ({ state: "missing" }) },
        now: 12_000,
      });
      expect(replaced.state).toBe("recovered");
      expect(launch).toHaveBeenCalledTimes(1);
      expect(parseTaskReviewDetail(replaced.task)).toMatchObject({
        state: "review_pending",
        recoveryAttempt: 1,
      });
    });
  });

  it("fails closed after the configured replacement limit", async () => {
    await withReviewState(async () => {
      const request = buildRequest({ maxRecoveryAttempts: 1 });
      const flow = createReviewFlow(request);
      const result = await dispatch(flow.flowId, request);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      const exhausted = await reconcileTaskReviewRuntime({
        taskId: result.task.taskId,
        runtime: {
          inspect: async () => ({ state: "missing" }),
          launch: async () => ({ ok: false, reason: "reviewer unavailable" }),
        },
        now: 12_000,
      });
      expect(exhausted.state).toBe("failed");
      expect(exhausted.task.status).toBe("failed");
      expect(parseTaskReviewDetail(exhausted.task)).toMatchObject({
        state: "recovery_failed",
        recoveryAttempt: 1,
        maxRecoveryAttempts: 1,
      });
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "failed",
        currentStep: "recovery_failed",
      });
    });
  });

  it("reopens changes_requested into a clean new review and merge_ready projection", async () => {
    await withReviewState(async () => {
      const firstRequest = buildRequestForCommit("1");
      const flow = createReviewFlow(firstRequest);
      const first = await dispatch(flow.flowId, firstRequest);
      if (!first.ok) {
        throw new Error(first.reason);
      }
      applyTaskReviewDecision({
        taskId: first.task.taskId,
        now: 20_000,
        decision: {
          outcome: "changes_requested",
          reviewedCommit: firstRequest.proofBundle.commit,
          criteria: [{ id: "criterion-1", status: "failed", evidence: "old blocker" }],
          findings: ["Fix the old blocker."],
        },
      });
      const secondRequest = buildRequestForCommit("4");
      replaceReviewRequest(flow.flowId, secondRequest);
      const beforeNewReview = getTaskFlowById(flow.flowId)!;
      expect(
        updateFlowRecordByIdExpectedRevision({
          flowId: flow.flowId,
          expectedRevision: beforeNewReview.revision,
          patch: { waitJson: { kind: "old-wait" } },
        }).applied,
      ).toBe(true);

      const second = await dispatch(flow.flowId, secondRequest, 21_000);
      if (!second.ok) {
        throw new Error(second.reason);
      }
      reopenReviewState();
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "waiting",
        currentStep: "review_pending",
      });
      expect(getTaskFlowById(flow.flowId)?.blockedTaskId).toBeUndefined();
      expect(getTaskFlowById(flow.flowId)?.blockedSummary).toBeUndefined();
      expect(getTaskFlowById(flow.flowId)?.endedAt).toBeUndefined();
      expect(getTaskFlowById(flow.flowId)?.waitJson).toBeUndefined();

      const currentSecond = listTasksForFlowId(flow.flowId).find(
        (task) => parseTaskReviewDetail(task)?.dispatchKey === second.detail.dispatchKey,
      )!;
      const merged = applyTaskReviewDecision({
        taskId: currentSecond.taskId,
        now: 22_000,
        decision: {
          outcome: "merge_ready",
          reviewedCommit: secondRequest.proofBundle.commit,
          criteria: [{ id: "criterion-1", status: "passed", evidence: "new proof verified" }],
          findings: [],
        },
      });
      reopenReviewState();
      const reopenedFlow = getTaskFlowById(flow.flowId)!;
      const reopenedTasks = listTasksForFlowId(flow.flowId);
      const reopenedMerged = reopenedTasks.find((task) => task.taskId === merged.taskId)!;
      expect(reopenedFlow).toMatchObject({ status: "waiting", currentStep: "merge_ready" });
      expect(reopenedFlow.blockedTaskId).toBeUndefined();
      expect(reopenedFlow.blockedSummary).toBeUndefined();
      expect(reopenedFlow.endedAt).toBeUndefined();
      expect(reopenedMerged).toMatchObject({
        status: "succeeded",
        terminalOutcome: "succeeded",
      });
      expect(formatTaskStatusDetail(reopenedMerged)).toContain("Merge ready");
      const tasksText = await renderTasksCommand();
      expect(tasksText).toContain("Merge ready");
      expect(mapTaskFlowDetail({ flow: reopenedFlow, tasks: reopenedTasks })).toMatchObject({
        status: "waiting",
        currentStep: "merge_ready",
        tasks: expect.arrayContaining([
          expect.objectContaining({
            id: reopenedMerged.taskId,
            status: "succeeded",
            terminalOutcome: "succeeded",
          }),
        ]),
        state: { review: { state: "merge_ready", taskId: reopenedMerged.taskId } },
      });
    });
  });

  it("reopens recovery_failed into a clean active review", async () => {
    await withReviewState(async () => {
      const firstRequest = buildRequestForCommit("1", { maxRecoveryAttempts: 1 });
      const flow = createReviewFlow(firstRequest);
      const first = await dispatch(flow.flowId, firstRequest);
      if (!first.ok) {
        throw new Error(first.reason);
      }
      await reconcileTaskReviewRuntime({
        taskId: first.task.taskId,
        runtime: {
          inspect: async () => ({ state: "missing" }),
          launch: async () => ({ ok: false, reason: "reviewer unavailable" }),
        },
        now: 20_000,
      });
      reopenReviewState();
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "failed",
        currentStep: "recovery_failed",
        endedAt: 20_000,
      });

      const secondRequest = buildRequestForCommit("5");
      replaceReviewRequest(flow.flowId, secondRequest);
      const second = await dispatch(flow.flowId, secondRequest, 21_000);
      if (!second.ok) {
        throw new Error(second.reason);
      }
      reopenReviewState();
      const reopenedFlow = getTaskFlowById(flow.flowId)!;
      const reopenedTask = listTasksForFlowId(flow.flowId).find(
        (task) => task.taskId === second.task.taskId,
      )!;
      expect(reopenedFlow).toMatchObject({ status: "waiting", currentStep: "review_pending" });
      expect(reopenedFlow.endedAt).toBeUndefined();
      expect(reopenedFlow.blockedTaskId).toBeUndefined();
      expect(reopenedFlow.blockedSummary).toBeUndefined();
      expect(reopenedTask.status).toBe("running");
      expect(parseTaskReviewDetail(reopenedTask)?.state).toBe("review_pending");
      expect(await renderTasksCommand()).toContain("Reviewer child is running");
      expect(mapTaskFlowDetail({ flow: reopenedFlow, tasks: [reopenedTask] })).toMatchObject({
        status: "waiting",
        currentStep: "review_pending",
        tasks: [expect.objectContaining({ id: reopenedTask.taskId, status: "running" })],
        state: { review: { state: "review_pending", taskId: reopenedTask.taskId } },
      });
    });
  });

  it("ingests a typed reviewer decision and projects truthful task and flow status", async () => {
    await withReviewState(async () => {
      const wakes: Array<{ source: string; sessionKey?: string }> = [];
      const clearWake = setHeartbeatWakeHandler(async (request) => {
        wakes.push(request);
        return { status: "ran", durationMs: 0 };
      });
      const flow = createReviewFlow();
      const result = await dispatch(flow.flowId);
      if (!result.ok) {
        throw new Error(result.reason);
      }
      const completed = await reconcileTaskReviewRuntime({
        taskId: result.task.taskId,
        runtime: {
          ...reviewerRuntime,
          inspect: async () => ({
            state: "completed",
            decision: {
              outcome: "changes_requested",
              reviewedCommit: COMMIT,
              criteria: [{ id: "criterion-1", status: "failed", evidence: "fixture" }],
              findings: ["Fix the fixture."],
            },
          }),
        },
        now: 13_000,
      });
      expect(completed.state).toBe("completed");
      expect(completed.task).toMatchObject({ status: "succeeded", terminalOutcome: "blocked" });
      expect(parseTaskReviewDetail(completed.task)?.state).toBe("changes_requested");
      expect(getTaskFlowById(flow.flowId)).toMatchObject({
        status: "blocked",
        currentStep: "changes_requested",
        blockedTaskId: result.task.taskId,
      });
      await vi.waitFor(() => {
        expect(wakes).toContainEqual(
          expect.objectContaining({ source: "background-task", sessionKey: OWNER_KEY }),
        );
      });
      clearWake();
    });
  });
});
