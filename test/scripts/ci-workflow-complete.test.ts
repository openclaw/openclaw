import { describe, expect, it } from "vitest";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const workflow = readCiWorkflow();
const step = (job: string, name: string): WorkflowStep => {
  const found = workflow.jobs[job].steps.find((entry: WorkflowStep) => entry.name === name);
  expect(found, `${job}: ${name}`).toBeDefined();
  return found;
};
const context = {
  eventName: "pull_request" as const,
  repository: "openclaw/openclaw",
  runAttempt: 2,
  failed: true,
};

describe("complete CI failure reporting", () => {
  it("keeps mobile correctness out of preflight and in the required security job", () => {
    expect(
      workflow.jobs.preflight.steps.some(
        (entry: WorkflowStep) => entry.name === "Check mobile protocol event coverage",
      ),
    ).toBe(false);
    const coverage = step("security-fast", "Check mobile protocol event coverage");
    const admitted = {
      ...context,
      preflightOutputs: { run_protocol_event_coverage: "true" },
      steps: { node_setup: { outputs: {}, outcome: "success" as const } },
    };
    expect(evaluateWorkflowExpression(coverage.if, admitted)).toBe(true);
    expect(evaluateWorkflowExpression(coverage.if, { ...admitted, cancelled: true })).toBe(false);
    expect(workflow.jobs["ci-gate"].needs).toContain("security-fast");
  });

  it.each([
    "check-shard",
    "check-lint-hosted-core-shard",
    "check-lint-hosted-extension-shard",
    "check-test-types-hosted-core-shard",
  ])("admits %s after guards fail only when the real producer outputs exist", (job) => {
    const admitted = {
      ...context,
      runnerProfile: "hybrid" as const,
      preflightOutputs: {
        run_check: "true",
        run_check_plan: "true",
        shared_sdk_declarations: "true",
      },
      additionalNeeds: {
        "check-plan": {
          result: "failure" as const,
          outputs: {
            check_matrix: '{"include":[]}',
            run_lint_core: "true",
            run_lint_extensions: "true",
          },
        },
        "check-extension-package-boundary": {
          result: "failure" as const,
          outputs: { artifact_id: "123" },
        },
      },
    };
    expect(evaluateWorkflowExpression(workflow.jobs[job].if, admitted)).toBe(true);
    expect(
      evaluateWorkflowExpression(workflow.jobs[job].if, {
        ...admitted,
        additionalNeeds: {
          ...admitted.additionalNeeds,
          "check-plan": { result: "failure", outputs: {} },
        },
      }),
    ).toBe(false);
    expect(
      evaluateWorkflowExpression(workflow.jobs[job].if, { ...admitted, cancelled: true }),
    ).toBe(false);
  });

  it.each([
    "Check bundled plugin generated assets",
    "Smoke test CLI launcher help",
    "Smoke test CLI launcher status json",
    "Smoke test built CLI with Bun",
    "Verify built browser native host",
    "Run built artifact checks",
  ])("runs %s after another built check fails but requires dist", (name) => {
    const check = step("build-artifacts", name);
    const admitted = {
      ...context,
      preflightOutputs: { run_browser_native_host: "true" },
      steps: {
        dist_build: { outputs: {}, outcome: "success" as const },
        dist_build_cache: { outputs: {} },
      },
    };
    expect(evaluateWorkflowExpression(check.if, admitted)).toBe(true);
    expect(
      evaluateWorkflowExpression(check.if, {
        ...admitted,
        steps: { ...admitted.steps, dist_build: { outputs: {}, outcome: "failure" } },
      }),
    ).toBe(false);
    expect(evaluateWorkflowExpression(check.if, { ...admitted, cancelled: true })).toBe(false);
  });

  it("publishes a prepared SDK and consumes an uploaded candidate despite unrelated producer failures", () => {
    const publish = step("check-extension-package-boundary", "Publish this run's prepared SDK");
    expect(
      evaluateWorkflowExpression(publish.if, {
        ...context,
        steps: { prepare_sdk: { outputs: {}, outcome: "success" } },
      }),
    ).toBe(true);
    const candidate = {
      ...context,
      sha: "candidate",
      preflightOutputs: { run_published_driver_update: "true", checkout_revision: "candidate" },
      additionalNeeds: {
        "build-artifacts": {
          result: "failure" as const,
          outputs: { published_driver_artifact_id: "123" },
        },
      },
    };
    expect(evaluateWorkflowExpression(workflow.jobs["published-driver-update"].if, candidate)).toBe(
      true,
    );
    expect(
      evaluateWorkflowExpression(workflow.jobs["published-driver-update"].if, {
        ...candidate,
        additionalNeeds: { "build-artifacts": { result: "failure", outputs: {} } },
      }),
    ).toBe(false);
  });

  it("keeps Docker seed lanes complete and static evidence independent of attempt", () => {
    expect(step("docker-seed-e2e", "Run Docker seed tier").env?.OPENCLAW_DOCKER_ALL_FAIL_FAST).toBe(
      "0",
    );
    for (const [job, name] of [
      ["check-shard", "Run check shard"],
      ["check-lint-hosted-core-shard", "Run hosted core lint stripe"],
      ["check-lint-hosted-extension-shard", "Run hosted extension lint stripe"],
      ["check-test-types-hosted-core-shard", "Run hosted core test-types stripe"],
    ]) {
      expect(step(job!, name!).env?.OPENCLAW_CI_STATIC_EVIDENCE).toBe("1");
    }
  });
});
