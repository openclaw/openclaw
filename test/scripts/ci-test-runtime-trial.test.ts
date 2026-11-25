import { afterEach, expect, it, vi } from "vitest";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";

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
function manifest(options: Omit<Parameters<typeof runCiManifestFixture>[0], "bundledPlanner">) {
  const result = runCiManifestFixture({ ...fixture, ...options });
  expect(result.status, result.output).toBe(0);
  return result.outputs;
}

function nodeRows(outputs: Record<string, string>) {
  return JSON.parse(outputs.checks_node_core_nondist_matrix!).include;
}

it("defaults main dispatch to Bun despite the ambient runtime policy", () => {
  vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", "node");
  const outputs = manifest({ eventName: "workflow_dispatch", scopeEnv: mainScope });
  expect(nodeRows(outputs)).toEqual([
    expect.objectContaining({ test_runtime_policy: "bun-all", requires_bun: true }),
  ]);
  expect(nodeRows(outputs)[0].timeout_minutes).toBeUndefined();
  expect(outputs.ui_test_runtime_policy).toBe("bun-all");
});

it.each(["node", "bun-all", "dual-all"])(
  "routes explicit main dispatch and UI through %s in existing slots",
  (policy) => {
    const outputs = manifest({
      eventName: "workflow_dispatch",
      scopeEnv: { ...mainScope, OPENCLAW_CI_TEST_RUNTIME_POLICY: policy },
    });
    const rows = nodeRows(outputs);
    expect(rows).toHaveLength(1);
    expect(rows[0].test_runtime_policy).toBe(policy);
    expect(Boolean(rows[0].requires_bun)).toBe(policy !== "node");
    expect(rows[0].timeout_minutes).toBe(policy === "dual-all" ? 120 : undefined);
    expect(outputs.ui_test_runtime_policy).toBe(policy);
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

it("ignores trial environment on automatic events", () => {
  const outputs = manifest({
    eventName: "pull_request",
    scopeEnv: { OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual-all" },
  });
  expect(nodeRows(outputs)[0].test_runtime_policy).toBe("bun-all");
  expect(outputs.ui_test_runtime_policy).toBe("bun-all");
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
