import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import {
  createChangedNodeTestShards as createChangedNodeTestShardsWithSmoke,
  resolveChangedNodeTestTargets,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { createSelectedNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import { PR_PROTECTED_RUNTIME_TEST_FILES } from "../../scripts/lib/ci-proof-test-inventory.mts";

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
  const file = path.join(cwd, gatewayCallsitesGuard);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "export {};\n");
}

export function fallbackGroups(
  shards: NonNullable<ReturnType<typeof createChangedNodeTestShards>>,
) {
  return shards.flatMap((shard) => shard.groups ?? [{ ...shard, shard_name: shard.shardName }]);
}

export function selectedFiles(shards: ReturnType<typeof createChangedNodeTestShards>) {
  return (shards ?? []).flatMap((shard) =>
    (shard.targets ?? []).concat(
      shard.includePatterns ?? [],
      shard.groups?.flatMap((group) => group.includePatterns ?? []) ?? [],
    ),
  );
}

export function expectCanonicalGroupedConcurrency(
  shards: ReturnType<typeof createChangedNodeTestShards>,
  runnerBackend?: string,
) {
  const grouped = expectDefined(shards, "changed owner plan").filter((shard) => shard.groups);
  const files = grouped.flatMap((shard) =>
    (shard.groups ?? []).flatMap((group) => group.includePatterns ?? []),
  );
  const canonical = expectDefined(
    createSelectedNodeTestShardBundles(files, {
      runnerBackend,
      includeReleaseOnlyRuntimeTests: true,
      includePrExemptRuntimeTests: true,
    }),
    "canonical selected owners",
  );
  for (const shard of grouped) {
    for (const group of shard.groups ?? []) {
      if (!group.includePatterns) {
        // Paired isolated tooling configs retain whole processes and serial admission.
        expect(group.shard_name).toBe("core-tooling-isolated");
        expect(group.configs.toSorted()).toEqual([
          "test/vitest/vitest.tooling-docker.config.ts",
          "test/vitest/vitest.tooling-isolated.config.ts",
        ]);
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
}

export function expectProtectedOwnerExpansion(
  shards: ReturnType<typeof createChangedNodeTestShards>,
  required: readonly string[],
  ownerAreas: readonly string[],
) {
  const files = selectedFiles(shards);
  expect(files.filter((file) => required.includes(file)).toSorted()).toEqual(
    [...required].toSorted(),
  );
  expect(
    files.filter(
      (file) =>
        !required.includes(file) &&
        !PR_PROTECTED_RUNTIME_TEST_FILES.includes(file) &&
        !ownerAreas.some((area) => file.startsWith(`${area}/`)),
    ),
  ).toEqual([]);
  expect(new Set(files).size).toBe(files.length);
}
