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

const ownerFaults = [
  "different command",
  "changed test condition",
  "unbound test selection",
  "unbound matrix",
  "wrong build mode",
  "ignored test failure",
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
  const step = (number: number, name: string, conclusion = "success") =>
    completedStep(number, name, conclusion, "2026-09-20T00:01:00Z", "2026-09-20T00:01:00Z");
  const offset = runnerPrelude ? 3 : 2;
  return cancelledFailure(
    f,
    runnerPrelude ? "checks-ui-e2e-real-gateway (1/2)" : "checks-ui-e2e-real-gateway",
    [
      step(1, "Set up job"),
      ...(runnerPrelude ? [step(2, "Set up runner")] : []),
      ...owner.steps.map((value, index) =>
        step(index + offset, value.name, value === source ? "failure" : "success"),
      ),
      step(27, "Post Setup Node environment"),
      ...(runnerPrelude ? [step(28, "Complete runner")] : []),
      step(29, "Complete job"),
    ],
    workflowJob,
    6 + offset,
    "Prebuilt UI E2E: source state is dirty or unavailable",
  );
}

describePosix("attributed real-Gateway UI failure in a cancelled job", () => {
  it.each([false, true])("retains failed root (runner prelude=%s)", (runnerPrelude) => {
    verifyFailure(uiRootCandidate(runnerPrelude), {
      workflowJob,
      number: runnerPrelude ? 9 : 8,
      step: { name: stepName, conclusion: "failure" },
    });
  });

  it.each([
    ...ownerFaults,
    "different job",
    "unknown runner prelude",
    "extra cleanup step",
    "skipped runner cleanup",
    "skipped setup cleanup",
  ])("refuses %s without dispatch", (fault) => {
    const f = uiRootCandidate(true, fault);
    const state = f.state();
    const job = state.priorCi.jobs![0]!;
    const steps = job.steps!;
    applyFault(fault, {
      "different job": () => {
        job.name = state.priorCi.deadline.check.name = "checks-ui";
      },
      "unknown runner prelude": () => Object.assign(steps[1]!, { name: "Unbound runner command" }),
      "extra cleanup step": () =>
        steps.splice(-3, 0, { ...steps.at(-3)!, name: "Unbound cleanup", number: 20 }),
      "skipped runner cleanup": () => Object.assign(steps.at(-2)!, { conclusion: "skipped" }),
      "skipped setup cleanup": () => Object.assign(steps.at(-3)!, { conclusion: "skipped" }),
    });
    f.save(state);
    writeFileSync(f.path, JSON.stringify(f.evidence));
    expectPriorCiRefusal(
      f,
      ownerFaults.includes(fault)
        ? "canonical real-Gateway UI workflow owner"
        : "Prior-CI admin admission:",
    );
  });
});
