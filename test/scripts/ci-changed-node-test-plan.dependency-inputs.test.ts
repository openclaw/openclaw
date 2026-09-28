import { describe, expect, it, vi } from "vitest";
import {
  createChangedNodeTestShards as createChangedNodeTestShardsWithSmoke,
  resolveChangedNodeTestTargets,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import {
  smokeTestFiles,
  createChangedNodeTestShards,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

describe("CI changed Node test plan", () => {
  it.each([
    "tsconfig.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    "node-version.mjs",
    "test/setup.ts",
    "vitest.config.ts",
    "patches/runtime.patch",
  ])("keeps %s owner coverage beside a precise source change", (globalInput) => {
    const onFallback = vi.fn();
    const shards = createChangedNodeTestShards(["src/agents/live-provider-owner.ts", globalInput], {
      onFallback,
    });
    expect(shards).not.toBeNull();
    expect(selectedFiles(shards)).toContain("src/agents/live-model-filter.test.ts");
    expect(selectedFiles(shards)).not.toContain("src/cron/service.stream-trigger.test.ts");
    expect(onFallback).not.toHaveBeenCalled();
  });

  it.each(["package.json", "pnpm-lock.yaml"])(
    "keeps dependency hub %s bounded even when exact history is unavailable",
    (changedPath) => {
      const onFallback = vi.fn();
      const shards = createChangedNodeTestShards([changedPath], { onFallback });
      expect(shards).not.toBeNull();
      expect(selectedFiles(shards)).not.toContain("src/cron/service.stream-trigger.test.ts");
      expect(onFallback).not.toHaveBeenCalled();
    },
  );

  it("rejects missing or unresolved changed-path input before producing a partial plan", () => {
    const onFallback = vi.fn();
    expect(createChangedNodeTestShards([], { onFallback })).toBeNull();
    expect(onFallback).toHaveBeenCalledWith("missing changed paths");
    const plan = vi.spyOn(testProjects, "resolveChangedTestTargetPlan");
    try {
      for (const mode of ["broad", "none"] as const) {
        plan.mockReturnValue({ mode, targets: [] });
        expect(() => createChangedNodeTestShardsWithSmoke(["src/infra/retry.ts"])).toThrow(
          `Unresolved changed-owner test plan: ${mode}`,
        );
      }
      expect(resolveChangedNodeTestTargets(["docs/ci.md"])).toEqual([...smokeTestFiles].toSorted());
    } finally {
      plan.mockRestore();
    }
  });
});
