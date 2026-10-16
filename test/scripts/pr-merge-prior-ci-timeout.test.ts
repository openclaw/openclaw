import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { stringify } from "yaml";
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

function boundaryTimeoutCandidate(cancelled: boolean, sourceFault?: string) {
  const owner = JSON.parse(
    readFileSync(
      new URL("../fixtures/ci/prior-boundary-deadline-owner.json", import.meta.url),
      "utf8",
    ),
  );
  // The failed attempts used the historical 20-minute whole-job budget.
  owner["timeout-minutes"] = sourceFault === "different workflow budget" ? 30 : 20;
  if (sourceFault === "different workflow command") {
    owner.steps.find((step: { name: string }) => step.name === "Run additional check shard").run +=
      "echo changed\n";
  }
  const f = preExistingCandidate(stringify({ jobs: { "check-additional-shard": owner } }));
  const state = f.state();
  const check = state.priorCi.deadline.check;
  Object.assign(check, {
    name: "check-additional-extension-package-boundary",
    head_sha: f.head,
    completed_at: "2026-09-20T00:20:30Z",
    output: { annotations_count: cancelled ? 2 : 1 },
  });
  state.priorCi.deadline.annotations[0]!.message =
    "The job has exceeded the maximum execution time of 20m0s";
  if (!cancelled) {
    state.priorCi.deadline.annotations.pop();
  }
  Object.assign(state.priorCi.jobs![0]!, {
    name: check.name,
    conclusion: "cancelled",
    check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/601",
    started_at: check.started_at,
    completed_at: check.completed_at,
    steps: [
      {
        number: 1,
        name: "Set up job",
        status: "completed",
        conclusion: "success",
        started_at: check.started_at,
        completed_at: "2026-09-20T00:00:05Z",
      },
      {
        number: 10,
        name: "Run additional check shard",
        status: "completed",
        conclusion: cancelled ? "cancelled" : "success",
        started_at: "2026-09-20T00:01:00Z",
        completed_at: "2026-09-20T00:20:25Z",
      },
      {
        number: 27,
        name: "Complete job",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-20T00:20:29Z",
        completed_at: check.completed_at,
      },
    ],
  });
  state.priorCi.jobs = state.priorCi.jobs!.filter((job) => job.id !== 604);
  f.save(state);
  const { cancellation: _cancellation, ...evidence } = f.evidence;
  writeFileSync(f.path, JSON.stringify(evidence));
  return f;
}

describePosix("pre-existing job deadline admission", () => {
  it.each(["boundary success", "boundary cancelled", "Node cancelled"])(
    "retains the qualified %s deadline as failed evidence",
    (kind) => {
      const boundary = kind !== "Node cancelled";
      const cancelled = kind === "boundary cancelled";
      const f = boundary ? boundaryTimeoutCandidate(cancelled) : timeoutCandidate();
      const result = boundary ? f.verifyPriorCi(f.path) : f.adminPriorCi(f.path);
      expect(result.status, result.output).toBe(0);
      const proof = boundary ? JSON.parse(result.stdout) : f.record().priorCiAdmin;
      expect(proof.failures).toMatchObject([
        {
          jobId: 601,
          deadline: {
            conclusion: "cancelled",
            seconds: boundary ? 1200 : 3600,
            ...(boundary
              ? {
                  workflowJob: "check-additional-shard",
                  step: { number: 10, conclusion: cancelled ? "cancelled" : "success" },
                }
              : { checkRunId: 601 }),
          },
        },
      ]);
      expect(proof.cancelledJobIds).toEqual([]);
      expect(f.state().mutations).toBe(boundary ? 0 : 1);
    },
  );

  it.each([
    "success with cancellation annotation",
    "cancelled without cancellation annotation",
    "different workflow budget",
    "different workflow command",
    "wrong job name",
    "wrong step ordinal",
    "duplicate step number",
    "another failed step",
    "another cancelled step",
    "missing cleanup",
    "missing step timestamp",
    "reversed step times",
    "step outside job",
    "shard ends before deadline",
    "extra annotation",
    "wrong annotation duration",
    "missing independent qualification",
    "aggregate omits root",
  ])("refuses boundary %s without dispatch", (fault) => {
    const cancelled = fault === "cancelled without cancellation annotation";
    const f = boundaryTimeoutCandidate(cancelled, fault);
    const state = f.state();
    const deadline = state.priorCi.deadline;
    const job = state.priorCi.jobs![0]!;
    const steps = job.steps!;
    if (fault === "success with cancellation annotation") {
      deadline.annotations.push({
        ...deadline.annotations[0]!,
        message: "The operation was canceled.",
      });
      deadline.check.output.annotations_count = 2;
    }
    if (fault === "cancelled without cancellation annotation") {
      deadline.annotations.pop();
      deadline.check.output.annotations_count = 1;
    }
    if (fault === "wrong job name") {
      job.name = deadline.check.name = "unrelated-check";
    }
    if (fault === "wrong step ordinal") {
      steps[1]!.number = 11;
    }
    if (fault === "duplicate step number") {
      steps[2]!.number = 10;
    }
    if (fault === "another failed step") {
      steps[0]!.conclusion = "failure";
    }
    if (fault === "another cancelled step") {
      steps[0]!.conclusion = "cancelled";
    }
    if (fault === "missing cleanup") {
      steps.pop();
    }
    if (fault === "missing step timestamp") {
      steps[1]!.started_at = undefined;
    }
    if (fault === "reversed step times") {
      steps[1]!.started_at = "2026-09-20T00:20:26Z";
    }
    if (fault === "step outside job") {
      steps[2]!.completed_at = "2026-09-20T00:20:31Z";
    }
    if (fault === "shard ends before deadline") {
      steps[1]!.completed_at = "2026-09-20T00:19:59Z";
    }
    if (fault === "extra annotation") {
      deadline.annotations.push({ ...deadline.annotations[0]! });
      deadline.check.output.annotations_count = 2;
    }
    if (fault === "wrong annotation duration") {
      deadline.annotations[0]!.message = "The job has exceeded the maximum execution time of 19m0s";
    }
    const evidence = JSON.parse(readFileSync(f.path, "utf8"));
    if (fault === "missing independent qualification") {
      evidence.failures[0].evidence = [];
    }
    if (fault === "aggregate omits root") {
      evidence.aggregate.causedBy = [];
    }
    writeFileSync(f.path, JSON.stringify(evidence));
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/Prior-CI admin admission:/u);
    expect(f.state().mutations).toBe(0);
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
