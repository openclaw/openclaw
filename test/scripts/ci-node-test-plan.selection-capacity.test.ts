import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createChangedNodeTestShards } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { routeBoatNodeTestJobs } from "../../scripts/lib/ci-node-test-capacity.mts";
import {
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  type NodeTestShard,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { parseCompactSplitTimingKey } from "../../scripts/lib/vitest-shard-metadata.mts";

const preparedWorkspace = "src/node-host/node-worker-prepared-workspace.test.ts";
const preparedCompanion = "src/cli/update-cli/update-repair-cancellation.test.ts";
const planFiles = (
  job: Pick<NodeTestShard, "includePatterns" | "groups"> & { targets?: string[] },
) => [
  ...(job.includePatterns ?? job.targets ?? []),
  ...(job.groups ?? []).flatMap((group) => group.includePatterns ?? []),
];

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
  // Selection may serialize singleton owners to share setup, without increasing
  // any original job's concurrency or its child worker allowance.
  for (const job of selected) {
    expect(job.requiresDist).toBe(false);
    expect([1, 2]).toContain(job.planConcurrency);
    for (const group of job.groups) {
      const original = expectDefined(
        full.find((owner) => owner.groups.some((entry) => entry.shard_name === group.shard_name)),
        "canonical compact owner",
      );
      expect(job.planConcurrency).toBeLessThanOrEqual(original.planConcurrency ?? 1);
      expect(job.runner).toBe(
        job.planConcurrency === 1
          ? "blacksmith-16vcpu-ubuntu-2404"
          : "blacksmith-32vcpu-ubuntu-2404",
      );
      expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? String(group.fallbackMaxWorkers)).toBe("2");
    }
  }
});

it("maps unaffected Boat plans without changing hybrid groups, packing, or timings", () => {
  const compilerTargets = [
    "test/scripts/run-vitest-bounded.test.ts",
    "test/scripts/run-vitest-state-cleanup.test.ts",
    "test/scripts/vitest-worker-artifacts.test.ts",
    "test/scripts/test-projects-empty-native.test.ts",
  ];
  const targets = [
    "src/gateway/mcp-app-extension-runtime.test.ts",
    "src/agents/cli-runner.helpers.test.ts",
    ...compilerTargets,
  ];
  const expectedCapacity: Record<string, [string, number]> = {
    "blacksmith-4vcpu-ubuntu-2404": ["boat", 2],
    "blacksmith-8vcpu-ubuntu-2404": ["boat", 2],
    "blacksmith-16vcpu-ubuntu-2404": ["boat-large", 4],
    "blacksmith-32vcpu-ubuntu-2404": ["boat-xlarge", 8],
  };
  const expectedJob = <
    T extends Pick<NodeTestShard, "runner" | "checkName" | "groups" | "includePatterns">,
  >(
    job: T,
  ) => {
    const capacity = expectedCapacity[job.runner];
    const compilesWorkers = [
      ...(job.includePatterns ?? []),
      ...(job.groups ?? []).flatMap((group) => group.includePatterns ?? []),
    ].some((file) => compilerTargets.includes(file));
    const promoted =
      job.runner === "blacksmith-8vcpu-ubuntu-2404" &&
      ["checks-node-compact-large-9", "checks-node-compact-large-5"].includes(job.checkName);
    return promoted
      ? { ...job, runner: "boat-large", cpuBudget: 4 }
      : capacity
        ? {
            ...job,
            runner: capacity[0] === "boat" && compilesWorkers ? "boat-large" : capacity[0],
            cpuBudget: capacity[1],
          }
        : job;
  };
  for (const compactMode of [undefined, "pull-request", "push"] as const) {
    const options = {
      compactMode,
      includeProofTests: false,
      includeReleaseOnlyPluginShards: false,
    };
    const hybrid = createNodeTestShardBundles({ ...options, runnerBackend: "hybrid" });
    const boat = createNodeTestShardBundles({ ...options, runnerBackend: "boat" });
    for (const original of hybrid.filter((job) => !planFiles(job).includes(preparedWorkspace))) {
      expect(boat.find((job) => job.checkName === original.checkName)).toEqual(
        expectedJob(original),
      );
    }
  }
  for (const plan of [createSelectedNodeTestShardBundles, createChangedNodeTestShards]) {
    const hybrid = expectDefined(plan(targets, { runnerBackend: "hybrid" }), "hybrid selection");
    const boat = expectDefined(plan(targets, { runnerBackend: "boat" }), "Boat selection");
    expect(boat).toEqual(hybrid.map(expectedJob));
  }
});

