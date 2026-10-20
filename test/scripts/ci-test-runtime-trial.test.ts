import { createHash } from "node:crypto";
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

// Captured before the default cutover, with host gzip metadata canonicalized.
const mainScope = {
  OPENCLAW_CI_VALIDATION_TIER: "main",
  OPENCLAW_CI_WORKFLOW_REVISION: "a".repeat(40),
};
const digests = {
  PR: "66eb4fe868dcfe446d359e9b5a0249a76467ca1198f435c5f160420289871862",
  "main push": "f05634e6cd8e14f3dc45a53122605175c95b5276541a3da7e25a635683363df8",
  "main dispatch": "854476e7a631b59fb62e33bd45005b7de782a583b8a003d6c4b6599ea52c38a1",
  FRV: "86598cc288a105d40ad4bdf2a4cc6b2d0635d75183e18a209f4bc9c062922849",
};
const defaults = [
  ["PR", "pull_request", "bun-compatible"],
  ["main push", "push", "node"],
  ["main dispatch", "workflow_dispatch", "node"],
  ["FRV", "workflow_dispatch", "dual"],
] as const;

function manifest(options: Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">) {
  const result = runCiManifestFixture({ ...fixture, ...options });
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
function stableOutputs(outputs: Record<string, string>) {
  const { checks_node_core_nondist_matrix: _rows, ui_test_runtime_policy: _ui, ...rest } = outputs;
  return rest;
}

it.each(defaults)(
  "changes only the %s runtime and sequential budget",
  (name, eventName, previousPolicy) => {
    const policy = name === "FRV" ? "dual-all" : "bun-all";
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
    // Project only the changed policy fields back to the captured baseline.
    rows[0].test_runtime_policy = previousPolicy;
    if (previousPolicy === "node") {
      delete rows[0].requires_bun;
    }
    delete rows[0].timeout_minutes;
    expect(
      manifestDigest({
        ...outputs,
        checks_node_core_nondist_matrix: JSON.stringify({ include: rows }),
        ui_test_runtime_policy: previousPolicy,
      }),
    ).toBe(digests[name]);
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

it.each(["node", "bun-all", "dual-all"])(
  "preserves UI backend budgets and doubles only dual-all (%s)",
  (policy) => {
    const timeout = readCiWorkflow().jobs["checks-ui"]["timeout-minutes"];
    for (const runnerBackend of ["blacksmith", "github"] as const) {
      expect(
        evaluateWorkflow(timeout, {
          eventName: "workflow_dispatch",
          ciShape: "main",
          runnerBackend,
          preflightOutputs: { ui_test_runtime_policy: policy, ci_shape: "main" },
        }),
      ).toBe((runnerBackend === "github" ? 35 : 20) * (policy === "dual-all" ? 2 : 1));
    }
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
