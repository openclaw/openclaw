import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
const workflowJob = "check-shard";
// Audited Run check shard from CI merge 4ffea178a1fc64f81b7a4023337ee39df398a7aa.
const historicalRun = readFileSync(
  new URL("../fixtures/pr-prior-ci-prod-types-step.txt", import.meta.url),
  "utf8",
);
const prelude = [
  "Checkout",
  "Check npm lock scope before setup",
  "Setup Node environment",
  "Restore test-type incremental state",
  ...[1, 2, 3, 4, 5].map((stripe) => `Restore changed core test-type stripe ${stripe}`),
  "Compute extension boundary input fingerprint",
  "Cache extension package boundary artifacts for hosted lint",
  "Mount extension boundary sticky disk",
  "Restore extension boundary artifacts from sticky disk",
  "Run changed lint",
];

function staticRootCandidate(fault = "") {
  const source = {
    name: "Run check shard",
    shell: "bash",
    if:
      fault === "changed step condition"
        ? "always()"
        : "matrix.task != 'lint' || !(needs.preflight.outputs.run_check_plan == 'true' && needs.check-plan.outputs.central_lint_selection_json || needs.preflight.outputs.central_lint_selection_json)",
    env: { TASK: fault === "wrong task binding" ? "lint" : "${{ matrix.task }}" },
    run: historicalRun + (fault === "different command" ? "echo changed\n" : ""),
  };
  const owner = {
    name: "${{ matrix.check_name || 'check-shard' }}",
    needs: ["preflight", "check-plan"],
    "continue-on-error": fault === "ignored job failure",
    strategy: {
      "fail-fast": false,
      matrix:
        "${{ fromJSON((needs.preflight.outputs.run_check_plan == 'true' && needs.check-plan.outputs.check_matrix || needs.preflight.outputs.check_matrix)) }}",
    },
    steps: [
      ...prelude.map((name) => ({ name })),
      source,
      { name: "Save test-type incremental state" },
    ],
  };
  const f = preExistingCandidate(stringify({ jobs: { [workflowJob]: owner } }));
  const state = f.state();
  const check = state.priorCi.deadline.check;
  Object.assign(check, {
    name: "check-prod-types",
    head_sha: f.head,
    completed_at: "2026-09-20T00:02:04Z",
  });
  const step = (number: number, name: string, conclusion: string, start: string, end = start) => ({
    number,
    name,
    status: "completed",
    conclusion,
    started_at: `2026-09-20T00:${start}Z`,
    completed_at: `2026-09-20T00:${end}Z`,
  });
  const job = state.priorCi.jobs![0]!;
  Object.assign(job, {
    name: check.name,
    conclusion: "cancelled",
    check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/601",
    started_at: check.started_at,
    completed_at: check.completed_at,
    steps: [
      step(1, "Set up job", "success", "00:02", "00:03"),
      ...prelude.map((name, index) => step(index + 2, name, "skipped", "01:00")),
      step(16, source.name, "failure", "01:00", "02:02"),
      step(17, "Save test-type incremental state", "skipped", "02:02"),
      step(34, "Post Setup Node environment", "success", "02:02"),
      step(35, "Complete job", "success", "02:02"),
    ],
  });
  const evidence = {
    ...f.evidence,
    failures: f.evidence.failures.map((entry) => ({
      ...entry,
      cases: ["TS2552: missing local binding"],
      failedStep: { number: 16, workflowJob },
    })),
  };
  f.save(state);
  writeFileSync(f.path, JSON.stringify(evidence));
  return { ...f, evidence };
}

describePosix("attributed production type failure in a cancelled job", () => {
  it("retains the failed static step and unrun collateral without dispatching", () => {
    const f = staticRootCandidate();
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.failures).toMatchObject([
      {
        jobId: 601,
        failedStep: { checkRunId: 601, conclusion: "cancelled", number: 16, workflowJob },
      },
    ]);
    expect(proof.failures[0].failedStep.steps).toEqual(f.state().priorCi.jobs![0]!.steps);
    expect(proof.failures[0].deadline).toBeUndefined();
    expect(proof.cancelledJobIds).toEqual([604]);
    expect(f.state().mutations).toBe(0);
  });

  it.each([
    "different job",
    "wrong step number",
    "missing source step",
    "duplicate step number",
    "incomplete step",
    "additional failure",
    "missing cleanup",
    "missing prelude timestamp",
    "reordered steps",
    "overlapping steps",
    "step outside job",
    "foreign publisher",
    "stale check head",
    "missing independent proof",
    "changed source input",
    "omitted collateral",
  ])("refuses %s without dispatching", (fault) => {
    const f = staticRootCandidate();
    const state = f.state();
    const job = state.priorCi.jobs![0]!;
    const steps = job.steps!;
    const check = state.priorCi.deadline.check;
    if (fault === "different job") {
      job.name = check.name = "check-test-types";
    }
    if (fault === "wrong step number") {
      f.evidence.failures[0]!.failedStep.number = 15;
    }
    if (fault === "missing source step") {
      steps.splice(1, 1);
    }
    if (fault === "duplicate step number") {
      steps[1]!.number = 1;
    }
    if (fault === "incomplete step") {
      steps[1]!.status = "in_progress";
    }
    if (fault === "additional failure") {
      steps[1]!.conclusion = "failure";
    }
    if (fault === "missing cleanup") {
      steps.pop();
    }
    if (fault === "missing prelude timestamp") {
      delete steps[1]!.started_at;
    }
    if (fault === "reordered steps") {
      [steps[1], steps[2]] = [steps[2]!, steps[1]!];
    }
    if (fault === "overlapping steps") {
      steps[1]!.started_at = "2026-09-20T00:00:01Z";
    }
    if (fault === "step outside job") {
      steps.at(-1)!.completed_at = "2026-09-20T00:02:05Z";
    }
    if (fault === "foreign publisher") {
      check.app.id = 999;
    }
    if (fault === "stale check head") {
      check.head_sha = f.base;
    }
    if (fault === "missing independent proof") {
      f.evidence.failures[0]!.evidence = [];
    }
    if (fault === "changed source input") {
      f.evidence.failures[0]!.sourcePaths = ["owner.txt"];
    }
    if (fault === "omitted collateral") {
      f.evidence.cancellation.jobIds = [];
    }
    f.save(state);
    writeFileSync(f.path, JSON.stringify(f.evidence));
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("Prior-CI admin admission:");
    expect(f.state().mutations).toBe(0);
  });

  it.each([
    "different command",
    "wrong task binding",
    "ignored job failure",
    "changed step condition",
  ])("refuses %s in the audited workflow", (fault) => {
    const f = staticRootCandidate(fault);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("canonical production-type workflow owner");
    expect(f.state().mutations).toBe(0);
  });
});
