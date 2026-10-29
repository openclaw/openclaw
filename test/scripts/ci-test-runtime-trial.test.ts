import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import {
  evaluateWorkflowCondition,
  evaluateWorkflowExpression,
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

// Captured from the pre-trial manifest with host gzip metadata canonicalized.
const defaults = [
  {
    name: "PR",
    eventName: "pull_request",
    digest: "afa57eb5b01a19bf60a06c34dfd701b6c19c421a33a77d9954356dc1185275c9",
  },
  {
    name: "main push",
    eventName: "push",
    digest: "dd49e904939ee9e8870da26151e7a9f113dcae5230f182032fda3541656596e7",
  },
  {
    name: "main dispatch",
    eventName: "workflow_dispatch",
    scopeEnv: {
      OPENCLAW_CI_VALIDATION_TIER: "main",
      OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
    },
    digest: "ed612ec09b81392f3e689744dc847843b74f3d1ce02f739ffb0743278d167238",
  },
  {
    name: "FRV",
    eventName: "workflow_dispatch",
    digest: "5805ca6b7145fc4a82576bfaa6eb5435b4aa4bd76b8af0276a471456a2ee0933",
  },
] as const;

function manifest(options: Parameters<typeof runCiManifestFixture>[0]) {
  const result = runCiManifestFixture(options);
  expect(result.status, result.output).toBe(0);
  return result.outputs;
}

function manifestDigest(outputs: Record<string, string>) {
  const normalizeGzip = (key: string, value: unknown) => {
    if (key.endsWith("gzip_base64") && typeof value === "string" && value) {
      const bytes = Buffer.from(value, "base64");
      // zlib builds encode a host-specific OS byte; every other byte stays covered.
      bytes[9] = 3;
      return bytes.toString("base64");
    }
    return value;
  };
  const normalized = Object.fromEntries(
    Object.entries(outputs).map(([key, value]) => [
      key,
      value.startsWith("{")
        ? JSON.stringify(JSON.parse(value), normalizeGzip)
        : normalizeGzip(key, value),
    ]),
  );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function nodeRows(outputs: Record<string, string>) {
  return JSON.parse(outputs.checks_node_core_nondist_matrix!).include;
}

describe("dispatch-only runtime trials", () => {
  it.each(defaults)("preserves every default $name manifest byte", (scenario) => {
    vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", "bun-compatible");
    const outputs = manifest({ ...fixture, ...scenario });
    expect(manifestDigest(outputs)).toBe(scenario.digest);
  });

  it.each(["bun-all", "dual-all"])(
    "routes main dispatch and UI through %s in existing slots",
    (policy) => {
      const scopeEnv = {
        OPENCLAW_CI_VALIDATION_TIER: "main",
        OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
      };
      const baseline = manifest({ ...fixture, eventName: "workflow_dispatch", scopeEnv });
      const outputs = manifest({
        ...fixture,
        eventName: "workflow_dispatch",
        scopeEnv: { ...scopeEnv, OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
      });
      const rows = nodeRows(outputs);
      expect(rows).toHaveLength(nodeRows(baseline).length);
      expect(rows[0]).toMatchObject({ test_runtime_policy: policy, requires_bun: true });
      expect(rows[0].timeout_minutes).toBe(undefined);
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
      expect(
        evaluateWorkflowExpression(preflight.env.OPENCLAW_CI_TEST_RUNTIME_POLICY, context),
      ).toBe(policy);
      for (const jobName of ["checks-node-core-test-nondist-shard", "checks-ui"]) {
        const setup = workflow.jobs[jobName].steps.find(
          (step: WorkflowStep) => step.name === "Setup pinned Bun test runtime",
        );
        expect(setup.uses).toBe("./.ci-harness/.github/actions/setup-test-bun");
        expect(evaluateWorkflowCondition(setup.if, context)).toBe(true);
      }
      // Only trial policy and provisioning may change; deadlines remain unchanged.
      rows[0].test_runtime_policy = "node";
      delete rows[0].requires_bun;
      delete rows[0].timeout_minutes;
      expect(rows).toEqual(nodeRows(baseline));
      const {
        checks_node_core_nondist_matrix: _rows,
        ui_test_runtime_policy: _ui,
        ...unchanged
      } = outputs;
      const {
        checks_node_core_nondist_matrix: _baseRows,
        ui_test_runtime_policy: _baseUi,
        ...baseUnchanged
      } = baseline;
      expect(unchanged).toEqual(baseUnchanged);
    },
  );

  it.each(["node", "bun-compatible", "dual", "bun-all", "dual-all"])(
    "preserves UI backend budgets under %s trials",
    (policy) => {
      const timeout = readCiWorkflow().jobs["checks-ui"]["timeout-minutes"];
      for (const runnerBackend of ["blacksmith", "github"] as const) {
        expect(
          evaluateWorkflowExpression(timeout, {
            eventName: "workflow_dispatch",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            ciShape: "main",
            runnerBackend,
            preflightOutputs: { ui_test_runtime_policy: policy, ci_shape: "main" },
          }),
        ).toBe(runnerBackend === "github" ? 35 : 20);
      }
    },
  );

  it("preserves explicit row deadlines and exact provisioning", () => {
    for (const policy of ["bun-all", "dual-all"] as const) {
      const outputs = manifest({
        ...fixture,
        eventName: "workflow_dispatch",
        nodeTestShards: [
          {
            ...fixture.nodeTestShards[0],
            configs: ["node-only.config.ts"],
            targets: ["src/process/spawn-broker/cleanup.test.ts"],
            timeoutMinutes: 90,
          },
          { ...fixture.nodeTestShards[0], timeoutMinutes: 120 },
        ],
        scopeEnv: { OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
      });
      expect(
        nodeRows(outputs).map((row: { timeout_minutes: number }) => row.timeout_minutes),
      ).toEqual([90, 120]);
      expect(nodeRows(outputs).map((row: { requires_bun: boolean }) => row.requires_bun)).toEqual([
        false,
        true,
      ]);
    }
  });

  it("installs Bun for selections that build the runtime first", () => {
    const outputs = manifest({
      ...fixture,
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
      ...fixture,
      eventName: "pull_request",
      scopeEnv: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual-all" },
    });
    expect(manifestDigest(outputs)).toBe(defaults[0].digest);
    expect(readCiWorkflow().on.workflow_dispatch.inputs.test_runtime_policy).toMatchObject({
      default: "",
      type: "string",
    });
  });

  it.each([
    { policy: "all-bun", capability: true, error: "must be empty, bun-all, or dual-all" },
    { policy: "dual-all", capability: false, error: "does not support test_runtime_policy trials" },
  ])(
    "rejects unsupported dispatch rather than silently falling back ($policy, $capability)",
    ({ policy, capability, error }) => {
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
});
