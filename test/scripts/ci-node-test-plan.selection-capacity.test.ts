import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
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

it("shares selected serial setup within the shortest contributing timeout", () => {
  const targets = [
    "src/gateway/client-callsites.guard.test.ts",
    "src/gateway/server-methods/plugins.decisions.test.ts",
    "src/gateway/server-methods/plugins.retention.test.ts",
    "src/gateway/server-methods/plugins.runtime-owner.test.ts",
    "src/gateway/server-methods/plugins.test.ts",
    "src/gateway/server-methods/templates-add.test.ts",
    "src/gateway/server-methods/templates.test.ts",
    "src/gateway/server-plugin-reload.installed-package.test.ts",
  ];
  const selected = expectDefined(
    createSelectedNodeTestShardBundles(targets, {
      runnerBackend: "hybrid",
      includeReleaseOnlyToolingShards: false,
    }),
    "qualified serial selection",
  );
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({
    runner: "blacksmith-32vcpu-ubuntu-2404",
    planConcurrency: 1,
    timeoutMinutes: 60,
  });
  expect(
    selected
      .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
      .toSorted(),
  ).toEqual(targets.toSorted());
});
