import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createChangedNodeTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  listNodeTestConfigFiles,
  listNodeTestVolumeConfigFiles,
} from "../../scripts/lib/ci-node-test-inventory.mts";
import * as planOwner from "../../scripts/lib/ci-node-test-plan.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  resolveCanonicalNodeTestConfig,
  type NodeTestVolumeContext,
  type NodeTestShardGroup,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import { createRuntimeConfigVitestConfig } from "../vitest/vitest.runtime-config.config.ts";
import { createUnitFastIsolatedVitestConfig } from "../vitest/vitest.unit-fast-isolated.config.ts";
import { listMatchedTestFiles } from "./ci-node-test-plan.test-support.js";

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

it("keeps direct volume bound to the real source config instead of its canonical remap", () => {
  const canonical = "test/vitest/vitest.auto-reply-core.config.ts";
  const source = "test/vitest/vitest.auto-reply.config.ts";
  const target = expectDefined(listNodeTestConfigFiles(canonical)?.[0], "canonical target");
  expect(buildVitestRunPlans([target]).map((plan) => plan.config)).toEqual([source]);
  expect(resolveCanonicalNodeTestConfig(target, source)).toBe(canonical);
  const jobs = expectDefined(
    createChangedNodeTestShards([target], {
      selectedTestTargets: [target],
      volumeContext: {
        revision: "a".repeat(40),
        runtimePolicy: "node",
        eligibility: {
          changedPaths: [target],
          includeReleaseOnlyRuntimeTests: false,
          includePrExemptRuntimeTests: false,
        },
        fullPlan: () =>
          createNodeTestShardBundles({
            changedPaths: [target],
            includeReleaseOnlyRuntimeTests: false,
            includePrExemptRuntimeTests: false,
            includeReleaseOnlyPluginShards: false,
            includeReleaseOnlyToolingShards: false,
            includeProofTests: false,
            compactMode: "pull-request",
          }),
      },
    }),
    "planned jobs",
  );
  const direct = expectDefined(
    jobs.find((job) => job.targets?.includes(target)),
    "direct job",
  );
  expect(direct.targets).toEqual([target]);
  expect(direct.targetVolumes).toEqual([
    {
      target,
      configs: [source],
      // The full schedule uses the canonical config. It is not a source-config oracle.
      volume: expect.objectContaining({ entries: [] }),
    },
  ]);
});

it("matches runtime-config execution inventory without changing canonical ownership", () => {
  const config = "test/vitest/vitest.runtime-config.config.ts";
  const files = expectDefined(listNodeTestVolumeConfigFiles(config), "runtime-config inventory");
  expect(files.toSorted()).toEqual(
    listMatchedTestFiles(createRuntimeConfigVitestConfig({})).toSorted(),
  );
  expect(files).toContain("src/config/io.load-async.test.ts");
  expect(files).not.toContain("src/config/sessions/session-canonical-key.test.ts");
  expect(files).not.toContain("src/plugins/loader.runtime-registry.test.ts");
  expect(listNodeTestConfigFiles(config)).toBeUndefined();
});

it("matches isolated-unit execution inventory including both observed direct targets", () => {
  const config = "test/vitest/vitest.unit-fast-isolated.config.ts";
  const files = expectDefined(listNodeTestVolumeConfigFiles(config), "isolated-unit inventory");
  expect(files.toSorted()).toEqual(
    listMatchedTestFiles(createUnitFastIsolatedVitestConfig({}, { argv: [] })).toSorted(),
  );
  expect(files).toEqual(
    expect.arrayContaining([
      "test/scripts/ci-workflow-ui-full.test.ts",
      "test/scripts/type-suppression-inventory.test.ts",
    ]),
  );
  expect(listNodeTestConfigFiles(config)).toBeUndefined();
});

