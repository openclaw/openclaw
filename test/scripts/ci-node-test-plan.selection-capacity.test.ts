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
  // Selection preserves parallel capacity unless only one group remains.
  // A singleton has no sibling to overlap and is normalized to a serial job.
  for (const job of selected) {
    expect(job.requiresDist).toBe(false);
    expect([1, 2]).toContain(job.planConcurrency);
    for (const group of job.groups) {
      const original = expectDefined(
        full.find((owner) => owner.groups.some((entry) => entry.shard_name === group.shard_name)),
        "canonical compact owner",
      );
      const expectedConcurrency =
        original.planConcurrency === 2 && job.groups.length === 1 ? 1 : original.planConcurrency;
      expect(job).toMatchObject({
        runner:
          expectedConcurrency === 1
            ? "blacksmith-16vcpu-ubuntu-2404"
            : "blacksmith-32vcpu-ubuntu-2404",
        planConcurrency: expectedConcurrency,
      });
      expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? String(group.fallbackMaxWorkers)).toBe("2");
    }
  }
});
