import { relative } from "node:path";
import { expect, it } from "vitest";
import {
  listNodeTestConfigFiles,
  listWholeConfigFiles,
} from "../../scripts/lib/ci-node-test-inventory.mts";
import {
  createNodeTestShardBundles,
  type NodeTestShard,
  type CompactNodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { resolveCiTestRuntimeSelections } from "../../scripts/lib/ci-test-runtime.mts";

function runtimeInventory(
  jobs: (NodeTestShard | CompactNodeTestShard)[],
  policy: "bun-all" | "dual-all" = "bun-all",
) {
  const inventory: string[] = [];
  for (const job of jobs) {
    if (job.requiresDist) {
      continue;
    }
    const groups = job.groups ?? ("configs" in job ? [{ ...job, shard_name: job.shardName }] : []);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const configFiles = group.configs.map(listNodeTestConfigFiles);
      const files =
        group.includePatterns ??
        listWholeConfigFiles(group.shard_name) ??
        (configFiles.every(Boolean)
          ? configFiles.flat().filter((file): file is string => file !== undefined)
          : undefined);
      for (const selection of resolveCiTestRuntimeSelections(group, policy)) {
        if (job.testRuntime && job.testRuntime !== selection.runtime) {
          continue;
        }
        let selected =
          selection.engine === "bun-test"
            ? selection.files
            : (selection.includePatterns ??
              selection.targets ??
              (selection.vitestArgs?.length &&
              selection.vitestArgs.every((arg) => !arg.startsWith("-"))
                ? selection.vitestArgs.map((file) => relative(process.cwd(), file))
                : files));
        if (selection.engine !== "bun-test" && selected) {
          const excluded = new Set(
            selection.vitestArgs
              ?.filter((arg) => arg.startsWith("--exclude="))
              .map((arg) => relative(process.cwd(), arg.slice("--exclude=".length))),
          );
          selected = selected.filter((file) => !excluded.has(file));
        }
        inventory.push(
          ...(selected ?? group.configs.map((config) => "config:" + config)).map(
            (file) => selection.runtime + ":" + file,
          ),
        );
      }
    }
  }
  return inventory.toSorted();
}

it("packs independent runtime membership within main capacity without dropping or replaying files", () => {
  const options = {
    compactMode: "pull-request" as const,
    runnerBackend: "hybrid",
    mainValidation: true,
    compactNodeJobCap: 75,
    includeProofTests: true,
    includeReleaseOnlyPluginShards: false,
    includeReleaseOnlyToolingShards: true,
    includeReleaseOnlyRuntimeTests: false,
    includePrExemptRuntimeTests: true,
  };
  const original = createNodeTestShardBundles(options);
  const packed = createNodeTestShardBundles({ ...options, runtimePolicy: "bun-all" });
  // Two existing worker-E2E rows share the 77-row main matrix; two dist rows
  // retain their separate matrix. This is the real repository inventory.
  expect(packed.filter((job) => !job.requiresDist).length + 2).toBeLessThanOrEqual(77);
  expect(packed.every((job) => job.testRuntime === "node" || job.testRuntime === "bun")).toBe(true);
  expect(new Set(packed.map((job) => job.checkName)).size).toBe(packed.length);
  expect(runtimeInventory(packed)).toEqual(runtimeInventory(original));
  expect(packed.filter((job) => job.requiresDist).map((job) => job.groups)).toEqual(
    original.filter((job) => job.requiresDist).map((job) => job.groups),
  );
});

it("keeps full dual-runtime dispatch within one GitHub matrix without changing membership", () => {
  const options = {
    runnerBackend: "hybrid",
    includeProofTests: true,
    includeReleaseOnlyPluginShards: false,
    includeReleaseOnlyToolingShards: true,
    includeReleaseOnlyRuntimeTests: true,
    includePrExemptRuntimeTests: true,
  };
  const original = createNodeTestShardBundles(options);
  const packed = createNodeTestShardBundles({ ...options, runtimePolicy: "dual-all" });
  // Full dispatch also includes four independently bound worker-E2E rows.
  expect(packed.filter((job) => !job.requiresDist).length + 4).toBeLessThanOrEqual(256);
  expect(packed.every((job) => job.testRuntime === "node" || job.testRuntime === "bun")).toBe(true);
  expect(runtimeInventory(packed, "dual-all")).toEqual(runtimeInventory(original, "dual-all"));
});
