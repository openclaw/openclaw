import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { buildChildEnv } from "../../scripts/ci-run-node-test-shard.mts";
import {
  createChangedNodeTestShards as createChangedNodeTestShardsWithSmoke,
  resolveChangedNodeTestTargets,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  type CompactNodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { PR_PROTECTED_RUNTIME_TEST_FILES } from "../../scripts/lib/ci-proof-test-inventory.mts";

type Shards = ReturnType<typeof createChangedNodeTestShards>;
type FileSelection =
  | {
      targets?: string[];
      includePatterns?: string[];
      groups?: { includePatterns?: string[] }[];
    }[]
  | null;
export function writeFiles(cwd: string, files: Record<string, string> | readonly string[]) {
  const entries: [string, string][] = Array.isArray(files)
    ? files.map((file): [string, string] => [file, "export {};\n"])
    : Object.entries(files);
  for (const [file, source] of entries) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), source);
  }
}

export function fullOwnerPlan(runnerBackend?: string, changedPaths?: string[]) {
  return createNodeTestShardBundles({
    compactMode: "pull-request",
    runnerBackend,
    changedPaths,
    includeReleaseOnlyPluginShards: false,
  });
}

export function expectSameFields<K extends PropertyKey>(
  actual: Partial<Record<K, unknown>>,
  expected: Partial<Record<K, unknown>>,
  keys: readonly K[],
) {
  for (const key of keys) {
    expect(actual[key], String(key)).toEqual(expected[key]);
  }
}

export const gatewayCallsitesGuard = "src/gateway/client-callsites.guard.test.ts";

export const smokeTestFiles = new Set([
  "test/gateway-rpc-exporters.test.ts",
  "src/config/io.load-async.test.ts",
  "src/config/io.compat.test.ts",
  "src/config/utility-model-separation-migration.io.test.ts",
  "src/plugins/loader.runtime-registry.test.ts",
  "test/qa-channel-message-tool-delivery.test.ts",
]);

// These cases isolate changed-owner projection through the workflow's target
// handoff. The integration file proves the complete owner + fixed-smoke plan.
export function createChangedNodeTestShards(
  changedPaths: string[],
  options: NonNullable<Parameters<typeof createChangedNodeTestShardsWithSmoke>[1]> = {},
) {
  const selectedTestTargets = resolveChangedNodeTestTargets(changedPaths, options).filter(
    (file) => !smokeTestFiles.has(file) || changedPaths.includes(file),
  );
  return createChangedNodeTestShardsWithSmoke(changedPaths, { ...options, selectedTestTargets });
}

export function materializeGatewayCallsitesFixture(cwd: string) {
  writeFiles(cwd, [gatewayCallsitesGuard]);
}

export function fallbackGroups(shards: NonNullable<Shards>) {
  return shards.flatMap((shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }]);
}

export function selectedFiles(shards: FileSelection) {
  return (shards ?? []).flatMap((shard) =>
    (shard.targets ?? []).concat(
      shard.includePatterns ?? [],
      shard.groups?.flatMap((group) => group.includePatterns ?? []) ?? [],
    ),
  );
}

type NodeTestJobResources = Pick<CompactNodeTestShard, "planConcurrency" | "env">;

export function expectProjectedNodeTestResources(
  job: NodeTestJobResources,
  group: CompactNodeTestShard["groups"][number],
  ownerJob: NodeTestJobResources,
  owner: CompactNodeTestShard["groups"][number],
  scratchDir: string,
) {
  // Repacking may serialize a parallel owner, but cannot add concurrency or workers.
  expect(job.planConcurrency ?? 1, `${group.shard_name} plan concurrency`).toBeLessThanOrEqual(
    ownerJob.planConcurrency ?? 1,
  );
  const childEnv = (row: NodeTestJobResources, entry: CompactNodeTestShard["groups"][number]) =>
    buildChildEnv(
      { kind: "group", name: entry.shard_name, plan: entry },
      {
        // A wide serial CI host can admit eight workers; parallel plans admit two.
        OPENCLAW_VITEST_MAX_WORKERS: row.planConcurrency === 1 ? "8" : "2",
        ...row.env,
      },
      scratchDir,
      0,
    );
  const projected = childEnv(job, group);
  // Callers assert selected files separately; the include-file handoff is not a resource limit.
  const { OPENCLAW_VITEST_INCLUDE_FILE: _projectedIncludes, ...projectedResources } = projected;
  const { OPENCLAW_VITEST_INCLUDE_FILE: _ownerIncludes, ...ownerResources } = childEnv(
    ownerJob,
    owner,
  );
  expect(projectedResources, `${group.shard_name} child environment`).toEqual(ownerResources);
  return projected;
}

export function expectCanonicalGroupedConcurrency(shards: Shards, runnerBackend?: string) {
  const grouped = expectDefined(shards, "changed owner plan").filter((shard) => shard.groups);
  const groups = grouped.flatMap((shard) =>
    (shard.groups ?? []).map((group) => ({ shard, group })),
  );
  const canonical = expectDefined(
    createSelectedNodeTestShardBundles(
      groups.flatMap(({ group }) => group.includePatterns ?? []),
      {
        runnerBackend,
        includeReleaseOnlyRuntimeTests: true,
        includePrExemptRuntimeTests: true,
      },
    ),
    "canonical selected owners",
  );
  for (const { shard, group } of groups) {
    if (!group.includePatterns) {
      // Paired isolated tooling configs retain whole processes and serial admission.
      expect(shard.planConcurrency).toBe(1);
      continue;
    }
    const owner = expectDefined(
      canonical.find((job) =>
        job.groups.some(
          (candidate) =>
            candidate.shard_name === group.shard_name &&
            group.configs.every((config) => candidate.configs.includes(config)),
        ),
      ),
      `canonical concurrency owner for ${group.shard_name}`,
    );
    expect(shard.planConcurrency, group.shard_name).toBe(owner.planConcurrency);
  }
}

export function expectProtectedOwnerExpansion(
  shards: Shards,
  required: readonly string[],
  ownerAreas: readonly string[],
) {
  const files = selectedFiles(shards);
  const allowed = new Set([...required, ...PR_PROTECTED_RUNTIME_TEST_FILES]);
  expect(files.filter((file) => required.includes(file)).toSorted()).toEqual(
    [...required].toSorted(),
  );
  expect(
    files.filter(
      (file) => !allowed.has(file) && !ownerAreas.some((area) => file.startsWith(`${area}/`)),
    ),
  ).toEqual([]);
  expect(new Set(files).size).toBe(files.length);
}
