import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
const workflowJob = "checks-ui-e2e-real-gateway";
// Actual test entrypoint at CI merge c8ab5a2b5e1cfa3870810d90f8c4bca8ba353944.
const historicalRun = readFileSync(
  new URL("../fixtures/pr-prior-ci-ui-real-gateway-step.txt", import.meta.url),
  "utf8",
);
const buildName = "Build runtime and Control UI artifacts for real-Gateway tests";
const stepName = "Test Control UI suites with a real Gateway";
const prelude = [
  "Checkout",
  "Setup Node environment",
  "Cache Playwright Chromium",
  "Install Playwright Chromium",
];
const uploads = [
  "Upload Control UI real-Gateway failure diagnostics",
  "Upload quota auth and transport diagnostics",
  "Upload sanitized desktop resize proof",
  "Upload model picker public observations",
  "Upload sanitized Control UI real-Gateway proof",
];

function uiRootCandidate(runnerPrelude: boolean, fault = "") {
  const source = {
    name: stepName,
    if: fault === "changed test condition" ? "always()" : "matrix.run_tests",
    env: {
      FROZEN_TARGET: "${{ needs.preflight.outputs.frozen_target }}",
      OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64:
        fault === "unbound test selection" ? "" : "${{ matrix.test_groups_gzip_base64 }}",
    },
    "continue-on-error": fault === "ignored test failure",
    run: historicalRun + (fault === "different command" ? "echo changed\n" : ""),
  };
  const owner = {
    name: "${{ matrix.shard_count == 1 && 'checks-ui-e2e-real-gateway' || format('checks-ui-e2e-real-gateway ({0}/{1})', matrix.shard, matrix.shard_count) }}",
    needs: ["preflight"],
    "continue-on-error": false,
    strategy: {
      "fail-fast": false,
      "max-parallel": 2,
      matrix:
        fault === "unbound matrix"
          ? "${{ fromJson(needs.preflight.outputs.another_matrix) }}"
          : "${{ fromJson(needs.preflight.outputs.ui_real_gateway_matrix) }}",
    },
    steps: [
      ...prelude.map((name) => ({ name })),
      {
        name: buildName,
        run: "pnpm build",
        env: { OPENCLAW_BUILD_PRIVATE_QA: fault === "wrong build mode" ? "0" : "1" },
      },
      { name: "Prove desktop resize over node and SSH" },
      source,
      ...uploads.map((name) => ({ name })),
    ],
  };
  const f = preExistingCandidate(stringify({ jobs: { [workflowJob]: owner } }));
  const state = f.state();
  const check = state.priorCi.deadline.check;
  Object.assign(check, {
    name: runnerPrelude ? "checks-ui-e2e-real-gateway (1/2)" : "checks-ui-e2e-real-gateway",
    head_sha: f.head,
    completed_at: "2026-09-20T00:02:04Z",
  });
  const step = (number: number, name: string, conclusion = "success") => ({
    number,
    name,
    status: "completed",
    conclusion,
    started_at: "2026-09-20T00:01:00Z",
    completed_at: "2026-09-20T00:01:00Z",
  });
  const offset = runnerPrelude ? 3 : 2;
  const job = state.priorCi.jobs![0]!;
  Object.assign(job, {
    name: check.name,
    conclusion: "cancelled",
    check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/601",
    started_at: check.started_at,
    completed_at: check.completed_at,
    steps: [
      step(1, "Set up job"),
      ...(runnerPrelude ? [step(2, "Set up runner")] : []),
      ...owner.steps.map((value, index) =>
        step(index + offset, value.name, value === source ? "failure" : "success"),
      ),
      step(27, "Post Setup Node environment"),
      ...(runnerPrelude ? [step(28, "Complete runner")] : []),
      step(29, "Complete job"),
    ],
  });
  const evidence = {
    ...f.evidence,
    failures: f.evidence.failures.map((entry) => ({
      ...entry,
      cases: ["Prebuilt UI E2E: source state is dirty or unavailable"],
      failedStep: { number: 6 + offset, workflowJob },
    })),
  };
  f.save(state);
  writeFileSync(f.path, JSON.stringify(evidence));
  return { ...f, evidence };
}

describePosix("attributed real-Gateway UI failure in a cancelled job", () => {
  it.each([false, true])("retains the failed root with runner prelude %s", (runnerPrelude) => {
    const f = uiRootCandidate(runnerPrelude);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.failures[0]).toMatchObject({
      jobId: 601,
      failedStep: {
        checkRunId: 601,
        conclusion: "cancelled",
        workflowJob,
        number: runnerPrelude ? 9 : 8,
        step: { name: stepName, conclusion: "failure" },
      },
    });
    expect(proof.failures[0].failedStep.steps).toEqual(f.state().priorCi.jobs![0]!.steps);
    expect(proof.failures[0].deadline).toBeUndefined();
    expect(proof.cancelledJobIds).toEqual([604]);
    expect(f.state().mutations).toBe(0);
  });

  it.each([
    "different command",
    "changed test condition",
    "unbound test selection",
    "unbound matrix",
    "wrong build mode",
    "ignored test failure",
  ])("refuses %s in the source owner", (fault) => {
    const f = uiRootCandidate(true, fault);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("canonical real-Gateway UI workflow owner");
    expect(f.state().mutations).toBe(0);
  });

  it.each([
    "different job",
    "wrong step number",
    "unknown runner prelude",
    "extra cleanup step",
    "skipped runner cleanup",
    "skipped setup cleanup",
    "missing source step",
    "missing timestamp",
    "overlapping steps",
    "additional failed step",
    "stale check head",
    "missing independent proof",
    "omitted collateral",
  ])("refuses %s without dispatch", (fault) => {
    const f = uiRootCandidate(true);
    const state = f.state();
    const job = state.priorCi.jobs![0]!;
    const steps = job.steps!;
    if (fault === "different job") {
      job.name = state.priorCi.deadline.check.name = "checks-ui";
    }
    if (fault === "wrong step number") {
      f.evidence.failures[0]!.failedStep.number = 8;
    }
    if (fault === "unknown runner prelude") {
      steps[1]!.name = "Unbound runner command";
    }
    if (fault === "extra cleanup step") {
      steps.splice(-3, 0, { ...steps.at(-3)!, name: "Unbound cleanup", number: 20 });
    }
    if (fault === "skipped runner cleanup") {
      steps.at(-2)!.conclusion = "skipped";
    }
    if (fault === "skipped setup cleanup") {
      steps.at(-3)!.conclusion = "skipped";
    }
    if (fault === "missing source step") {
      steps.splice(2, 1);
    }
    if (fault === "missing timestamp") {
      delete steps[1]!.started_at;
    }
    if (fault === "overlapping steps") {
      steps[2]!.started_at = "2026-09-20T00:00:59Z";
    }
    if (fault === "additional failed step") {
      steps[1]!.conclusion = "failure";
    }
    if (fault === "stale check head") {
      state.priorCi.deadline.check.head_sha = f.base;
    }
    if (fault === "missing independent proof") {
      f.evidence.failures[0]!.evidence = [];
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
});
