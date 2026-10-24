import { execFileSync } from "node:child_process";
import fs, { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import { createChangedNodeTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import * as testProjects from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const configPath = (name: string) => `test/vitest/vitest.${name}.config.ts`;
const boundaryConfig = configPath("boundary");
const channelConfig = configPath("channels");

function fixture(files: Record<string, string>) {
  const cwd = tempDirs.make("ci-build-selection-");
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(cwd, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  return cwd;
}

it("keeps source boundary proof when a narrow PR has no dist consumer", () => {
  const cwd = fixture({
    "src/example/runtime.ts": "export const value = 1;",
    "src/example/runtime.test.ts": 'import "./runtime.js";',
    "src/gateway/client-callsites.guard.test.ts": "export {};",
  });
  const readFile = vi.spyOn(fs, "readFileSync");
  const shards = createChangedNodeTestShards(["src/example/runtime.ts"], {
    cwd,
    dedicatedBuildArtifacts: false,
  });
  expect(shards?.flatMap((shard) => shard.targets ?? [])).toContain("src/example/runtime.test.ts");
  expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
  expect(shards?.flatMap((shard) => shard.configs ?? [])).toContain(boundaryConfig);
  const checkoutTestReads = readFile.mock.calls
    .map(([file]) => path.relative(process.cwd(), String(file)).replaceAll("\\", "/"))
    .filter((file) => file.startsWith("src/") && file.endsWith(".test.ts"));
  const selectedTargets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];
  expect(checkoutTestReads.filter((file) => !selectedTargets.includes(file))).toEqual([]);
});

it("keeps exclusive aggregates out of cold canonical metadata discovery", async () => {
  vi.resetModules();
  onTestFinished(() => {
    vi.resetModules();
  });
  const { nodeTestConfigRequiresCanonicalMetadata } =
    await import("../../scripts/lib/ci-node-test-plan.mts");
  const { isExclusiveCiTestConfig } = await import("../../scripts/lib/local-check-runtime.mts");
  const readFile = vi.spyOn(fs, "readFileSync");
  for (const config of [
    "vitest.config.ts",
    "test/vitest/vitest.config.ts",
    ...["full-agentic", "gateway"].map(configPath),
  ]) {
    expect(isExclusiveCiTestConfig(config)).toBe(true);
    expect(nodeTestConfigRequiresCanonicalMetadata(config)).toBe(false);
  }
  expect(readFile).not.toHaveBeenCalled();
  readFile.mockRestore();
  for (const config of [
    "gateway-server",
    "gateway-client",
    "tooling",
    "tui-pty",
    "agents-embedded-agent",
  ].map(configPath)) {
    expect(nodeTestConfigRequiresCanonicalMetadata(config)).toBe(true);
  }
});

it("keeps source execution when narrow config owners no longer admit an artifact", () => {
  const tuiConfig = configPath("tui-pty");
  const helper = "src/tui/tui-pty-harness-assertion-test-support.test.ts";
  // Isolate canonical execution policy from separately tested graph discovery.
  vi.spyOn(testProjects, "hasImportGraphImpactOnTargets").mockReturnValue(false);
  vi.spyOn(testProjects, "resolveAffectedTestsFromImportGraph").mockReturnValue([]);
  for (const changedPaths of [[tuiConfig], [boundaryConfig], [tuiConfig, helper]]) {
    const shards = createChangedNodeTestShards(changedPaths, { dedicatedBuildArtifacts: false });
    expect(shards?.some((shard) => shard.requiresDist)).toBe(false);
    expect(shards?.filter((shard) => shard.configs.includes(boundaryConfig))).toHaveLength(1);
    if (changedPaths.includes(helper)) {
      expect(shards?.flatMap((shard) => shard.targets ?? [])).toContain(helper);
    }
  }
});

it("runs selected channel files in one config child while retaining separate contract coverage", () => {
  const channelTargets = Array.from(
    { length: 13 },
    (_, index) => `src/channels/selection-${String(index).padStart(2, "0")}.test.ts`,
  );
  const contract = "src/channels/plugins/contracts/plugins-core.registry.contract.test.ts";
  const changedPaths = [...channelTargets, contract];
  const cwd = fixture(Object.fromEntries(changedPaths.map((file) => [file, "export {};\n"])));
  const defaults = createChangedNodeTestShards(changedPaths, { cwd });
  const defaultChildren = defaults?.flatMap((shard) =>
    shard.targets
      ? resolveShardPlans({ OPENCLAW_NODE_TEST_TARGETS_JSON: JSON.stringify(shard.targets) })
      : [],
  );
  expect(defaultChildren?.filter((child) => child.kind === "target")).toHaveLength(14);

  const shards = createChangedNodeTestShards(changedPaths, { cwd, dedicatedBuildArtifacts: false });
  const channelShards = shards?.filter((shard) => shard.configs.includes(channelConfig));
  expect(channelShards).toHaveLength(1);
  const channelShard = channelShards?.[0];
  expect(channelShard).toMatchObject({
    requiresDist: false,
    runner: "blacksmith-8vcpu-ubuntu-2404",
  });
  expect(channelShard?.env).toEqual({
    NODE_OPTIONS: "--max-old-space-size=8192",
    OPENCLAW_VITEST_MAX_WORKERS: "1",
  });
  const children = resolveShardPlans({
    OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(channelShard?.configs),
    OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: JSON.stringify(channelShard?.includePatterns),
    OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(channelShard?.env),
  });
  expect(children).toMatchObject([
    {
      kind: "group",
      plan: {
        configs: [channelConfig],
        includePatterns: channelTargets,
      },
    },
  ]);
  expect(shards?.flatMap((shard) => shard.targets ?? [])).toEqual([contract]);
  expect(shards?.filter((shard) => shard.configs.includes(boundaryConfig))).toHaveLength(1);
});

it("rejects unavailable canonical metadata for an untracked config consumer", () => {
  const helper = "scripts/config-input.mts";
  const test = "test/scripts/config-input.test.ts";
  const cwd = fixture({
    [helper]: "export const value = 1;",
    [test]: 'import "../../scripts/config-input.mts";',
    "test/vitest/vitest.commands.config.ts": 'import "../../scripts/config-input.mts";',
  });
  const gitOptions = { cwd, env: createNestedGitEnv() };
  execFileSync("git", ["init", "-q"], gitOptions);
  execFileSync("git", ["add", "--", helper, test], gitOptions);
  const onFallback = vi.fn();
  expect(createChangedNodeTestShards([helper], { cwd, onFallback })).toBeNull();
  expect(onFallback).toHaveBeenCalledWith("test targets lack canonical shard metadata");
});
