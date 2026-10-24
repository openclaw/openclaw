import { afterEach, expect, it, vi } from "vitest";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import {
  evaluateWorkflowCondition,
  evaluateWorkflow,
  readCiWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

afterEach(() => vi.unstubAllEnvs());

const fixture = {
  bundledPlanner: true,
  bunTestRuntime: true,
  bunUiTestRuntime: true,
  historicalCompatibility: false,
  changedPaths: ["scripts/lib/ci-node-test-plan.mts"],
  nodeTestShards: [
    {
      checkName: "runtime-proof",
      shardName: "runtime-proof",
      configs: ["fixture-bun.config.ts"],
      requiresDist: false,
      runner: "ubuntu-24.04",
    },
  ],
} satisfies Parameters<typeof runCiManifestFixture>[0];

const mainScope = {
  OPENCLAW_CI_VALIDATION_TIER: "main",
  OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
};
const defaults = [
  ["PR", "pull_request", "bun-all"],
  ["main push", "push", "bun-all"],
  ["main dispatch", "workflow_dispatch", "bun-all"],
  ["FRV", "workflow_dispatch", "dual-all"],
] as const;

function manifest(options: Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">) {
  const result = runCiManifestFixture({ ...fixture, ...options });
  expect(result.status, result.output).toBe(0);
  return result.outputs;
}

function nodeRows(outputs: Record<string, string>) {
  return JSON.parse(outputs.checks_node_core_nondist_matrix!).include;
}
function stableOutputs(outputs: Record<string, string>) {
  const { checks_node_core_nondist_matrix: _rows, ui_test_runtime_policy: _ui, ...rest } = outputs;
  return rest;
}

it.each(defaults)(
  "selects the %s default runtime and sequential budget",
  (name, eventName, policy) => {
    vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", "node");
    const outputs = manifest({
      eventName,
      ...(name === "main dispatch" ? { scopeEnv: mainScope } : {}),
    });
    const rows = nodeRows(outputs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ test_runtime_policy: policy, requires_bun: true });
    expect(rows[0].timeout_minutes).toBe(policy === "dual-all" ? 120 : undefined);
    expect(outputs.ui_test_runtime_policy).toBe(policy);
  },
);

it.each(["node", "bun-all", "dual-all"])(
  "routes explicit main dispatch and UI through %s in existing slots",
  (policy) => {
    const baseline = manifest({ eventName: "workflow_dispatch", scopeEnv: mainScope });
    const outputs = manifest({
      eventName: "workflow_dispatch",
      scopeEnv: { ...mainScope, OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
    });
    const rows = nodeRows(outputs);
    expect(rows).toHaveLength(nodeRows(baseline).length);
    expect(rows[0].test_runtime_policy).toBe(policy);
    expect(Boolean(rows[0].requires_bun)).toBe(policy !== "node");
    expect(rows[0].timeout_minutes).toBe(policy === "dual-all" ? 120 : undefined);
    expect(outputs.ui_test_runtime_policy).toBe(policy);
    const workflow = readCiWorkflow();
    const context = {
      eventName: "workflow_dispatch" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      testRuntimePolicy: policy,
      preflightOutputs: outputs,
      matrix: rows[0],
      steps: { node_setup: { outputs: {}, outcome: "success" as const } },
    };
    const preflight = workflow.jobs.preflight.steps.find(
      (step: WorkflowStep) => step.name === "Build CI manifest",
    );
    expect(evaluateWorkflow(preflight.env.OPENCLAW_CI_TEST_RUNTIME_POLICY, context)).toBe(policy);
    for (const jobName of ["checks-node-core-test-nondist-shard", "checks-ui"]) {
      const setup = workflow.jobs[jobName].steps.find(
        (step: WorkflowStep) => step.name === "Setup pinned Bun test runtime",
      );
      expect(setup.uses).toBe("./.ci-harness/.github/actions/setup-test-bun");
      expect(evaluateWorkflowCondition(setup.if, context)).toBe(policy !== "node");
    }
    // Runtime selection never adds a matrix row or a runner registration.
    rows[0].test_runtime_policy = "bun-all";
    rows[0].requires_bun = true;
    delete rows[0].timeout_minutes;
    expect(rows).toEqual(nodeRows(baseline));
    expect(stableOutputs(outputs)).toEqual(stableOutputs(baseline));
  },
);

it("doubles explicit row deadlines only for dual-all", () => {
  for (const policy of ["bun-all", "dual-all"] as const) {
    const outputs = manifest({
      eventName: "workflow_dispatch",
      nodeTestShards: [
        { ...fixture.nodeTestShards[0], timeoutMinutes: 90 },
        { ...fixture.nodeTestShards[0], timeoutMinutes: 120 },
      ],
      scopeEnv: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
    });
    expect(
      nodeRows(outputs).map((row: { timeout_minutes: number }) => row.timeout_minutes),
    ).toEqual(policy === "dual-all" ? [180, 240] : [90, 120]);
    expect(nodeRows(outputs).every((row: { requires_bun: boolean }) => row.requires_bun)).toBe(
      true,
    );
  }
});

it("installs Bun for selections that build the runtime first", () => {
  const outputs = manifest({
    eventName: "workflow_dispatch",
    nodeTestShards: [{ ...fixture.nodeTestShards[0], pretestBuildMode: "runtime" }],
    scopeEnv: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual-all" },
  });
  expect(nodeRows(outputs)[0]).toMatchObject({
    requires_bun: true,
    pretest_build_mode: "runtime",
  });
});

it("ignores trial environment on automatic events and leaves the dispatch default empty", () => {
  const outputs = manifest({
    eventName: "pull_request",
    scopeEnv: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual-all" },
  });
  expect(nodeRows(outputs)[0].test_runtime_policy).toBe("bun-all");
  expect(outputs.ui_test_runtime_policy).toBe("bun-all");
  expect(readCiWorkflow().on.workflow_dispatch.inputs.test_runtime_policy).toMatchObject({
    default: "",
    type: "string",
  });
});

it.each([
  ["all-bun", true, "must be empty, node, bun-all, or dual-all"],
  ["dual-all", false, "does not support test_runtime_policy selection"],
] as const)(
  "rejects unsupported dispatch rather than falling back (%s, %s)",
  (policy, capability, error) => {
    const result = runCiManifestFixture({
      ...fixture,
      eventName: "workflow_dispatch",
      bunTestRuntime: capability,
      scopeEnv: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(error);
  },
);
