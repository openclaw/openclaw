import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);

function timeoutCandidate() {
  const f = preExistingCandidate("jobs: {}\n");
  const state = f.state();
  const check = state.priorCi.deadline.check;
  check.head_sha = f.head;
  Object.assign(state.priorCi.jobs![0]!, {
    conclusion: "cancelled",
    check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/601",
    started_at: check.started_at,
    completed_at: check.completed_at,
    steps: [
      { number: 18, name: "Run Node test shard", status: "completed", conclusion: "cancelled" },
    ],
  });
  state.priorCi.jobs = state.priorCi.jobs!.filter((job) => job.id !== 604);
  f.save(state);
  const { cancellation: _cancellation, ...evidence } = f.evidence;
  writeFileSync(f.path, JSON.stringify(evidence));
  return f;
}

describePosix("pre-existing job deadline admission", () => {
  it("retains a deadline-cancelled root as failed evidence through native landing", () => {
    const f = timeoutCandidate();
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.record().priorCiAdmin.failures).toMatchObject([
      { jobId: 601, deadline: { checkRunId: 601, conclusion: "cancelled", seconds: 3600 } },
    ]);
    expect(f.record().priorCiAdmin.cancelledJobIds).toEqual([]);
  });

  it.each([
    "manual cancellation",
    "foreign publisher",
    "stale head",
    "foreign suite",
    "incomplete annotations",
    "short duration",
    "additional failed step",
  ])("refuses %s without dispatch", (fault) => {
    const f = timeoutCandidate();
    const state = f.state();
    const deadline = state.priorCi.deadline;
    if (fault === "manual cancellation") {
      deadline.annotations[0]!.message = "Cancelled by user";
    }
    if (fault === "foreign publisher") {
      deadline.check.app.id = 999;
    }
    if (fault === "stale head") {
      deadline.check.head_sha = f.base;
    }
    if (fault === "foreign suite") {
      deadline.check.check_suite.id = 999;
    }
    if (fault === "incomplete annotations") {
      deadline.annotations.pop();
    }
    if (fault === "short duration") {
      deadline.check.completed_at = "2026-09-20T00:30:00Z";
      state.priorCi.jobs![0]!.completed_at = deadline.check.completed_at;
    }
    if (fault === "additional failed step") {
      state.priorCi.jobs![0]!.steps!.push({
        number: 19,
        name: "Other assertion",
        status: "completed",
        conclusion: "failure",
      });
    }
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("deadline");
    expect(f.state().mutations).toBe(0);
  });
});
