import { execFileSync } from "node:child_process";
import fs, { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import { createChangedNodeTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { tuiPtyTestFiles } from "../vitest/vitest.test-shards.mjs";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps source boundary proof when a narrow PR has no dist consumer", () => {
  const cwd = tempDirs.make("ci-source-boundary-");
  for (const [file, source] of Object.entries({
    "src/example/runtime.ts": "export const value = 1;",
    "src/example/runtime.test.ts": 'import "./runtime.js";',
    "src/gateway/client-callsites.guard.test.ts": "export {};",
    "src/tasks/task-boundaries.test.ts": "export {};",
  })) {
    const absolute = path.join(cwd, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  const readFile = vi.spyOn(fs, "readFileSync");
  try {
    const shards = createChangedNodeTestShards(["src/example/runtime.ts"], {
      cwd,
      dedicatedBuildArtifacts: false,
    });
    expect(shards).not.toBeNull();
    expect(shards?.flatMap((shard) => shard.targets ?? [])).toContain(
      "src/example/runtime.test.ts",
    );
    expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
    expect(shards?.flatMap((shard) => shard.configs ?? [])).toContain(
      "test/vitest/vitest.boundary.config.ts",
    );
    const checkoutTestReads = readFile.mock.calls
      .map(([file]) => path.relative(process.cwd(), String(file)).replaceAll("\\", "/"))
      .filter((file) => file.startsWith("src/") && file.endsWith(".test.ts"));
    const selectedTargets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];
    expect(checkoutTestReads.filter((file) => !selectedTargets.includes(file))).toEqual([]);
  } finally {
    readFile.mockRestore();
  }
});

it("executes the source TUI assertion helper without admitting deferred PTY builds", () => {
  const helper = "src/tui/tui-pty-harness-assertion-test-support.test.ts";
  const changedPaths = [helper, ...tuiPtyTestFiles];
  const shards = createChangedNodeTestShards(changedPaths, {
    dedicatedBuildArtifacts: false,
  });
  expect(shards).not.toBeNull();
  expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
  const targets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];
  expect(targets).toContain(helper);
  expect(targets.filter((target) => tuiPtyTestFiles.includes(target))).toEqual([]);
  expect(testProjects.buildVitestRunPlans([helper])).toEqual([
    {
      config: "test/vitest/vitest.tui-pty.config.ts",
      forwardedArgs: [],
      includePatterns: [helper],
      watchMode: false,
    },
  ]);
  expect(shards?.flatMap((shard) => shard.configs ?? [])).toContain(
    "test/vitest/vitest.boundary.config.ts",
  );
  expect(createChangedNodeTestShards(changedPaths)?.some((shard) => shard.requiresDist)).toBe(true);
});

it("keeps source execution when narrow config owners no longer admit an artifact", () => {
  const tuiConfig = "test/vitest/vitest.tui-pty.config.ts";
  const boundaryConfig = "test/vitest/vitest.boundary.config.ts";
  const helper = "src/tui/tui-pty-harness-assertion-test-support.test.ts";
  // Direct config changes already name the owner. Graph-discovery behavior has
  // its own tests; keep this regression on the real canonical execution policy.
  const configImpact = vi
    .spyOn(testProjects, "hasImportGraphImpactOnTargets")
    .mockReturnValue(false);
  const graphTargets = vi
    .spyOn(testProjects, "resolveAffectedTestsFromImportGraph")
    .mockReturnValue([]);
  try {
    for (const changedPaths of [[tuiConfig], [boundaryConfig], [tuiConfig, helper]]) {
      const shards = createChangedNodeTestShards(changedPaths, { dedicatedBuildArtifacts: false });
      expect(shards).not.toBeNull();
      expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
      expect(shards?.filter((shard) => shard.configs.includes(boundaryConfig))).toHaveLength(1);
      if (changedPaths.includes(tuiConfig)) {
        expect(shards?.flatMap((shard) => shard.targets ?? [])).toContain(helper);
      }
    }
  } finally {
    graphTargets.mockRestore();
    configImpact.mockRestore();
  }
});

it("runs selected channel files in one config child while retaining separate contract coverage", () => {
  const cwd = tempDirs.make("ci-source-channels-");
  const channelTargets = Array.from(
    { length: 13 },
    (_, index) => `src/channels/selection-${String(index).padStart(2, "0")}.test.ts`,
  );
  const contract = "src/channels/plugins/contracts/plugins-core.registry.contract.test.ts";
  const changedPaths = [...channelTargets, contract];
  for (const file of changedPaths) {
    const absolute = path.join(cwd, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, "export {};\n");
  }
  const defaults = createChangedNodeTestShards(changedPaths, { cwd });
  const defaultChildren = defaults?.flatMap((shard) =>
    shard.targets
      ? resolveShardPlans({ OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(shard.targets) })
      : [],
  );
  expect(defaultChildren?.filter((child) => child.kind === "target")).toHaveLength(14);

  const shards = createChangedNodeTestShards(changedPaths, { cwd, dedicatedBuildArtifacts: false });
  expect(shards).not.toBeNull();
  const channelShards = shards?.filter((shard) =>
    shard.configs.includes("test/vitest/vitest.channels.config.ts"),
  );
  expect(channelShards).toHaveLength(1);
  const channelShard = channelShards?.[0];
  if (!channelShard) {
    throw new Error("Expected the channel source config owner");
  }
  expect(channelShard.requiresDist).toBe(false);
  expect(channelShard.runner).toBe("blacksmith-8vcpu-ubuntu-2404");
  expect(channelShard.env).toEqual({
    NODE_OPTIONS: "--max-old-space-size=8192",
    OPENCLAW_VITEST_MAX_WORKERS: "1",
  });
  const children = resolveShardPlans({
    OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(channelShard.configs),
    OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: JSON.stringify(channelShard.includePatterns),
    OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(channelShard.env),
  });
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({
    kind: "group",
    plan: {
      configs: ["test/vitest/vitest.channels.config.ts"],
      includePatterns: channelTargets,
    },
  });
  expect(shards?.flatMap((shard) => shard.targets ?? [])).toEqual([contract]);
  expect(
    shards?.filter((shard) => shard.configs.includes("test/vitest/vitest.boundary.config.ts")),
  ).toHaveLength(1);
});

it("retains the canonical fallback for an untracked config importing a changed helper", () => {
  const cwd = tempDirs.make("ci-untracked-config-");
  const helper = "scripts/config-input.mts";
  const test = "test/scripts/config-input.test.ts";
  for (const [file, source] of Object.entries({
    [helper]: "export const value = 1;",
    [test]: 'import "../../scripts/config-input.mts";',
    "test/vitest/vitest.commands.config.ts": 'import "../../scripts/config-input.mts";',
  })) {
    const absolute = path.join(cwd, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  const gitOptions = { cwd, env: createNestedGitEnv() };
  execFileSync("git", ["init", "-q"], gitOptions);
  execFileSync("git", ["add", "--", helper, test], gitOptions);
  const onFallback = vi.fn();
  expect(createChangedNodeTestShards([helper], { cwd, onFallback })).toBeNull();
  expect(onFallback).toHaveBeenCalledWith(
    "changed Vitest configs lack canonical checkout metadata",
  );
});
