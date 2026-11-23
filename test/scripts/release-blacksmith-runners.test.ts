import { expect, it } from "vitest";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  readWorkflow,
  requiredWorkflowStep,
} from "./ci-workflow.test-support.js";

const lanes = [
  ["openclaw-release-checks", "qa_lab_runtime_pair_lane_release_checks", 2],
  ["openclaw-npm-preflight", "prepare_openclaw_npm", 8],
  ["openclaw-repo-e2e-reusable", "test", 8],
  ["openclaw-live-and-e2e-checks-reusable", "validate_special_e2e", 8],
  ["openclaw-live-and-e2e-checks-reusable", "validate_docker_e2e", 8],
  ["openclaw-performance", "source_performance", 4],
  ["npm-telegram-beta-e2e", "run_package_telegram_e2e", 8],
  ["qa-profile-evidence", "run_qa_profile_shard", 2],
  ["qa-live-transports-convex", "run_mock_parity", 4],
  ["plugin-prerelease", "resolve_target", 2],
  ["plugin-prerelease", "plugin-prerelease-static-shard", 8],
] as const;

it.each(lanes)("pins release %s/%s to its %i-vCPU Blacksmith class", (file, job, cpus) => {
  const workflow = readWorkflow(".github/workflows/" + file + ".yml");
  const label = "blacksmith-" + cpus + "vcpu-ubuntu-2404";
  for (const runnerBackend of ["boat", "github", "blacksmith"] as const) {
    for (const group of ["", "release-fixture"]) {
      const actual = evaluateWorkflowExpression(workflow.jobs[job]["runs-on"], {
        eventName: "workflow_dispatch",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        dispatchId: "full-release-validation-fixture",
        runnerBackend,
        releaseRunnerGroup: group,
        runnerGroup: group,
      });
      expect(actual, runnerBackend + ":" + group).toEqual(group ? { group, labels: label } : label);
    }
  }
});

it("routes a retained FRV workflow using the canonical release context", () => {
  const workflow = readCiWorkflow();
  for (const group of ["", "release-fixture"]) {
    const actual = evaluateWorkflowExpression(workflow.jobs.preflight["runs-on"], {
      eventName: "workflow_dispatch",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      ref: "refs/heads/release-ci/frozen-fixture",
      targetContextRef: "release/2026.11.10",
      dispatchId: "full-release-validation-fixture",
      runnerBackend: "boat",
      releaseRunnerGroup: group,
    });
    const labels = "blacksmith-2vcpu-ubuntu-2404";
    expect(actual).toEqual(group ? { group, labels } : labels);
  }
});

it("pins CI controls while retaining hosted fork isolation", () => {
  const workflow = readCiWorkflow();
  const step = requiredWorkflowStep(
    workflow.jobs.preflight.steps,
    "Resolve logical runner profile",
  );
  expect(
    evaluateWorkflowExpression(step.env?.CONFIGURED_RUNNER_PROFILE, {
      eventName: "workflow_dispatch",
      repository: "openclaw/openclaw",
      runAttempt: 1,
      ref: "refs/heads/release/2026.11.10",
      runnerBackend: "boat",
    }),
  ).toBe("blacksmith");
  for (const job of ["preflight"]) {
    for (const runnerBackend of ["boat", "github", "blacksmith"] as const) {
      for (const headRepository of ["openclaw/openclaw", "contributor/openclaw"]) {
        expect(
          evaluateWorkflowExpression(workflow.jobs[job]["runs-on"], {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            headRepository,
            ref:
              headRepository === "openclaw/openclaw"
                ? "refs/heads/release/2026.11.10"
                : "refs/pull/1/merge",
            runnerBackend,
            runAttempt: 1,
          }),
        ).toBe(
          headRepository === "openclaw/openclaw" ? "blacksmith-2vcpu-ubuntu-2404" : "ubuntu-24.04",
        );
      }
    }
  }
});