it.each(
  (["node", "bun-all", "dual-all"] as const).flatMap((policy) => [
    {
      policy,
      owner: "runtime-config",
      config: "test/vitest/vitest.runtime-config.config.ts",
      targets: ["src/config/io.load-async.test.ts"],
    },
    {
      policy,
      owner: "isolated-unit",
      config: "test/vitest/vitest.unit-fast-isolated.config.ts",
      targets: [
        "test/scripts/ci-workflow-ui-full.test.ts",
        "test/scripts/type-suppression-inventory.test.ts",
      ],
    },
  ]),
)(
  "measures $owner only against its scheduled full profile under $policy",
  ({ policy, config, targets }) => {
    const full = createNodeTestShardBundles({
      compactMode: "pull-request",
      runnerBackend: "hybrid",
      changedPaths: targets,
      includeReleaseOnlyRuntimeTests: false,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyToolingShards: false,
      includeProofTests: false,
    });
    const scheduled = expectDefined(
      full
        .flatMap((job) => job.groups)
        .find(
          (group) =>
            group.configs.includes(config) &&
            targets.every(
              (target) => !group.includePatterns || group.includePatterns.includes(target),
            ),
        ),
      "scheduled full group",
    );
    const selected = { ...scheduled, configs: [config], includePatterns: targets };
    const context = {
      ...volumeContextFor([], policy),
      eligibility: {
        changedPaths: targets,
        includeReleaseOnlyRuntimeTests: false,
        includePrExemptRuntimeTests: false,
      },
      fullPlan: () => full,
    };
    const describe = prepareNodeTestVolumes(context);
    const entries = describe(selected, targets).entries;
    expect(entries.map((entry) => entry.runtime).toSorted()).toEqual(
      policy === "dual-all" ? ["bun", "node"] : [policy === "node" ? "node" : "bun"],
    );
    for (const entry of entries) {
      expect(entry.selected?.count).toBe(targets.length);
      expect(entry.full?.count).toBeGreaterThan(0);
      expect(entry.full?.id).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(
      describe({ ...selected, env: { ...selected.env, SCENARIO: "other" } }, targets).entries.map(
        (entry) => entry.full,
      ),
    ).toEqual(entries.map(() => null));
    const missing = prepareNodeTestVolumes({ ...context, fullPlan: undefined });
    expect(missing(selected, targets).entries).toEqual(
      entries.map((entry) => Object.assign({}, entry, { full: null })),
    );
    const repeated = prepareNodeTestVolumes({ ...context, fullPlan: () => [...full, ...full] });
    expect(repeated(selected, targets).entries).toEqual(entries);
  },
);

it("adds isolated-unit direct volumes without changing executable plans", () => {
  const targets = [
    "test/scripts/ci-workflow-ui-full.test.ts",
    "test/scripts/type-suppression-inventory.test.ts",
  ];
  const options = { selectedTestTargets: targets, runnerBackend: "hybrid" };
  const baseline = createChangedNodeTestShards(targets, options);
  const result = expectDefined(
    createChangedNodeTestShards(targets, {
      ...options,
      volumeContext: {
        ...volumeContextFor([]),
        fullPlan: () =>
          createNodeTestShardBundles({
            changedPaths: targets,
            compactMode: "pull-request",
            runnerBackend: "hybrid",
            includeReleaseOnlyToolingShards: false,
            includeReleaseOnlyPluginShards: false,
            includeProofTests: false,
          }),
      },
    }),
    "planned jobs",
  );
  for (const target of targets) {
    const row = result
      .flatMap((job) => job.targetVolumes ?? [])
      .find((entry) => entry.target === target);
    expect(row?.configs).toEqual(["test/vitest/vitest.unit-fast-isolated.config.ts"]);
    expect(row?.volume.entries[0]?.selected?.count).toBe(1);
    expect(row?.volume.entries[0]?.full).not.toBeNull();
  }
  const stripped = structuredClone(result);
  for (const job of stripped) {
    delete job.targetVolumes;
    for (const group of job.groups ?? []) {
      delete group.volume;
    }
  }
  expect(JSON.stringify(stripped)).toBe(JSON.stringify(baseline));
});

it("does not invent runtime-config membership or an infra baseline for direct targets", () => {
  const config = "test/vitest/vitest.runtime-config.config.ts";
  const target = "src/config/io.load-async.test.ts";
  const other = volumeGroup([config], ["src/config/io.compat.test.ts"]);
  const describe = prepareNodeTestVolumes(volumeContextFor([other]));
  const selected = describe(volumeGroup([config], [target]), [target]).entries;
  expect(selected).toHaveLength(1);
  expect(selected[0]?.selected?.count).toBe(1);
  expect(selected[0]?.full).toBeNull();
  const excluded = "src/config/sessions/session-canonical-key.test.ts";
  expect(describe(volumeGroup([config], [excluded]), [excluded]).entries).toEqual([]);
  const plugin = "src/plugins/loader.runtime-registry.test.ts";
  expect(
    describe(volumeGroup(["test/vitest/vitest.infra.config.ts"], [plugin]), [plugin]).entries,
  ).toEqual([]);
});
