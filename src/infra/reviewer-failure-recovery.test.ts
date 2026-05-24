import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_REVIEWER_RETRIES,
  REVIEWER_RUN_FAILED_CHANGE_KIND,
  WORKER_FAILURE_CHANGE_KIND,
  type ReviewerFailedBriefing,
  getReviewerFailureStats,
  isSupersededGeneration,
  observeGeneration,
  planReviewerFailureRecovery,
  resetReviewerFailureRecoveryStateForTests,
} from "./reviewer-failure-recovery.js";

const OWNER_SESSION_KEY = "agent:ghost:main";

function makeCollector() {
  const briefings: ReviewerFailedBriefing[] = [];
  const emitBriefing = (briefing: ReviewerFailedBriefing) => {
    briefings.push(briefing);
  };
  return { briefings, emitBriefing };
}

describe("reviewer-failure-recovery", () => {
  beforeEach(() => {
    resetReviewerFailureRecoveryStateForTests();
  });

  afterEach(() => {
    resetReviewerFailureRecoveryStateForTests();
  });

  it("turns a reviewer-run failure into a real reviewer-retry action and briefs once", () => {
    const { briefings, emitBriefing } = makeCollector();

    const result = planReviewerFailureRecovery(
      {
        kind: "reviewer_run_failed",
        workerId: "task-42",
        reviewerRunId: "rev-1",
        generation: 0,
        sessionKey: OWNER_SESSION_KEY,
        summary: "reviewer crashed before verdict",
        detail: "timeout after 600s",
      },
      { emitBriefing },
    );

    expect(result).toEqual({
      action: {
        type: "reviewer-retry",
        workerId: "task-42",
        reviewerRunId: "rev-1",
        attempt: 1,
        generation: 0,
      },
      changeKind: REVIEWER_RUN_FAILED_CHANGE_KIND,
      briefed: true,
    });

    expect(briefings).toEqual([
      {
        type: "briefing.reviewer_failed",
        workerId: "task-42",
        reviewerRunId: "rev-1",
        generation: 0,
        recovery: "reviewer-retry",
        attempt: 1,
        maxRetries: DEFAULT_MAX_REVIEWER_RETRIES,
        sessionKey: OWNER_SESSION_KEY,
        summary: "reviewer crashed before verdict",
        detail: "timeout after 600s",
      },
    ]);
  });

  it("retries up to the budget then escalates", () => {
    const { briefings, emitBriefing } = makeCollector();
    const base = { kind: "reviewer_run_failed" as const, workerId: "task-7", generation: 3 };

    const first = planReviewerFailureRecovery({ ...base, reviewerRunId: "r1" }, { emitBriefing });
    const second = planReviewerFailureRecovery({ ...base, reviewerRunId: "r2" }, { emitBriefing });
    const third = planReviewerFailureRecovery({ ...base, reviewerRunId: "r3" }, { emitBriefing });

    expect(first.action).toEqual({
      type: "reviewer-retry",
      workerId: "task-7",
      reviewerRunId: "r1",
      attempt: 1,
      generation: 3,
    });
    expect(second.action).toMatchObject({ type: "reviewer-retry", attempt: 2 });
    expect(third.action).toEqual({
      type: "escalate",
      workerId: "task-7",
      reason: "reviewer_retry_exhausted",
      attempts: 3,
      generation: 3,
    });

    expect(briefings).toHaveLength(3);
    expect(briefings[2]).toMatchObject({ recovery: "escalate", attempt: 3 });
  });

  it("honors a custom retry budget", () => {
    const { emitBriefing } = makeCollector();
    const base = { kind: "reviewer_run_failed" as const, workerId: "task-9", generation: 0 };

    const first = planReviewerFailureRecovery(
      { ...base, reviewerRunId: "r1" },
      { maxRetries: 0, emitBriefing },
    );

    // maxRetries 0 → no retries, escalate on first failure.
    expect(first.action).toMatchObject({ type: "escalate", attempts: 1 });
  });

  it("is idempotent for a duplicate reviewer failure event", () => {
    const { briefings, emitBriefing } = makeCollector();
    const event = {
      kind: "reviewer_run_failed" as const,
      workerId: "task-1",
      reviewerRunId: "rev-9",
      generation: 0,
    };

    const first = planReviewerFailureRecovery(event, { emitBriefing });
    const second = planReviewerFailureRecovery(event, { emitBriefing });

    expect(first.action).toMatchObject({ type: "reviewer-retry", attempt: 1 });
    expect(second).toEqual({
      action: { type: "none", reason: "duplicate" },
      changeKind: REVIEWER_RUN_FAILED_CHANGE_KIND,
      briefed: false,
    });
    expect(briefings).toHaveLength(1);
    expect(getReviewerFailureStats().reviewer_run_failed).toBe(1);
  });

  it("drops reviewer failures from a superseded loop generation", () => {
    const { briefings, emitBriefing } = makeCollector();

    const live = planReviewerFailureRecovery(
      { kind: "reviewer_run_failed", workerId: "task-5", reviewerRunId: "r1", generation: 2 },
      { emitBriefing },
    );
    expect(live.action).toMatchObject({ type: "reviewer-retry", attempt: 1 });

    const stale = planReviewerFailureRecovery(
      { kind: "reviewer_run_failed", workerId: "task-5", reviewerRunId: "r0", generation: 1 },
      { emitBriefing },
    );
    expect(stale.action).toEqual({ type: "none", reason: "superseded" });
    expect(stale.briefed).toBe(false);
    expect(briefings).toHaveLength(1);
  });

  it("resets the retry budget when a newer generation starts", () => {
    const { emitBriefing } = makeCollector();

    planReviewerFailureRecovery(
      { kind: "reviewer_run_failed", workerId: "task-6", reviewerRunId: "g1-r1", generation: 1 },
      { emitBriefing },
    );
    const gen1Second = planReviewerFailureRecovery(
      { kind: "reviewer_run_failed", workerId: "task-6", reviewerRunId: "g1-r2", generation: 1 },
      { emitBriefing },
    );
    expect(gen1Second.action).toMatchObject({ attempt: 2 });

    const gen2First = planReviewerFailureRecovery(
      { kind: "reviewer_run_failed", workerId: "task-6", reviewerRunId: "g2-r1", generation: 2 },
      { emitBriefing },
    );
    expect(gen2First.action).toMatchObject({ type: "reviewer-retry", attempt: 1, generation: 2 });
  });

  it("records a worker failure distinctly and does not retry the reviewer or brief", () => {
    const { briefings, emitBriefing } = makeCollector();

    const result = planReviewerFailureRecovery(
      {
        kind: "worker_failed",
        workerId: "task-3",
        generation: 0,
        sessionKey: OWNER_SESSION_KEY,
        summary: "worker exited non-zero",
      },
      { emitBriefing },
    );

    expect(result).toEqual({
      action: { type: "worker-report", workerId: "task-3", generation: 0 },
      changeKind: WORKER_FAILURE_CHANGE_KIND,
      briefed: false,
    });
    expect(briefings).toHaveLength(0);

    const stats = getReviewerFailureStats();
    expect(stats).toEqual({ reviewer_run_failed: 0, worker_failed: 1 });
  });

  it("supersedes an older reviewer retry once the worker itself fails in a newer generation", () => {
    const { emitBriefing } = makeCollector();

    planReviewerFailureRecovery(
      { kind: "reviewer_run_failed", workerId: "task-8", reviewerRunId: "r1", generation: 0 },
      { emitBriefing },
    );

    // A worker failure at a newer generation advances the supersession line.
    const workerFail = planReviewerFailureRecovery(
      { kind: "worker_failed", workerId: "task-8", generation: 1 },
      { emitBriefing },
    );
    expect(workerFail.action).toMatchObject({ type: "worker-report", generation: 1 });

    const stale = planReviewerFailureRecovery(
      { kind: "reviewer_run_failed", workerId: "task-8", reviewerRunId: "r2", generation: 0 },
      { emitBriefing },
    );
    expect(stale.action).toEqual({ type: "none", reason: "superseded" });
  });

  it("returns no_worker_id and missing_reviewer_run_id for malformed events", () => {
    const noWorker = planReviewerFailureRecovery({
      kind: "reviewer_run_failed",
      workerId: "  ",
      reviewerRunId: "r1",
    });
    expect(noWorker.action).toEqual({ type: "none", reason: "no_worker_id" });
    expect(noWorker.changeKind).toBe(REVIEWER_RUN_FAILED_CHANGE_KIND);

    const noRun = planReviewerFailureRecovery({
      kind: "reviewer_run_failed",
      workerId: "task-x",
    });
    expect(noRun.action).toEqual({ type: "none", reason: "missing_reviewer_run_id" });
  });

  it("computes recovery without an emitter and reports briefed=false", () => {
    const result = planReviewerFailureRecovery({
      kind: "reviewer_run_failed",
      workerId: "task-2",
      reviewerRunId: "r1",
      generation: 0,
    });
    expect(result.action).toMatchObject({ type: "reviewer-retry", attempt: 1 });
    expect(result.briefed).toBe(false);
  });

  it("does not throw when the briefing emitter throws", () => {
    const emitBriefing = vi.fn(() => {
      throw new Error("transport down");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = planReviewerFailureRecovery(
      { kind: "reviewer_run_failed", workerId: "task-4", reviewerRunId: "r1", generation: 0 },
      { emitBriefing },
    );

    expect(result.action).toMatchObject({ type: "reviewer-retry" });
    expect(result.briefed).toBe(true);
    expect(emitBriefing).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("exposes the supersession filter directly", () => {
    expect(isSupersededGeneration("task-10", 0)).toBe(false);
    observeGeneration("task-10", 5);
    expect(isSupersededGeneration("task-10", 4)).toBe(true);
    expect(isSupersededGeneration("task-10", 5)).toBe(false);
    expect(isSupersededGeneration("task-10", 6)).toBe(false);
  });
});
