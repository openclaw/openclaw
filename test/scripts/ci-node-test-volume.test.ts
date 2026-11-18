import { expect, it } from "vitest";
import * as planOwner from "../../scripts/lib/ci-node-test-plan.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  type NodeTestVolumeContext,
  type NodeTestShardGroup,
} from "../../scripts/lib/ci-node-test-plan.mts";

const prepareNodeTestVolumes = planOwner.prepareNodeTestVolumes;

const volumeGroup = (configs: string[], includePatterns?: string[]): NodeTestShardGroup => ({
  configs,
  includePatterns,
  shard_name: "volume-contract",
  requiresDist: false,
  runner: "ubuntu-24.04",
});
const volumeContextFor = (
  groups: NodeTestShardGroup[],
  runtimePolicy: NodeTestVolumeContext["runtimePolicy"] = "node",
): NodeTestVolumeContext => ({
  revision: "a".repeat(40),
  runtimePolicy,
  environment: {
    OPENCLAW_VITEST_INCLUDE_FILE: "",
    OPENCLAW_VITEST_POST_SHARD_INCLUDE_FILE: "",
    OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: "[]",
  },
  eligibility: {
    changedPaths: [],
    includeReleaseOnlyRuntimeTests: true,
    includePrExemptRuntimeTests: true,
  },
  fullPlan: () =>
    groups.map((group) => ({
      ...group,
      groups: [group],
      checkName: "checks-volume-contract",
      shardName: group.shard_name,
    })),
});

it("counts the compact full plan's scheduled Docker membership, not its config declaration", () => {
  const docker = "test/vitest/vitest.tooling-docker.config.ts";
  const full = createNodeTestShardBundles({
    compactMode: "pull-request",
    runnerBackend: "hybrid",
    changedPaths: [],
    includeReleaseOnlyToolingShards: false,
    includeReleaseOnlyPluginShards: false,
    includeProofTests: false,
  });
  const scheduled = full
    .flatMap((job) => job.groups)
    .filter((group) => group.configs.includes(docker));
  expect(scheduled).toHaveLength(0);
  const context = { ...volumeContextFor([]), fullPlan: () => full };
  const describe = prepareNodeTestVolumes(context);
  const entries = describe(volumeGroup([docker])).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]?.selected?.count).toBe(1);
  // An unadmitted tooling owner has no PR denominator: never claim 2/2.
  expect(entries[0]?.full).toBeNull();
  const toolingFull = createNodeTestShardBundles({
    compactMode: "pull-request",
    runnerBackend: "hybrid",
    changedPaths: ["test/scripts/docker-build-helper.test.ts"],
    includeReleaseOnlyToolingShards: false,
    includeReleaseOnlyPluginShards: false,
    includeProofTests: false,
  });
  expect(
    toolingFull.flatMap((job) => job.groups).some((group) => group.configs.includes(docker)),
  ).toBe(true);
  const admitted = prepareNodeTestVolumes({ ...context, fullPlan: () => toolingFull });
  expect(admitted(volumeGroup([docker])).entries[0]?.full?.count).toBe(1);
});

it.each(["node", "bun-all", "dual-all"] as const)(
  "retains whole boundary and mixed Docker/isolated inventories under %s",
  (policy) => {
    const boundary = volumeGroup(["test/vitest/vitest.boundary.config.ts"]);
    const mixed = volumeGroup([
      "test/vitest/vitest.tooling-docker.config.ts",
      "test/vitest/vitest.tooling-isolated.config.ts",
    ]);
    const describe = prepareNodeTestVolumes(volumeContextFor([boundary, mixed], policy));
    for (const group of [boundary, mixed]) {
      const entries = describe(group).entries;
      expect(entries.length).toBe(group.configs.length * (policy === "dual-all" ? 2 : 1));
      for (const entry of entries) {
        expect(entry.full).not.toBeNull();
        expect(entry.full?.count).toBe(entry.selected?.count);
        expect(entry.full?.digest).toBe(entry.selected?.digest);
      }
    }
  },
);

it("unions repeated stripes once and keeps missing, ineligible and changed profiles unknown", () => {
  const config = "test/vitest/vitest.gateway-database-workers.config.ts";
  const first = volumeGroup(
    [config],
    ["src/gateway/session-message-events.history-worker.test.ts"],
  );
  const second = volumeGroup([config], ["src/gateway/board-http.test.ts"]);
  const context = volumeContextFor([first, first, second]);
  const describe = prepareNodeTestVolumes(context);
  const one = describe(first).entries[0]!;
  const two = describe(second).entries[0]!;
  expect(one.full?.count).toBe(2);
  expect(one.full?.id).toBe(two.full?.id);
  expect(describe({ ...first, env: { SCENARIO: "other" } }).entries[0]?.full).toBeNull();
  expect(
    prepareNodeTestVolumes({ ...context, fullPlan: undefined })(first).entries[0]?.full,
  ).toBeNull();
  const unavailable = prepareNodeTestVolumes({
    ...context,
    fullPlan: () => {
      throw new Error("unavailable");
    },
  });
  expect(unavailable(first).entries[0]?.full).toBeNull();
  expect(describe(volumeGroup(["unknown.config.ts"])).entries).toEqual([]);
  expect(
    describe({
      ...first,
      env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--testNamePattern=x"]' },
    }).entries,
  ).toEqual([]);
  const ambiguous = prepareNodeTestVolumes(
    volumeContextFor([first, volumeGroup([config], ["test/**/*.test.ts"])]),
  );
  expect(ambiguous(first).entries[0]?.full).toBeNull();
  const ineligible = prepareNodeTestVolumes({
    ...context,
    eligibility: {
      changedPaths: [],
      includeReleaseOnlyRuntimeTests: false,
      includePrExemptRuntimeTests: false,
    },
  });
  expect(
    ineligible(volumeGroup(["test/vitest/vitest.tooling-isolated.config.ts"])).entries,
  ).toEqual([]);
});

it("adds volumes to all-tooling selections without changing execution bytes", () => {
  const targets = ["test/scripts/ci-workflow-planning.test.ts"];
  const options = { runnerBackend: "hybrid" };
  const baseline = createSelectedNodeTestShardBundles(targets, options);
  const context = volumeContextFor([]);
  const result = createSelectedNodeTestShardBundles(targets, {
    ...options,
    volumeContext: {
      ...context,
      fullPlan: () =>
        createNodeTestShardBundles({
          ...options,
          changedPaths: targets,
          compactMode: "pull-request",
          includeReleaseOnlyToolingShards: false,
          includeReleaseOnlyPluginShards: false,
          includeProofTests: false,
        }),
    },
  });
  expect(result).not.toBeNull();
  const entries = result!.flatMap((job) =>
    job.groups.flatMap((group) => group.volume?.entries ?? []),
  );
  expect(
    entries.some((entry) => entry.config === "test/vitest/vitest.tooling.config.ts" && entry.full),
  ).toBe(true);
  const stripped = structuredClone(result!);
  for (const job of stripped) {
    for (const group of job.groups) {
      delete group.volume;
    }
  }
  expect(JSON.stringify(stripped)).toBe(JSON.stringify(baseline));
});