it.each(["noncompact", "pull-request", "push", "selected", "changed"] as const)(
  "isolates prepared workspace on hosted runners in the %s plan",
  (mode) => {
    const plan = (runnerBackend: string) =>
      mode === "selected" || mode === "changed"
        ? expectDefined(
            (mode === "selected"
              ? createSelectedNodeTestShardBundles
              : createChangedNodeTestShards)([preparedWorkspace, preparedCompanion], {
              runnerBackend,
            }),
            "prepared selection",
          )
        : createNodeTestShardBundles({
            runnerBackend,
            compactMode: mode === "noncompact" ? undefined : mode,
            includeProofTests: false,
            includeReleaseOnlyPluginShards: false,
          });
    const hybrid = plan("hybrid");
    const original = expectDefined(
      hybrid.find((job) => planFiles(job).includes(preparedWorkspace)),
      "original owner",
    );
    const boat = plan("boat");
    const hosted = expectDefined(
      boat.find((job) => planFiles(job).includes(preparedWorkspace)),
      "hosted owner",
    );
    expect(boat.flatMap(planFiles).toSorted()).toEqual(hybrid.flatMap(planFiles).toSorted());
    expect(planFiles(hosted)).toEqual([preparedWorkspace]);
    expect(hosted.runner).toBe("ubuntu-24.04");
    expect(hosted.cpuBudget).toBe(original.runner === "blacksmith-32vcpu-ubuntu-2404" ? 8 : 2);
    expect(hosted.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
    expect(hosted.planConcurrency).toBe(1);
    expect(hosted.timeoutMinutes).toBe(original.timeoutMinutes);
    expect(hosted.pretestBuildMode).toBe(original.pretestBuildMode);
    expect(hosted.requiresDist).toBe(original.requiresDist);
    expect(hosted.predictedSeconds).toBeUndefined();
    expect(
      boat.some(
        (job) => job.runner.startsWith("boat") && planFiles(job).includes(preparedCompanion),
      ),
    ).toBe(true);
    if (planFiles(original).length === 1) {
      expect(boat.some((job) => job.checkName === original.checkName)).toBe(false);
      expect(boat).toHaveLength(hybrid.length);
      expect(hosted.groups).toEqual(original.groups);
      expect(hosted.timing_key).toBe(original.timing_key);
      return;
    }
    const retained = expectDefined(
      boat.find((job) => job.checkName === original.checkName),
      "retained mixed owner",
    );
    expect(boat).toHaveLength(hybrid.length + 1);
    expect(retained.predictedSeconds).toBe(original.predictedSeconds);
    expect(retained.runner).toMatch(/^boat/u);
    const sourceGroup = original.groups?.find((group) =>
      group.includePatterns?.includes(preparedWorkspace),
    );
    const source = sourceGroup ?? original;
    const remaining =
      retained.groups?.find((group) => group.shard_name === sourceGroup?.shard_name) ?? retained;
    const extracted = hosted.groups?.[0] ?? hosted;
    if (sourceGroup) {
      expect(hosted.groups?.[0]?.configs).toEqual(sourceGroup.configs);
    }
    if (source.includePatterns?.length === 1) {
      expect(extracted).toEqual(source);
    } else {
      expect(extracted.timing_key).not.toBe(source.timing_key);
      expect(remaining.timing_key).not.toBe(source.timing_key);
    }
    for (const group of original.groups ?? []) {
      if (!group.includePatterns?.includes(preparedWorkspace)) {
        expect(retained.groups).toContainEqual(group);
      }
    }
  },
);

it("keeps singleton replacement and mixed workspace extraction within the existing job cap", () => {
  const owner: NodeTestShard = {
    checkName: "checks-node-workspace",
    shardName: "workspace",
    runner: "blacksmith-8vcpu-ubuntu-2404",
    configs: ["test/vitest/vitest.infra.config.ts"],
    includePatterns: [preparedWorkspace, preparedCompanion],
    requiresDist: false,
  };
  const source = [owner];
  const singleton = { ...owner, includePatterns: [preparedWorkspace], timing_key: "selected" };
  const replacement = routeBoatNodeTestJobs([singleton], 1);
  expect(replacement).toHaveLength(1);
  expect(replacement[0]).toMatchObject({
    includePatterns: [preparedWorkspace],
    timing_key: "selected",
  });
  const snapshot = JSON.stringify(source);
  expect(() => routeBoatNodeTestJobs(source, source.length)).toThrow(/exceeds.*jobs/u);
  const routed = routeBoatNodeTestJobs(source, source.length + 1);
  expect(routed.map((job) => job.includePatterns)).toEqual([
    [preparedCompanion],
    [preparedWorkspace],
  ]);
  const [retainedTiming, hostedTiming] = routed.map((job) =>
    expectDefined(parseCompactSplitTimingKey(job.timing_key!), "mixed timing generation"),
  );
  expect(retainedTiming).toMatchObject({ part: 1, expectedParts: 2, parentShardName: "workspace" });
  expect(hostedTiming).toEqual({ ...retainedTiming, part: 2 });
  expect(JSON.stringify(source)).toBe(snapshot);
  for (const [inherited, expected] of [
    ["1", "1"],
    ["2", "2"],
    ["8", "2"],
  ] as const) {
    const parents = source.map((job) =>
      Object.assign({}, job, { env: { OPENCLAW_VITEST_MAX_WORKERS: inherited } }),
    );
    const rows = routeBoatNodeTestJobs(parents);
    expect(
      rows.find((job) => job.runner === "ubuntu-24.04")?.env?.OPENCLAW_VITEST_MAX_WORKERS,
    ).toBe(expected);
    expect(
      rows.find((job) => job.runner.startsWith("boat"))?.env?.OPENCLAW_VITEST_MAX_WORKERS,
    ).toBe(inherited);
  }
});

it.each(["checks-node-compact-large-9", "checks-node-compact-large-5"])(
  "retains the existing 4-CPU physical promotion for %s",
  (checkName) => {
    const job = {
      checkName,
      shardName: checkName,
      requiresDist: false,
      runner: "blacksmith-8vcpu-ubuntu-2404",
      configs: ["test/vitest/vitest.unit-fast.config.ts"],
    };
    expect(routeBoatNodeTestJobs([job])).toEqual([{ ...job, runner: "boat-large", cpuBudget: 4 }]);
  },
);

it("retains the selected board-store memory floor without widening its CPU budget", () => {
  const targets = ["src/gateway/board-store.test.ts"];
  const hybrid = expectDefined(
    createSelectedNodeTestShardBundles(targets, { runnerBackend: "hybrid" }),
    "hybrid board-store selection",
  );
  const boat = expectDefined(
    createSelectedNodeTestShardBundles(targets, { runnerBackend: "boat" }),
    "Boat board-store selection",
  );
  expect(hybrid).toHaveLength(1);
  expect(hybrid[0]?.runner).toBe("blacksmith-16vcpu-ubuntu-2404");
  expect(boat).toEqual([{ ...hybrid[0], runner: "boat-xlarge", cpuBudget: 4 }]);
  expect(boat[0]?.groups[0]?.minTotalMemoryBytes).toBe(28 * 1024 ** 3);
});

it("shares selected serial setup within the shortest contributing timeout", () => {
  const serialTargets = [
    "src/gateway/server-methods/plugins.decisions.test.ts",
    "src/gateway/server-methods/plugins.retention.test.ts",
    "src/gateway/server-methods/plugins.runtime-owner.test.ts",
    "src/gateway/server-methods/plugins.test.ts",
    "src/gateway/server-methods/templates-add.test.ts",
    "src/gateway/server-methods/templates.test.ts",
    "src/gateway/server-plugin-reload.installed-package.test.ts",
  ];
  const targets = ["src/gateway/client-callsites.guard.test.ts", ...serialTargets];
  const selected = expectDefined(
    createSelectedNodeTestShardBundles(targets, {
      runnerBackend: "hybrid",
    }),
    "qualified serial selection",
  );
  const serial = expectDefined(
    selected.find((job) =>
      serialTargets.every((target) =>
        job.groups.some((group) => group.includePatterns?.includes(target)),
      ),
    ),
    "shared serial selection",
  );
  expect(serial).toMatchObject({
    runner: "blacksmith-32vcpu-ubuntu-2404",
    planConcurrency: 1,
  });
  expect(serial.timeoutMinutes ?? 60).toBe(60);
  expect(
    selected
      .flatMap((job) => job.groups.flatMap((group) => group.includePatterns ?? []))
      .toSorted(),
  ).toEqual(targets.toSorted());
});
