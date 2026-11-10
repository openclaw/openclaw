import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createChangedNodeTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { routeBoatNodeTestJobs } from "../../scripts/lib/ci-node-test-capacity.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  type NodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";

it("retains canonical capacity and exact scope for a compact selection", () => {
  const targets = [
    "src/agents/embedded-agent-runner/effective-tool-policy.test.ts",
    "src/gateway/client-callsites.guard.test.ts",
    "src/gateway/mcp-app-extension-runtime.test.ts",
    "src/agents/cli-runner.helpers.test.ts",
  ];
  const full = createNodeTestShardBundles({
    runnerBackend: "hybrid",
    changedPaths: targets,
    includeReleaseOnlyPluginShards: false,
    includeProofTests: false,
    compactMode: "pull-request",
  });
  const selected = expectDefined(
    createSelectedNodeTestShardBundles(targets, { runnerBackend: "hybrid" }),
    "qualified compact selection",
  );
  expect(
    selected
      .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
      .toSorted(),
  ).toEqual(targets.toSorted());
  // Selection may serialize singleton owners to share setup, without increasing
  // any original job's concurrency or its child worker allowance.
  for (const job of selected) {
    expect(job.requiresDist).toBe(false);
    expect([1, 2]).toContain(job.planConcurrency);
    for (const group of job.groups) {
      const original = expectDefined(
        full.find((owner) => owner.groups.some((entry) => entry.shard_name === group.shard_name)),
        "canonical compact owner",
      );
      expect(job.planConcurrency).toBeLessThanOrEqual(original.planConcurrency ?? 1);
      expect(job.runner).toBe(
        job.planConcurrency === 1
          ? "blacksmith-16vcpu-ubuntu-2404"
          : "blacksmith-32vcpu-ubuntu-2404",
      );
      expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? String(group.fallbackMaxWorkers)).toBe("2");
    }
  }
});

it("maps final Boat plans without changing hybrid groups, packing, or timings", () => {
  const targets = [
    "src/gateway/mcp-app-extension-runtime.test.ts",
    "src/agents/cli-runner.helpers.test.ts",
  ];
  const expectedCapacity: Record<string, [string, number]> = {
    "blacksmith-4vcpu-ubuntu-2404": ["boat", 2],
    "blacksmith-8vcpu-ubuntu-2404": ["boat", 2],
    "blacksmith-16vcpu-ubuntu-2404": ["boat-large", 4],
    "blacksmith-32vcpu-ubuntu-2404": ["boat-xlarge", 8],
  };
  const expectedJob = <T extends Pick<NodeTestShard, "runner" | "checkName">>(job: T) => {
    const capacity = expectedCapacity[job.runner];
    const promoted =
      job.runner === "blacksmith-8vcpu-ubuntu-2404" &&
      ["checks-node-compact-large-9", "checks-node-compact-large-5"].includes(job.checkName);
    return promoted
      ? { ...job, runner: "boat-large", cpuBudget: 4 }
      : capacity
        ? { ...job, runner: capacity[0], cpuBudget: capacity[1] }
        : job;
  };
  for (const compactMode of [undefined, "pull-request", "push"] as const) {
    const options = {
      compactMode,
      includeProofTests: false,
      includeReleaseOnlyPluginShards: false,
    };
    const hybrid = createNodeTestShardBundles({ ...options, runnerBackend: "hybrid" });
    const boat = createNodeTestShardBundles({ ...options, runnerBackend: "boat" });
    expect(boat).toEqual(hybrid.map(expectedJob));
  }
  for (const plan of [createSelectedNodeTestShardBundles, createChangedNodeTestShards]) {
    const hybrid = expectDefined(plan(targets, { runnerBackend: "hybrid" }), "hybrid selection");
    const boat = expectDefined(plan(targets, { runnerBackend: "boat" }), "Boat selection");
    expect(boat).toEqual(hybrid.map(expectedJob));
  }
});

it.each(["checks-node-compact-large-9", "checks-node-compact-large-5"])(
  "retains the existing 4-CPU physical promotion for %s",
  (checkName) => {
    const job = {
      checkName,
      shardName: checkName,
      requiresDist: false,
      runner: "blacksmith-8vcpu-ubuntu-2404",
      configs: ["test/vitest/vitest.unit-fast.config.ts"],
    };
    expect(routeBoatNodeTestJobs([job])).toEqual([{ ...job, runner: "boat-large", cpuBudget: 4 }]);
  },
);

it("retains the selected board-store memory floor without widening its CPU budget", () => {
  const targets = ["src/gateway/board-store.test.ts"];
  const hybrid = expectDefined(
    createSelectedNodeTestShardBundles(targets, { runnerBackend: "hybrid" }),
    "hybrid board-store selection",
  );
  const boat = expectDefined(
    createSelectedNodeTestShardBundles(targets, { runnerBackend: "boat" }),
    "Boat board-store selection",
  );
  expect(hybrid).toHaveLength(1);
  expect(hybrid[0]?.runner).toBe("blacksmith-16vcpu-ubuntu-2404");
  expect(boat).toEqual([{ ...hybrid[0], runner: "boat-xlarge", cpuBudget: 4 }]);
  expect(boat[0]?.groups[0]?.minTotalMemoryBytes).toBe(28 * 1024 ** 3);
});

it("shares selected serial setup within the shortest contributing timeout", () => {
  const serialTargets = [
    "src/gateway/server-methods/plugins.decisions.test.ts",
    "src/gateway/server-methods/plugins.retention.test.ts",
    "src/gateway/server-methods/plugins.runtime-owner.test.ts",
    "src/gateway/server-methods/plugins.test.ts",
    "src/gateway/server-methods/templates-add.test.ts",
    "src/gateway/server-methods/templates.test.ts",
    "src/gateway/server-plugin-reload.installed-package.test.ts",
  ];
  const targets = ["src/gateway/client-callsites.guard.test.ts", ...serialTargets];
  const selected = expectDefined(
    createSelectedNodeTestShardBundles(targets, {
      runnerBackend: "hybrid",
    }),
    "qualified serial selection",
  );
  const serial = expectDefined(
    selected.find((job) =>
      serialTargets.every((target) =>
        job.groups.some((group) => group.includePatterns?.includes(target)),
      ),
    ),
    "shared serial selection",
  );
  expect(serial).toMatchObject({
    runner: "blacksmith-32vcpu-ubuntu-2404",
    planConcurrency: 1,
  });
  expect(serial.timeoutMinutes ?? 60).toBe(60);
  expect(
    selected
      .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
      .toSorted(),
  ).toEqual(targets.toSorted());
});
