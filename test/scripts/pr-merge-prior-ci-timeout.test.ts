import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { expectExit, applyFault, completedStep } from "./pr-merge-assertions.test-support.js";
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
    steps: [completedStep(18, "Run Node test shard", "cancelled")],
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
      completedStep(1, "Set up job", "success", check.started_at, "2026-09-20T00:00:05Z"),
      completedStep(
        10,
        "Run additional check shard",
        cancelled ? "cancelled" : "success",
        "2026-09-20T00:01:00Z",
        "2026-09-20T00:20:25Z",
      ),
      completedStep(27, "Complete job", "success", "2026-09-20T00:20:29Z", check.completed_at),
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
      const result = expectExit(boundary ? f.verifyPriorCi(f.path) : f.adminPriorCi(f.path), 0);
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
    applyFault(fault, {
      "wrong job name": () => {
        job.name = "unrelated-check";
        deadline.check.name = "unrelated-check";
      },
      "wrong step ordinal": () => (steps[1]!.number = 11),
      "duplicate step number": () => (steps[2]!.number = 10),
      "another failed step": () => (steps[0]!.conclusion = "failure"),
      "another cancelled step": () => (steps[0]!.conclusion = "cancelled"),
      "missing cleanup": () => steps.pop(),
      "missing step timestamp": () => (steps[1]!.started_at = undefined),
      "reversed step times": () => (steps[1]!.started_at = "2026-09-20T00:20:26Z"),
      "step outside job": () => (steps[2]!.completed_at = "2026-09-20T00:20:31Z"),
      "shard ends before deadline": () => (steps[1]!.completed_at = "2026-09-20T00:19:59Z"),
    });
    if (fault === "extra annotation") {
      deadline.annotations.push({ ...deadline.annotations[0]! });
      deadline.check.output.annotations_count = 2;
    }
    if (fault === "wrong annotation duration") {
      deadline.annotations[0]!.message = "The job has exceeded the maximum execution time of 19m0s";
    }
    const evidence = JSON.parse(readFileSync(f.path, "utf8"));
    applyFault(fault, {
      "missing independent qualification": () => (evidence.failures[0].evidence = []),
      "aggregate omits root": () => (evidence.aggregate.causedBy = []),
    });
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
    applyFault(fault, {
      "manual cancellation": () => (deadline.annotations[0]!.message = "Cancelled by user"),
      "foreign publisher": () => (deadline.check.app.id = 999),
      "stale head": () => (deadline.check.head_sha = f.base),
      "foreign suite": () => (deadline.check.check_suite.id = 999),
      "incomplete annotations": () => deadline.annotations.pop(),
    });
    if (fault === "short duration") {
      deadline.check.completed_at = "2026-09-20T00:30:00Z";
      state.priorCi.jobs![0]!.completed_at = deadline.check.completed_at;
    }
    if (fault === "additional failed step") {
      state.priorCi.jobs![0]!.steps!.push(completedStep(19, "Other assertion", "failure"));
    }
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("deadline");
    expect(f.state().mutations).toBe(0);
  });
});
