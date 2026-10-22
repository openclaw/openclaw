import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { stringify } from "yaml";
import {
  applyFault,
  completedStep,
  expectPriorCiRefusal,
} from "./pr-merge-assertions.test-support.js";
import { cancelledFailure, verifyFailure } from "./pr-merge-cancelled.test-support.js";
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

const ownerFaults = [
  "different command",
  "wrong task binding",
  "ignored job failure",
  "changed step condition",
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
  const step = (number: number, name: string, conclusion: string, start: string, end = start) =>
    completedStep(number, name, conclusion, `2026-09-20T00:${start}Z`, `2026-09-20T00:${end}Z`);
  return cancelledFailure(
    f,
    "check-prod-types",
    [
      step(1, "Set up job", "success", "00:02", "00:03"),
      ...prelude.map((name, index) => step(index + 2, name, "skipped", "01:00")),
      step(16, source.name, "failure", "01:00", "02:02"),
      step(17, "Save test-type incremental state", "skipped", "02:02"),
      step(34, "Post Setup Node environment", "success", "02:02"),
      step(35, "Complete job", "success", "02:02"),
    ],
    workflowJob,
    16,
    "TS2552: missing local binding",
  );
}

describePosix("attributed production type failure in a cancelled job", () => {
  it("retains failed step and unrun collateral", () => {
    verifyFailure(staticRootCandidate(), { number: 16, workflowJob }, true);
  });

  it.each([
    ...ownerFaults,
    "different job",
    "missing source step",
    "missing prelude timestamp",
    "reordered steps",
    "overlapping steps",
    "step outside job",
    "omitted collateral",
  ])("refuses %s without dispatching", (fault) => {
    const f = staticRootCandidate(fault);
    const state = f.state();
    const job = state.priorCi.jobs![0]!;
    const steps = job.steps!;
    applyFault(fault, {
      "different job": () => {
        job.name = state.priorCi.deadline.check.name = "check-test-types";
      },
      "missing source step": () => steps.splice(1, 1),
      "missing prelude timestamp": () => {
        delete steps[1]!.started_at;
      },
      "reordered steps": () => {
        [steps[1], steps[2]] = [steps[2]!, steps[1]!];
      },
      "overlapping steps": () => Object.assign(steps[1]!, { started_at: "2026-09-20T00:00:01Z" }),
      "step outside job": () =>
        Object.assign(steps.at(-1)!, { completed_at: "2026-09-20T00:02:05Z" }),
      "omitted collateral": () => {
        f.evidence.cancellation.jobIds = [];
      },
    });
    f.save(state);
    writeFileSync(f.path, JSON.stringify(f.evidence));
    expectPriorCiRefusal(
      f,
      ownerFaults.includes(fault)
        ? "canonical production-type workflow owner"
        : "Prior-CI admin admission:",
    );
  });
});
