import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createChangedNodeTestShards as createChangedNodeTestShardsWithSmoke,
  resolveChangedNodeTestTargets,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  smokeTestFiles,
  createChangedNodeTestShards,
  selectedFiles,
} from "./ci-changed-node-test-plan.test-support.js";

const globalInputs = ["tsconfig.json", "test/setup.ts", "patches/runtime.patch"];
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let cwd: string;

beforeAll(() => {
  cwd = tempDirs.make("changed-node-dependency-inputs-");
  const files = {
    ...Object.fromEntries(globalInputs.map((file) => [file, file.endsWith(".json") ? "{}" : ""])),
    "package.json": "{}",
    "pnpm-lock.yaml": "",
    "src/agents/live-provider-owner.ts": "export const value = 1;\n",
    "src/agents/live-model-filter.test.ts": 'import "./live-provider-owner.js";\n',
    "src/cron/service.stream-trigger.test.ts": "export {};\n",
    "src/example/dependency-reader.test.ts":
      'new URL("../../package.json", import.meta.url);\nnew URL("../../pnpm-lock.yaml", import.meta.url);\n',
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), source);
  }
});

describe("CI changed Node test plan", () => {
  it.each(globalInputs)("keeps %s owner coverage beside a precise source change", (globalInput) => {
    const onFallback = vi.fn();
    const shards = createChangedNodeTestShards(["src/agents/live-provider-owner.ts", globalInput], {
      cwd,
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
      const shards = createChangedNodeTestShards([changedPath], { cwd, onFallback });
      expect(shards).not.toBeNull();
      expect(selectedFiles(shards)).toContain("src/example/dependency-reader.test.ts");
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
