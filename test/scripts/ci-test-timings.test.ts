import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs, {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  type CompactNodeTestShard,
  type NodeTestShardGroup,
  createNodeTestShardBundles,
  createSelectedNodeTestShardBundles,
  isExclusiveCompactShardName,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { rebalanceRuntimeTestJobs } from "../../scripts/lib/ci-runtime-test-placement.mts";
import { refitTestTimings, type CiTimingRun } from "../../scripts/lib/ci-test-timings-refit.mts";
import {
  ciTestTimingsSchema,
  type CiTestTimings,
  type RuntimePlacementTiming,
} from "../../scripts/lib/ci-test-timings-schema.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import { createExtensionTestTimingKey } from "../../scripts/lib/extension-test-plan.mts";
import * as localCheckRuntime from "../../scripts/lib/local-check-runtime.mts";
import { createCompactSplitTimingGeneration } from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";
import { toolingProbeRuntimeEntrypoints } from "./tooling-probe-runtime.test-support.mts";

function uiLog(files: Record<string, number>, overhead = 0.6) {
  const body = Object.values(files).reduce((sum, value) => sum + value, 0);
  return [
    ...Object.entries(files).map(
      ([name, value]) =>
        `2026-08-27T23:00:00Z ✓ \u001b[32mui-e2e\u001b[0m ${name} (1 test) ${value * 1000}ms`,
    ),
    `Duration ${body + Object.keys(files).length * overhead}s (transform 1s, setup 2ms, import 3s, tests ${body}s, environment 1ms)`,
  ].join("\n");
}

function timingRun(id: number, logs: CiTimingRun["logs"]): CiTimingRun {
  return {
    id,
    createdAt: `2026-08-${String(20 + id).padStart(2, "0")}T23:00:00Z`,
    logs,
    completeInventory: true,
  };
}

function compactLog(seconds: number, key = "core-unit-src-security-2") {
  const end = new Date(Date.parse("2026-08-27T23:00:00Z") + seconds * 1000).toISOString();
  return [
    `2026-08-27T23:00:00.0000000Z [shard:${key}] begin`,
    `${end} [shard:${key}] end (exit 0)`,
    "2026-08-27T23:00:00Z [shard:failed] begin",
    `${end} [shard:failed] end (exit 1)`,
    "2026-08-27T23:00:00Z [shard:unfinished] begin",
    `${end} [shard:orphan] end (exit 0)`,
  ].join("\n");
}

const measuredFile = "ui/src/e2e/measured.e2e.test.ts";
const baseline: CiTestTimings = {
  compactGroupSeconds: { blacksmith: {}, github: {} },
  runtimePlacementTimings: { blacksmith: [], github: [] },
  repoE2eFileSeconds: {},
  source: "median of 2 successful main CI runs: 1, 2",
  toolingFileSeconds: { blacksmith: {}, github: {} },
  uiE2e: { fileSeconds: { [measuredFile]: 100 }, perFileOverheadSeconds: 0.6 },
  updatedAt: "2026-08-22",
  version: 1,
};

const sampleNow = "2026-08-28T12:00:00.000Z";

describe("runtime placement observations", () => {
  it("retains recorded runtime work when its current group gains a file", () => {
    const options = {
      compactMode: "push" as const,
      runnerBackend: "hybrid",
      includeReleaseOnlyPluginShards: false,
    };
    const groups = createNodeTestShardBundles(options).flatMap((job) => job.groups);
    const corpusFile = "src/config/state-startup-corpus.test.ts";
    const handoffFile = "src/infra/update-managed-service-handoff-lifecycle.test.ts";
    const corpus = groups.find((group) => group.includePatterns?.includes(corpusFile))!;
    const handoff = groups.find((group) => group.includePatterns?.includes(handoffFile))!;
    expect(corpus.includePatterns!.length).toBeGreaterThan(1);
    const observations = [
      { ...corpus, includePatterns: [corpusFile], seconds: 200 },
      { ...handoff, seconds: 300 },
    ];
    const runs = [1, 2].map((id) =>
      timingRun(
        id,
        observations.map(({ seconds, ...group }, index) => {
          const descriptor = {
            ...group,
            shard_name: `recorded-runtime-${index}`,
            timing_key: undefined,
          };
          const [begin, end] = compactLog(seconds, descriptor.shard_name).split("\n");
          return {
            kind: "compact" as const,
            labels: ["blacksmith-4vcpu-ubuntu-2404"],
            text: [
              `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([descriptor])}`,
              begin,
              `2026-08-27T23:00:01Z [shard:${descriptor.shard_name}] [test] preparing runtime runtime before Vitest workers`,
              end,
            ].join("\n"),
          };
        }),
      ),
    );
    const data = refitTestTimings(runs).timings;
    const original = fs.readFileSync;
    const timingPath = fileURLToPath(new URL("../../config/ci-test-timings.json", import.meta.url));
    const read = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation((file, readOptions) =>
        (file instanceof URL ? fileURLToPath(file) : file) === timingPath
          ? JSON.stringify(data)
          : original(file, readOptions),
      );
    syncBuiltinESMExports();
    try {
      const plan = createNodeTestShardBundles(options);
      const corpusJob = plan.find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(corpusFile)),
      );
      const handoffJob = plan.find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(handoffFile)),
      );
      expect(corpusJob).toBeDefined();
      expect(handoffJob).toBeDefined();
      // These recorded workloads exceed the shared 360s budget, including
      // preparation. Added files must not make the known reader appear cheap.
      expect(corpusJob).not.toBe(handoffJob);
    } finally {
      read.mockRestore();
      syncBuiltinESMExports();
    }
  });

  const reader = {
    configs: ["test/vitest/reader.config.ts"],
    env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    includePatterns: ["src/reader.test.ts"],
    pretestBuildMode: "runtime" as const,
  };
  it.each([
    { label: "added files", files: ["a.test.ts", "b.test.ts", "new.test.ts"], expected: 201 },
    { label: "same files reordered", files: ["b.test.ts", "a.test.ts"], expected: 201 },
    { label: "current subset", files: ["a.test.ts"], expected: undefined },
    { label: "different files", files: ["a.test.ts", "other.test.ts"], expected: undefined },
    { label: "glob selection", files: ["*.test.ts"], expected: undefined },
  ])("matches complete recorded workloads with $label", ({ files, expected }) => {
    expect(
      testTimings.resolveRuntimePlacementSeconds({ ...reader, includePatterns: files }, [
        { ...reader, includePatterns: ["a.test.ts", "b.test.ts"], seconds: 201 },
      ]),
    ).toBe(expected);
  });
  it("uses one contained estimate and lets a later exact measurement replace it", () => {
    const current = { ...reader, includePatterns: ["a.test.ts", "b.test.ts", "c.test.ts"] };
    const prior = [
      { ...reader, includePatterns: ["a.test.ts", "b.test.ts"], seconds: 201 },
      { ...reader, includePatterns: ["b.test.ts", "c.test.ts"], seconds: 180 },
    ];
    expect(testTimings.resolveRuntimePlacementSeconds(current, prior)).toBe(201);
    for (const observations of [
      [...prior, { ...current, seconds: 100 }],
      [{ ...current, seconds: 100 }, ...prior],
    ]) {
      expect(testTimings.resolveRuntimePlacementSeconds(current, observations)).toBe(100);
    }
  });
  it.each<Partial<Parameters<typeof testTimings.resolveRuntimePlacementSeconds>[0]>>([
    { configs: ["other.config.ts"] },
    { env: {} },
    { env: { OPENCLAW_VITEST_MAX_WORKERS: "3" } },
    { pretestBuildMode: "private-qa" as const },
  ])("does not borrow a contained observation across ownership %j", (change) => {
    expect(
      testTimings.resolveRuntimePlacementSeconds(
        { ...reader, ...change, includePatterns: [...reader.includePatterns, "new.test.ts"] },
        [{ ...reader, seconds: 201 }],
      ),
    ).toBeUndefined();
  });
  function runtimeLog(
    id: number,
    overrides: Partial<Omit<typeof reader, "pretestBuildMode">> & {
      pretestBuildMode?: "runtime" | "private-qa";
    } = {},
  ) {
    const group = { ...reader, ...overrides };
    const generation = createCompactSplitTimingGeneration({
      ...group,
      parentShardName: "fixture-parent",
      stripes: [group.includePatterns, [`src/ordinary-${id}.test.ts`]],
    });
    const descriptor = {
      ...group,
      shard_name: `reader-${id}`,
      timing_key: generation.timingKeys[0]!,
    };
    const sibling = {
      ...descriptor,
      shard_name: `ordinary-${id}`,
      includePatterns: [`src/ordinary-${id}.test.ts`],
      timing_key: generation.timingKeys[1]!,
    };
    const [begin, end] = compactLog(20, descriptor.timing_key).split("\n");
    return [
      `2026-08-27T23:00:00Z   OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([descriptor, sibling])}`,
      begin,
      `2026-08-27T23:00:01Z [shard:${descriptor.shard_name}] [test] preparing ${group.pretestBuildMode} runtime before Vitest workers`,
      end,
      compactLog(5, generation.timingKeys[1]!),
    ].join("\n");
  }
  const sample = (id: number, text: string) =>
    timingRun(id, [
      {
        kind: "compact",
        labels: ["blacksmith-8vcpu-ubuntu-2404"],
        text,
      },
    ]);

  it("retains runtime placement through sibling repartition without changing parent totals", () => {
    const first = sample(1, runtimeLog(1));
    const second = sample(
      2,
      runtimeLog(2)
        .split("\n")
        .map((line) => `job\tstep\t${line}`)
        .join("\n"),
    );
    expect(refitTestTimings([first]).timings.runtimePlacementTimings.blacksmith).toEqual([]);
    const result = refitTestTimings([first, second]).timings;
    expect(result.compactGroupSeconds.blacksmith).toEqual({ "fixture-parent": 25 });
    expect(result.runtimePlacementTimings.blacksmith).toEqual([{ ...reader, seconds: 20 }]);
    expect(
      refitTestTimings([{ ...first, logs: [...first.logs, ...first.logs] }]).timings
        .runtimePlacementTimings.blacksmith,
    ).toEqual([]);
  });

  it.each([
    { configs: ["test/vitest/different.config.ts"] },
    { env: { OPENCLAW_VITEST_MAX_WORKERS: "3" } },
    { includePatterns: ["src/different.test.ts"] },
    { pretestBuildMode: "private-qa" as const },
  ])("does not merge runtime placement with changed ownership %j", (change) => {
    const result = refitTestTimings([sample(1, runtimeLog(1)), sample(2, runtimeLog(2, change))]);
    expect(result.timings.runtimePlacementTimings.blacksmith).toEqual([]);
  });

  it.each(["failed", "missing readiness", "malformed descriptor"])(
    "rejects %s runtime placement evidence",
    (kind) => {
      const runs = [1, 2].map((id) => {
        let text = runtimeLog(id);
        if (kind === "failed") {
          text = text.replaceAll("end (exit 0)", "end (exit 1)");
        }
        if (kind === "missing readiness") {
          text = text
            .split("\n")
            .filter((line) => !line.includes("[test] preparing"))
            .join("\n");
        }
        if (kind === "malformed descriptor") {
          text = text.replace(/BASE64: \S+/u, "BASE64: invalid");
        }
        return sample(id, text);
      });
      expect(refitTestTimings(runs).timings.runtimePlacementTimings.blacksmith).toEqual([]);
    },
  );

  it("publishes fresh runtime observations when no split generation repeats", () => {
    withSamplerFixture(
      {
        runs: [samplerRun(1), samplerRun(2)],
        jobs: [1, 2].map((id) =>
          samplerJob(id * 10, id, {
            log: runtimeLog(id).split("\n").slice(0, 4).join("\n"),
          }),
        ),
      },
      (fixture) => {
        const result = fixture.invoke();
        expect(result.status, result.stderr).toBe(0);
        const timings = ciTestTimingsSchema.parse(JSON.parse(fixture.contents()));
        expect(timings.compactGroupSeconds.blacksmith).toEqual({});
        expect(timings.runtimePlacementTimings.blacksmith).toEqual([{ ...reader, seconds: 20 }]);
      },
    );
  });

  it.each(
    (["push", "pull-request"] as const).flatMap((compactMode) =>
      [false, true].map((gatewayRecipient) => ({ compactMode, gatewayRecipient })),
    ),
  )(
    "admits complete $compactMode runtime placement without changing inventories or precise capacity (Gateway recipient: $gatewayRecipient)",
    ({ compactMode, gatewayRecipient }) => {
      const originalShards = fullSuiteVitestShards.slice();
      const runtimeConfig = "test/vitest/vitest.runtime-config.config.ts";
      const infrastructure = "test/vitest/vitest.infra.config.ts";
      const gatewayFixtureConfig = "fixture-agentic-gateway-server-isolated.config.ts";
      const isExclusiveConfig = localCheckRuntime.isExclusiveCiTestConfig;
      // Model a Gateway recipient without borrowing a changing project inventory.
      const gatewayConfigSpy = gatewayRecipient
        ? vi
            .spyOn(localCheckRuntime, "isExclusiveCiTestConfig")
            .mockImplementation((config) =>
              isExclusiveConfig(
                config === gatewayFixtureConfig
                  ? "test/vitest/vitest.gateway-methods-isolated.config.ts"
                  : config,
              ),
            )
        : undefined;
      const configs = new Set([
        runtimeConfig,
        infrastructure,
        ...(gatewayRecipient ? [] : ["test/vitest/vitest.gateway-database-workers.config.ts"]),
      ]);
      // Keep full inventories, but make spare placement capacity independent of
      // growing production prices. Runtime observations below supply the overload.
      const compactCosts = new Proxy<Record<string, number>>(
        { "agentic-gateway-server-isolated": 30, "agentic-agents-core-subagents": 20 },
        {
          get: (target, key) =>
            typeof key === "string" ? (target[key] ?? 39) : Reflect.get(target, key),
        },
      );
      const compactSpy = vi
        .spyOn(testTimings, "readCompactGroupTimings")
        .mockReturnValue(compactCosts);
      const spy = vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
      const options = {
        compactMode,
        runnerBackend: "hybrid",
        includeReleaseOnlyPluginShards: false,
      };
      try {
        fullSuiteVitestShards.splice(
          0,
          fullSuiteVitestShards.length,
          ...originalShards
            .map((shard) => ({
              ...shard,
              projects: shard.projects.filter((config) => configs.has(config)),
            }))
            .filter((shard) => shard.projects.length > 0),
          ...(gatewayRecipient
            ? ["agentic-gateway-server-isolated", "agentic-agents-core-subagents"].map((name) => {
                const config = `fixture-${name}.config.ts`;
                return { name, config, projects: [config] };
              })
            : []),
        );
        const before = createNodeTestShardBundles(options);
        const runtimeGroups = before
          .flatMap((job) => job.groups)
          .filter((group) => group.pretestBuildMode === "runtime");
        expect(runtimeGroups).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              configs: expect.arrayContaining([runtimeConfig]),
              includePatterns: expect.arrayContaining(["src/config/state-startup-corpus.test.ts"]),
            }),
            expect.objectContaining({
              configs: expect.arrayContaining([infrastructure]),
              includePatterns: expect.arrayContaining([
                "src/infra/update-managed-service-handoff-lifecycle.test.ts",
              ]),
            }),
            ...(gatewayRecipient
              ? []
              : [
                  expect.objectContaining({
                    configs: expect.arrayContaining([
                      "test/vitest/vitest.gateway-database-workers.config.ts",
                    ]),
                    includePatterns: expect.arrayContaining([
                      "test/plugins/codex-model-catalog.gateway.test.ts",
                    ]),
                  }),
                ]),
          ]),
        );
        const selected = ["src/config/state-startup-corpus.test.ts"];
        const preciseBefore = createSelectedNodeTestShardBundles(selected, {
          runnerBackend: "hybrid",
        });
        const blacksmith: RuntimePlacementTiming[] = runtimeGroups.map((group) => ({
          configs: group.configs,
          env: group.env ?? {},
          includePatterns: group.includePatterns!,
          pretestBuildMode: "runtime",
          seconds: group.configs.includes(runtimeConfig)
            ? 180
            : group.includePatterns?.includes(
                  "src/infra/update-managed-service-handoff-lifecycle.test.ts",
                )
              ? 250
              : 20,
        }));
        spy.mockImplementation((profile) => (profile === "blacksmith" ? blacksmith : []));
        const after = createNodeTestShardBundles(options);
        if (compactMode === "pull-request") {
          expect(
            createNodeTestShardBundles({ ...options, compactMode: undefined, compact: true }),
          ).toEqual(after);
        }
        expect(createSelectedNodeTestShardBundles(selected, { runnerBackend: "hybrid" })).toEqual(
          preciseBefore,
        );
        const groups = (jobs: typeof before) =>
          jobs
            .flatMap((job) =>
              job.groups.map((group) =>
                JSON.stringify({
                  ...group,
                  timing_key: undefined,
                  env: {
                    ...group.env,
                    OPENCLAW_VITEST_MAX_WORKERS:
                      group.env?.OPENCLAW_VITEST_MAX_WORKERS ??
                      job.env?.OPENCLAW_VITEST_MAX_WORKERS ??
                      (job.planConcurrency === 2 ? "2" : undefined),
                  },
                }),
              ),
            )
            .toSorted();
        expect(groups(after)).toEqual(groups(before));
        expect(after.map((job) => [job.checkName, job.runner])).toEqual(
          before.map((job) => [job.checkName, job.runner]),
        );
        expect(after.reduce((sum, job) => sum + (job.planConcurrency ?? 1), 0)).toBeLessThanOrEqual(
          before.reduce((sum, job) => sum + (job.planConcurrency ?? 1), 0),
        );
        expect(
          after.filter((job) => job.pretestBuildMode === "runtime").length,
        ).toBeLessThanOrEqual(
          before.filter((job) => job.pretestBuildMode === "runtime").length + 1,
        );
        const changed = after.filter(
          (job, index) => JSON.stringify(job.groups) !== JSON.stringify(before[index]!.groups),
        );
        expect(changed).toHaveLength(2);
        if (gatewayRecipient) {
          const recipient = changed.find((job) =>
            before.some(
              (original) =>
                original.checkName === job.checkName &&
                original.groups.some((group) => group.configs.includes(gatewayFixtureConfig)) &&
                original.pretestBuildMode === undefined &&
                original.planConcurrency === 1,
            ),
          )!;
          expect(recipient, "serial Gateway recipient").toBeDefined();
          const original = before.find((job) => job.checkName === recipient.checkName)!;
          expect(recipient.env).toEqual(original.env);
          for (const group of original.groups) {
            expect(recipient.groups.find((entry) => entry.shard_name === group.shard_name)).toEqual(
              group,
            );
          }
        }
        for (const job of changed) {
          expect(job.predictedSeconds).toBeLessThanOrEqual(360);
          expect(job.planConcurrency).toBe(1);
          expect(job.groups.every((group) => !isExclusiveCompactShardName(group.shard_name))).toBe(
            true,
          );
        }
        const originalOwners = new Map(
          before.flatMap((job) => job.groups.map((group) => [group.shard_name, job.checkName])),
        );
        const crossing = changed.flatMap((job) =>
          job.groups
            .filter((group) => originalOwners.get(group.shard_name) !== job.checkName)
            .map((group) => Object.assign({}, group, { env: { ...job.env, ...group.env } })),
        );
        expect(crossing.length).toBeGreaterThan(0);
        for (const group of crossing) {
          const measuredGateway = gatewayRecipient && group.configs.includes(gatewayFixtureConfig);
          expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS, group.shard_name).toBe(
            measuredGateway ? "8" : "2",
          );
        }
        spy.mockImplementation((profile) =>
          profile === "blacksmith"
            ? blacksmith.filter((entry) => !entry.configs.includes(runtimeConfig))
            : [],
        );
        const unmeasured = createNodeTestShardBundles(options);
        expect(unmeasured.map((job) => [job.checkName, job.runner, job.groups])).toEqual(
          before.map((job) => [job.checkName, job.runner, job.groups]),
        );
        const readerJob = unmeasured.find((job) =>
          job.groups.some((group) => group.includePatterns?.includes(selected[0]!)),
        )!;
        // Known siblings cost 218s + a 39s cold floor, plus one 60s build.
        // The unknown reader still contributes positive cost within the 360s budget.
        expect(readerJob.predictedSeconds).toBeGreaterThan(317);
        expect(readerJob.predictedSeconds).toBeLessThanOrEqual(360);
        spy.mockImplementation((profile) =>
          profile === "blacksmith"
            ? blacksmith.map((entry) => Object.assign({}, entry, { seconds: 1_000 }))
            : [],
        );
        const unfit = createNodeTestShardBundles(options);
        expect(groups(unfit)).toEqual(groups(before));
        expect(unfit.map((job) => [job.checkName, job.runner, job.groups])).toEqual(
          before.map((job) => [job.checkName, job.runner, job.groups]),
        );
        expect(unfit.some((job) => (job.predictedSeconds ?? 0) > 360)).toBe(true);
      } finally {
        spy.mockRestore();
        compactSpy.mockRestore();
        gatewayConfigSpy?.mockRestore();
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
      }
    },
  );

  it.each(["medium", "strong"])(
    "preserves the runtime placement donor anchor against %s capacity",
    (recipientRunner) => {
      const group = (name: string, pinned = false): NodeTestShardGroup => ({
        shard_name: name,
        configs: ["test/vitest/reader.config.ts"],
        includePatterns: [`src/${name}.test.ts`],
        pretestBuildMode: "runtime",
        requiresDist: false,
        runner: "small",
        ...(pinned ? { env: { OPENCLAW_VITEST_MAX_WORKERS: "2" } } : {}),
      });
      const moved = group("moved", true);
      const retained = group("retained");
      const spare = group("spare");
      const job = (
        name: string,
        runner: string,
        groups: NodeTestShardGroup[],
      ): CompactNodeTestShard => ({
        checkName: name,
        shardName: name,
        runner,
        groups,
        requiresDist: false,
        pretestBuildMode: "runtime",
        planConcurrency: 1,
        predictedSeconds: 0,
      });
      const jobs = [
        job("donor", "strong", [moved, retained]),
        job("recipient", recipientRunner, [spare]),
      ];
      const cost = (groups: NodeTestShardGroup[]) =>
        100 + groups.reduce((sum, entry) => sum + (entry === spare ? 50 : 200), 0);
      rebalanceRuntimeTestJobs(jobs, {
        cost,
        admits: (groups) => groups.length > 0 && cost(groups) <= 440,
        runnerRank: ({ runner }) => ["small", "medium", "strong"].indexOf(runner),
        prepareRecipient: (recipient) => recipient.groups,
      });
      expect(jobs.map((entry) => entry.runner)).toEqual(["strong", recipientRunner]);
      expect(jobs.map((entry) => entry.groups)).toEqual(
        recipientRunner === "strong" ? [[retained], [spare, moved]] : [[moved, retained], [spare]],
      );
      expect(jobs.map((entry) => entry.predictedSeconds)).toEqual(
        recipientRunner === "strong" ? [300, 350] : [500, 150],
      );
    },
  );

  it("uses spare ordinary capacity when the retained donor makes both maxima equal", () => {
    const group = (name: string, runtime = true): NodeTestShardGroup => ({
      shard_name: name,
      configs: ["reader.config.ts"],
      includePatterns: [`src/${name}.test.ts`],
      requiresDist: false,
      runner: "same",
      ...(runtime
        ? { pretestBuildMode: "runtime", env: { OPENCLAW_VITEST_MAX_WORKERS: "2" } }
        : {}),
    });
    const moved = group("moved");
    const retained = group("retained");
    const spare = group("spare");
    const ordinary = group("ordinary", false);
    const job = (
      name: string,
      groups: NodeTestShardGroup[],
      runtime = true,
    ): CompactNodeTestShard => ({
      checkName: name,
      shardName: name,
      runner: "same",
      groups,
      requiresDist: false,
      planConcurrency: runtime ? 1 : 2,
      ...(runtime ? { pretestBuildMode: "runtime" } : {}),
    });
    const jobs = [
      job("donor", [moved, retained]),
      job("first-runtime", [spare]),
      job("ordinary", [ordinary], false),
    ];
    const weights: Record<string, number> = { moved: 100, retained: 330, spare: 80, ordinary: 50 };
    const cost = (groups: NodeTestShardGroup[]) =>
      100 + groups.reduce((sum, entry) => sum + weights[entry.shard_name]!, 0);
    rebalanceRuntimeTestJobs(jobs, {
      cost,
      admits: (groups) => groups.length > 0 && cost(groups) <= 440,
      runnerRank: () => 0,
      prepareRecipient: (recipient) =>
        recipient.planConcurrency === 2
          ? recipient.groups.map((entry) => ({
              ...entry,
              env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
            }))
          : recipient.groups,
    });
    expect(jobs.map((entry) => entry.groups.map((value) => value.shard_name))).toEqual([
      ["retained"],
      ["spare"],
      ["ordinary", "moved"],
    ]);
    expect(jobs[2]).toMatchObject({
      pretestBuildMode: "runtime",
      planConcurrency: 1,
      predictedSeconds: 250,
    });
    expect(jobs[2]!.groups.every((entry) => entry.env?.OPENCLAW_VITEST_MAX_WORKERS === "2")).toBe(
      true,
    );
  });
});

function samplerRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    path: ".github/workflows/ci.yml",
    run_attempt: 1,
    created_at: "2026-08-27T22:00:00Z",
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_sha: "a".repeat(40),
    ...overrides,
  };
}

function samplerJob(id: number, runId: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    run_id: runId,
    run_attempt: 1,
    head_sha: "a".repeat(40),
    name: "checks-node-compact-small (1)",
    status: "completed",
    conclusion: "success",
    labels: ["blacksmith-4vcpu-ubuntu-2404"],
    started_at: "2026-08-27T23:00:00Z",
    completed_at: "2026-08-27T23:10:00Z",
    log: compactLog(20),
    ...overrides,
  };
}

const toolingFile = "test/scripts/measured.test.ts";

function samplerToolingLog(seconds: number) {
  const shard = "core-tooling-1-hosted-1";
  const [begin, end] = compactLog(seconds + 1, shard).split("\n");
  return [
    `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([{ shard_name: shard, configs: ["test/vitest/vitest.tooling.config.ts"], includePatterns: [toolingFile] }])}`,
    begin,
    `2026-08-27T23:00:01Z [shard:${shard}] ✓ tooling ${toolingFile} (1 test) ${seconds * 1000}ms`,
    `2026-08-27T23:00:01Z [shard:${shard}] Duration ${seconds + 1}s`,
    end,
  ].join("\n");
}

type SamplerFixture = {
  observedAt?: string;
  runs: ReturnType<typeof samplerRun>[];
  jobs: ReturnType<typeof samplerJob>[];
  releaseRuns?: ReturnType<typeof samplerRun>[];
  toolingRuns?: ReturnType<typeof samplerRun>[];
  seedRuns?: Record<string, ReturnType<typeof samplerRun>>;
  runPages?: ReturnType<typeof samplerRun>[][];
  jobPages?: Record<string, ReturnType<typeof samplerJob>[][]>;
  jobTotals?: Record<string, number>;
  baseline?: CiTestTimings;
};

function withSamplerFixture(
  fixture: SamplerFixture,
  check: (context: {
    invoke: (
      dryRun?: boolean,
      count?: number,
      toolingRunIds?: number[],
    ) => SpawnSyncReturns<string>;
    contents: () => string;
    requests: () => string[][];
    original: string;
  }) => void,
) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-ci-refit-")));
  const fakeGh = path.join(directory, "gh");
  const output = path.join(directory, "timings.json");
  const requests = path.join(directory, "requests.jsonl");
  const clock = path.join(directory, "clock.cjs");
  const original = `${JSON.stringify(fixture.baseline ?? baseline, null, 2)}\n`;
  try {
    writeFileSync(output, original);
    writeFileSync(requests, "");
    writeFileSync(
      clock,
      `const OriginalDate = Date;
global.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [${JSON.stringify(sampleNow)}])); }
  static now() { return OriginalDate.parse(${JSON.stringify(fixture.observedAt ?? sampleNow)}); }
};\n`,
    );
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + "\\n");
const fixture = ${JSON.stringify(fixture)};
const endpoint = new URL(args[1], "https://api.github.com/");
const page = Number(endpoint.searchParams.get("page") || 1);
const size = Number(endpoint.searchParams.get("per_page") || 100);
const slice = rows => rows.slice((page - 1) * size, page * size);
if (args[1] === "--help") {
  console.log("--allow-escape-sequences");
} else if (endpoint.pathname.includes("/workflows/")) {
  const ci = endpoint.pathname.includes("/ci.yml/");
  const tooling = ci && endpoint.searchParams.get("event") === "pull_request";
  const main = ci && !tooling;
  const rows = tooling ? fixture.toolingRuns || [] : main ? fixture.runs : endpoint.pathname.includes("/openclaw-release-checks.yml/") ? fixture.releaseRuns || [] : [];
  const selected = main && fixture.runPages ? fixture.runPages[page - 1] || [] : slice(rows);
  console.log(JSON.stringify(args.at(-1).startsWith("[.workflow_runs") ? selected : {total_count: rows.length, workflow_runs: selected}));
} else if (endpoint.pathname.endsWith("/jobs")) {
  const match = endpoint.pathname.match(/\\/runs\\/(\\d+)(?:\\/attempts\\/(\\d+))?\\/jobs$/);
  if (!match) process.exit(2);
  const key = match[1] + ":" + (match[2] || "all");
  const rows = fixture.jobs.filter(job => job.run_id === Number(match[1]) && (!match[2] || job.run_attempt === Number(match[2])));
  const pages = fixture.jobPages?.[key];
  console.log(JSON.stringify({total_count: fixture.jobTotals?.[key] ?? rows.length, jobs: pages ? pages[page - 1] || [] : slice(rows)}));
} else if (endpoint.pathname.endsWith("/logs")) {
  const id = Number(endpoint.pathname.split("/").at(-2));
  const job = fixture.jobs.find(job => job.id === id);
  if (!job) process.exit(2);
  console.log(job.log);
} else if (/\\/actions\\/runs\\/\\d+$/.test(endpoint.pathname)) {
  const id = endpoint.pathname.split("/").at(-1);
  const run = fixture.seedRuns?.[id] || (fixture.toolingRuns || []).find(run => run.id === Number(id));
  if (!run) process.exit(2);
  console.log(JSON.stringify(run));
} else {
  console.error("Unexpected gh request", args);
  process.exit(2);
}\n`,
    );
    chmodSync(fakeGh, 0o755);
    check({
      original,
      contents: () => readFileSync(output, "utf8"),
      requests: () =>
        readFileSync(requests, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]),
      invoke: (dryRun = false, count = 2, toolingRunIds = []) =>
        spawnSync(
          process.execPath,
          [
            "--require",
            clock,
            ...resolveRuntimeWorkerArgv(
              resolveRuntimeWorkerUrl(toolingProbeRuntimeEntrypoints.ciRefitTestTimings),
              process.execPath,
            ),
            "--runs",
            String(count),
            "--repo",
            "fixture/repo",
            "--out",
            output,
            ...toolingRunIds.flatMap((id) => ["--tooling-run", String(id)]),
            ...(dryRun ? ["--dry-run"] : []),
          ],
          {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            encoding: "utf8",
            timeout: 30_000,
            env: { ...process.env, OPENCLAW_GH_BIN: fakeGh, GH_TOKEN: "fixture-token" },
          },
        ),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("rejects non-plain timing objects even when their fields are valid", () => {
  expect(() =>
    ciTestTimingsSchema.parse(
      Object.create({ inherited: true }, Object.getOwnPropertyDescriptors(baseline)),
    ),
  ).toThrow();
  expect(() =>
    ciTestTimingsSchema.parse({
      ...baseline,
      uiE2e: {
        ...baseline.uiE2e,
        fileSeconds: Object.create(
          { inherited: 1 },
          { measured: { value: 100, enumerable: true } },
        ),
      },
    }),
  ).toThrow();
});

describe("CI test timing refit", () => {
  it.each(["uiE2e", "repoE2e"] as const)(
    "ingests native %s reporters without losing case progress or suite hooks",
    async (kind) => {
      const { default: config } =
        kind === "uiE2e"
          ? await import("../vitest/vitest.ui-e2e.config.ts")
          : await import("../vitest/vitest.e2e.config.ts");
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const artifacts = path.join(root, ".artifacts");
      fs.mkdirSync(artifacts, { recursive: true });
      const directory = mkdtempSync(path.join(artifacts, "ci-ui-timings-"));
      const projectNames = [
        "ui-e2e-bundled",
        "ui-e2e-standalone",
        "ui-e2e-serial",
        "ui-e2e-serial-standalone",
      ];
      const files = (kind === "uiE2e" ? projectNames : ["first", "second"]).map(
        (name) => `ui/src/e2e/${name}.e2e.test.ts`,
      );
      const configFile = path.join(directory, "vitest.config.mjs");
      try {
        for (const file of files) {
          fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
          writeFileSync(
            path.join(directory, file),
            `import { setTimeout } from "node:timers/promises";
import { beforeAll, afterAll, it } from "vitest";
beforeAll(() => setTimeout(50));
afterAll(() => setTimeout(50));
it("reports completed case progress", () => {});
it.skip("retains skipped coverage", () => {});
it.todo("retains todo coverage");
`,
          );
        }
        writeFileSync(
          configFile,
          `export default ${JSON.stringify({
            root: directory,
            test: {
              ...(kind === "uiE2e"
                ? {
                    include: [],
                    projects: files.map((file, index) => ({
                      test: { name: projectNames[index], include: [file] },
                    })),
                  }
                : { include: files }),
              reporters: config.test?.reporters,
              fileParallelism: false,
            },
          })};\n`,
        );
        const runs = [1, 2].map((id) => {
          const result = spawnSync(
            process.execPath,
            ["scripts/run-vitest.mjs", "run", "--config", configFile, "--configLoader", "runner"],
            {
              cwd: root,
              encoding: "utf8",
              timeout: 30_000,
              env: { ...process.env, GITHUB_STEP_SUMMARY: path.join(directory, "summary.md") },
            },
          );
          expect(result.status, result.stderr || result.stdout).toBe(0);
          const text = stripVTControlCharacters(result.stdout);
          expect(text).toContain("> reports completed case progress");
          const nativeFileDurations = [...text.matchAll(/\.e2e\.test\.ts[^\n]*\)\s+(\d+)ms/gu)];
          expect(nativeFileDurations, text).toHaveLength(files.length);
          // Native file time includes both suite hooks, unlike the case-only verbose rows.
          expect(nativeFileDurations.every((match) => Number(match[1]) >= 90)).toBe(true);
          return timingRun(id, [{ kind, text: result.stdout }]);
        });
        const { timings } = refitTestTimings(runs);
        expect(kind === "uiE2e" ? timings.uiE2e.fileSeconds : timings.repoE2eFileSeconds).toEqual(
          Object.fromEntries(files.map((file) => [file, 1])),
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("accepts completed passed file summaries once, excluding failed, skipped and unfinished files", () => {
    const legacyFile = "ui/src/e2e/legacy.e2e.test.ts";
    const serialFile = "ui/src/e2e/serial.e2e.test.ts";
    const standaloneFile = "ui/src/e2e/standalone.e2e.test.ts";
    const serialStandaloneFile = "ui/src/e2e/serial-standalone.e2e.test.ts";
    const unnamedFile = "ui/src/e2e/unnamed.e2e.test.ts";
    const log = [
      `✓ |ui-e2e-bundled| ${measuredFile} (3 tests | 1 skipped | 1 todo) 4000ms`,
      `✓ \u001b[32mui-e2e-bundled\u001b[0m ${measuredFile} (3 tests | 1 skipped | 1 todo) 4000ms`,
      `✓ ui-e2e-serial ${serialFile} (1 test) 2000ms`,
      `✓ |ui-e2e| ${legacyFile} (1 test) 3000ms`,
      `✓ |ui-e2e-standalone| ${standaloneFile} (1 test) 5000ms`,
      `✓ ui-e2e-serial-standalone ${serialStandaloneFile} (1 test) 6000ms`,
      `✓ ${unnamedFile} (1 test) 7000ms`,
      "❯ ui-e2e ui/src/e2e/failed.e2e.test.ts (1 test | 1 failed) 20s",
      "❯ ui-e2e ui/src/e2e/timeout.e2e.test.ts (0 test) 30s",
      "↓ ui-e2e ui/src/e2e/skipped.e2e.test.ts (1 test | 1 skipped) 0ms",
      "Duration 63s (transform 1s, setup 1s, tests 57s, environment 0ms)",
      `✓ |ui-e2e-serial| ${serialFile} (1 test) 2000ms`,
      "Duration 4s (transform 1s, setup 1s, tests 2s, environment 0ms)",
      "✓ ui-e2e ui/src/e2e/unfinished.e2e.test.ts (1 test) 5s",
    ].join("\n");
    const runs = [1, 2].map((id) => timingRun(id, [{ kind: "uiE2e", text: log }]));
    expect(refitTestTimings(runs).timings.uiE2e).toEqual({
      fileSeconds: {
        [legacyFile]: 3,
        [measuredFile]: 4,
        [serialFile]: 2,
        [standaloneFile]: 5,
        [serialStandaloneFile]: 6,
        [unnamedFile]: 7,
      },
      perFileOverheadSeconds: 2,
    });
  });

  it.each([
    ["ui-e2e-bundled", "ui-e2e-serial", false],
    ["ui-e2e-standalone", "ui-e2e-serial-standalone", true],
    ["ui-e2e-real-gateway", "ui-e2e-serial-standalone", false],
    ["ui-e2e-real-gateway-standalone", "ui-e2e-serial-standalone", true],
  ] satisfies [string, string, boolean][])(
    "keeps %s weights without refitting %s overhead (mixed: %s)",
    (parallelProject, serialProject, mixed) => {
      const first = "ui/src/e2e/parallel-first.e2e.test.ts";
      const second = "ui/src/e2e/parallel-second.e2e.test.ts";
      const serialFile = "ui/src/e2e/serial.e2e.test.ts";
      const serialLine = `✓ |${serialProject}| ${serialFile} (1 test) 2000ms`;
      const parallel = [
        `✓ |${parallelProject}| ${first} (1 test) 4000ms`,
        `✓ ${parallelProject} ${second} (1 test) 4000ms`,
        ...(mixed ? [serialLine] : []),
        mixed
          ? "Duration 7s (transform 10%, setup 0%, tests 90%, environment 0%)"
          : "Duration 5s (transform 1s, setup 0ms, tests 8s, environment 0ms)",
      ].join("\n");
      const runs = [1, 2].map((id) => timingRun(id, [{ kind: "uiE2e", text: parallel }]));
      const parallelOnly = refitTestTimings(runs, baseline).timings.uiE2e;
      expect(parallelOnly.fileSeconds).toMatchObject({ [first]: 4, [second]: 4 });
      expect(parallelOnly.perFileOverheadSeconds).toBe(0.6);

      const serial = `${serialLine}\nDuration 3s (transform 10%, setup 0%, tests 90%, environment 0%)`;
      const runsWithSerial = [1, 2].map((id) =>
        timingRun(id, [{ kind: "uiE2e", text: `${parallel}\n${serial}` }]),
      );
      const withSerial = refitTestTimings(runsWithSerial, baseline).timings.uiE2e;
      expect(withSerial.fileSeconds).toMatchObject({ [first]: 4, [second]: 4, [serialFile]: 2 });
      expect(withSerial.perFileOverheadSeconds).toBe(1);
    },
  );

  it("refits Gateway file totals without counting cases, retries, or incomplete invocations", () => {
    const file = "src/gateway/gateway.test.ts";
    const text = [
      `✓ ${file} > body-only case 1ms`,
      `✓ ${file} (3 tests | 1 skipped | 1 todo) 4200ms`,
      `✓ ${file} (3 tests | 1 skipped | 1 todo) 4200ms`,
      "Duration 3s (transform 1s, setup 1ms, tests 4.2s, environment 0ms)",
      "✓ test/unfinished.e2e.test.ts (1 test) 50s",
    ].join("\n");
    const once = timingRun(1, [
      { kind: "repoE2e", text },
      { kind: "repoE2e", text },
    ]);
    expect(refitTestTimings([once]).timings.repoE2eFileSeconds).toEqual({});
    const result = refitTestTimings([once, timingRun(2, [{ kind: "repoE2e", text }])]);
    expect(result.timings.repoE2eFileSeconds).toEqual({ [file]: 4 });
    expect(result.timings.uiE2e).toEqual({ fileSeconds: {}, perFileOverheadSeconds: 0 });
  });

  it("records per-file medians without outliers or one-run weights and measures excluded overhead", () => {
    const pageFile = "ui/src/pages/settings/measured.e2e.test.ts";
    const singleFile = "ui/src/e2e/single.e2e.test.ts";
    const runs = [32, 34, 60, 33, 900].map((value, index) =>
      timingRun(index + 1, [
        { kind: "uiE2e", text: uiLog({ [measuredFile]: value, [pageFile]: 2 }, 0.64) },
      ]),
    );
    runs[0]!.logs.push({
      kind: "uiE2e",
      text: `ui-e2e ${singleFile} (20 tests) 3s\nui-e2e ${singleFile} (20 tests) 3s`,
    });

    const { timings } = refitTestTimings(runs);

    expect(timings.uiE2e).toEqual({
      fileSeconds: { [measuredFile]: 34, [pageFile]: 2 },
      perFileOverheadSeconds: 0.6,
    });
    expect(ciTestTimingsSchema.parse(timings)).toEqual(timings);
  });

  it("buckets successful compact spans by their job runner and excludes failed or incomplete spans", () => {
    const runs = [10, 20, 100].map((value, index) =>
      timingRun(index + 1, [
        {
          kind: "compact",
          labels: ["self-hosted", `blacksmith-${index === 0 ? 4 : 8}vcpu-ubuntu-2404`],
          text: compactLog(value),
        },
        {
          kind: "compact",
          labels: ["ubuntu-24.04"],
          text: `${compactLog(40 + index * 10)}\nBLACKSMITH_RUN_ID: misleading-log-text`,
        },
      ]),
    );

    expect(refitTestTimings(runs).timings.compactGroupSeconds).toEqual({
      blacksmith: { "core-unit-src-security-2": 15 },
      github: { "core-unit-src-security-2": 50 },
    });
  });

  it.each(["plugin bundle", "plugin singleton", "Doctor"] as const)(
    "refits complete explicit %s PR work without trusting ordinal or family names",
    (kind) => {
      const plugin = kind !== "Doctor";
      const configs = [
        plugin
          ? "test/vitest/vitest.extension-database-workers.config.ts"
          : "test/vitest/vitest.commands.config.ts",
      ];
      const files = plugin
        ? ["extensions/telegram/src/native-a.test.ts", "extensions/telegram/src/native-b.test.ts"]
        : ["src/commands/doctor-a.test.ts", "src/commands/doctor-b.test.ts"];
      const env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
      const parent = "changed-agentic-commands-doctor#file-parallel-2";
      const key = plugin
        ? createExtensionTestTimingKey(configs[0]!, files, env)!
        : createCompactSplitTimingGeneration({
            configs,
            env,
            parentShardName: parent,
            stripes: [files],
          }).timingKeys[0]!;
      const runs = [1, 2].map((id) => {
        const name = plugin ? `changed-extensions-config-${id * 20}` : parent;
        const descriptor = { configs, includePatterns: files.toReversed(), shard_name: name };
        const text = [
          "2026-08-27T23:00:00Z OPENCLAW_VITEST_MAX_WORKERS: 2",
          ...(kind === "plugin singleton"
            ? [
                `2026-08-27T23:00:00Z OPENCLAW_VITEST_SHARD_NAME: ${name}`,
                `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_CONFIGS_JSON: ${JSON.stringify(configs, null, 2)}`,
                `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: ${JSON.stringify(files, null, 2)}`,
                "2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_ENV_JSON: null",
              ]
            : [
                `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([descriptor])}`,
              ]),
          compactLog(id === 1 ? 180 : 220, name),
          // Nested tests cannot overwrite their containing job's resource/worker provenance.
          "2026-08-27T23:04:00Z [shard:fixture] OPENCLAW_VITEST_MAX_WORKERS: 8",
          `2026-08-27T23:04:01Z [shard:fixture] [shard:${name}] begin`,
          `2026-08-27T23:59:00Z [shard:fixture] [shard:${name}] end (exit 0)`,
          `2026-08-27T23:04:01Z [shard:fixture] job\tstep\t2026-08-27T23:04:01Z [shard:${name}] begin`,
          `2026-08-27T23:59:00Z [shard:fixture] job\tstep\t2026-08-27T23:59:00Z [shard:${name}] end (exit 0)`,
        ].join("\n");
        return Object.assign(
          timingRun(id, [
            { kind: "compact" as const, labels: ["blacksmith-8vcpu-ubuntu-2404"], text },
          ]),
          { completeInventory: false, pullRequestMergeRef: true },
        );
      });
      expect(refitTestTimings([runs[0]!, runs[0]!]).timings.compactGroupSeconds.blacksmith).toEqual(
        {},
      );
      const result = refitTestTimings(runs);
      expect(result.timings.compactGroupSeconds.blacksmith).toEqual({ [key]: 200 });
      expect(result.timings.runtimePlacementTimings.blacksmith).toEqual([]);
      if (plugin) {
        for (const run of runs) {
          run.completeInventory = true;
          run.pullRequestMergeRef = false;
        }
        expect(refitTestTimings(runs).timings.compactGroupSeconds.blacksmith).toEqual({
          [key]: 200,
        });
      }
    },
  );

  it.each([
    "missing workers",
    "duplicate descriptor",
    "glob",
    "duplicate file",
    "native shard",
    "partial runtime",
    "mismatched workers",
  ])("rejects unsplit PR timing with %s evidence", (reason) => {
    const key =
      reason === "mismatched workers" ? "doctor#file-parallel-2" : "changed-extensions-config-1";
    const group = {
      configs: ["test/vitest/vitest.extension-database-workers.config.ts"],
      includePatterns:
        reason === "glob"
          ? ["extensions/telegram/*.test.ts"]
          : ["extensions/telegram/native.test.ts"],
      shard_name: key,
      ...(reason === "native shard"
        ? { env: { OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--shard=1/2"]' } }
        : {}),
    };
    if (reason === "duplicate file") {
      group.includePatterns.push(group.includePatterns[0]!);
    }
    const text = [
      ...(reason === "missing workers"
        ? []
        : [
            `2026-08-27T23:00:00Z OPENCLAW_VITEST_MAX_WORKERS: ${reason === "mismatched workers" ? 8 : 2}`,
          ]),
      `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups(reason === "duplicate descriptor" ? [group, group] : [group])}`,
      compactLog(200, reason === "partial runtime" ? `node-subset:${key}` : key),
    ].join("\n");
    const runs = [1, 2].map((id) =>
      Object.assign(
        timingRun(id, [
          { kind: "compact" as const, labels: ["blacksmith-8vcpu-ubuntu-2404"], text },
        ]),
        { completeInventory: false, pullRequestMergeRef: true },
      ),
    );
    expect(refitTestTimings(runs).timings.compactGroupSeconds.blacksmith).toEqual({});
  });

  it("keeps mixed worker ceilings out of compact weights and keys runtime observations by their inherited ceiling", () => {
    const descriptor = {
      configs: ["test/vitest/reader.config.ts"],
      includePatterns: ["src/reader.test.ts"],
      shard_name: "reader",
      timing_key: createCompactSplitTimingGeneration({
        configs: ["test/vitest/reader.config.ts"],
        parentShardName: "reader-parent",
        stripes: [["src/reader.test.ts"]],
      }).timingKeys[0]!,
    };
    const previous: CiTestTimings = {
      ...baseline,
      compactGroupSeconds: {
        blacksmith: { [descriptor.timing_key]: 100, "reader-parent": 100 },
        github: {},
      },
    };
    const log = (workers: number, groupWorkers?: number, jobWorkers?: number) => {
      const [begin, end] = compactLog(40, descriptor.timing_key).split("\n");
      return [
        `2026-08-27T23:00:00Z OPENCLAW_VITEST_MAX_WORKERS: ${workers}`,
        `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_ENV_JSON: ${JSON.stringify(jobWorkers ? { OPENCLAW_VITEST_MAX_WORKERS: String(jobWorkers) } : null, null, 2)}`,
        `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([{ ...descriptor, ...(groupWorkers ? { env: { OPENCLAW_VITEST_MAX_WORKERS: String(groupWorkers) } } : {}) }])}`,
        begin,
        "2026-08-27T23:00:01Z [shard:reader] [test] preparing runtime runtime before Vitest workers",
        end,
      ].join("\n");
    };
    const runs = [2, 8, 8].map((workers, index) =>
      timingRun(index + 1, [
        { kind: "compact", labels: ["blacksmith-32vcpu-ubuntu-2404"], text: log(workers) },
        { kind: "compact", labels: ["ubuntu-24.04"], text: log(4) },
      ]),
    );
    const mixed = refitTestTimings(runs, previous);
    expect(mixed.timings.compactGroupSeconds).toEqual({
      blacksmith: previous.compactGroupSeconds.blacksmith,
      github: { [descriptor.timing_key]: 40, "reader-parent": 40 },
    });
    expect(mixed.rejectedWorkerKeys).toEqual({
      blacksmith: ["reader-parent", descriptor.timing_key].toSorted(),
      github: [],
    });
    expect(mixed.timings.runtimePlacementTimings.blacksmith).toEqual([
      {
        configs: descriptor.configs,
        includePatterns: descriptor.includePatterns,
        env: { OPENCLAW_VITEST_MAX_WORKERS: "8" },
        pretestBuildMode: "runtime",
        seconds: 40,
      },
    ]);
    // Both the job JSON and group pins can lower, but never raise, an inherited ceiling.
    const pinned = refitTestTimings(
      [log(8, 2), log(2, 8), log(8, 8, 2)].map((text, index) =>
        timingRun(index + 1, [
          { kind: "compact", labels: ["blacksmith-32vcpu-ubuntu-2404"], text },
        ]),
      ),
    );
    expect(pinned.rejectedWorkerKeys.blacksmith).toEqual([]);
    expect(pinned.timings.compactGroupSeconds.blacksmith).toEqual({
      [descriptor.timing_key]: 40,
      "reader-parent": 40,
    });
    expect(pinned.timings.runtimePlacementTimings.blacksmith[0]?.env).toEqual({
      OPENCLAW_VITEST_MAX_WORKERS: "2",
    });
    const subset = refitTestTimings(
      [log(8, 2), log(2, 8)].map((text, index) =>
        timingRun(index + 1, [
          {
            kind: "compact",
            labels: ["blacksmith-32vcpu-ubuntu-2404"],
            text: text.replaceAll(
              `[shard:${descriptor.timing_key}]`,
              `[shard:bun:${descriptor.timing_key}]`,
            ),
          },
        ]),
      ),
    );
    expect(subset.rejectedWorkerKeys.blacksmith).toEqual([]);
    expect(subset.timings.compactGroupSeconds.blacksmith).toEqual({
      [`bun:${descriptor.timing_key}`]: 40,
      "bun:reader-parent": 40,
    });
    expect(subset.timings.runtimePlacementTimings.blacksmith).toEqual([]);
    const admissionLog = log(8).replace(
      encodeNodeTestGroups([descriptor]),
      encodeNodeTestGroups([
        {
          ...descriptor,
          fallbackMaxWorkers: 2,
          minTotalMemoryBytes: 28 * 1024 ** 3,
        },
      ]),
    );
    for (const { label, gib, plans, cpus, runner, frozen, expected } of [
      {
        label: "qualified",
        gib: 32,
        plans: 1,
        cpus: 8,
        runner: "self-hosted",
        frozen: "false",
        expected: 8,
      },
      {
        label: "memory floor",
        gib: 27,
        plans: 1,
        cpus: 8,
        runner: "self-hosted",
        frozen: "false",
        expected: 2,
      },
      {
        label: "overlapping plans",
        gib: 32,
        plans: 2,
        cpus: 8,
        runner: "self-hosted",
        frozen: "false",
        expected: 2,
      },
      {
        label: "constrained CPU",
        gib: 32,
        plans: 1,
        cpus: 4,
        runner: "self-hosted",
        frozen: "false",
        expected: 2,
      },
      {
        label: "hosted",
        gib: 32,
        plans: 1,
        cpus: 8,
        runner: "github-hosted",
        frozen: "false",
        expected: 2,
      },
      {
        label: "frozen target",
        gib: 32,
        plans: 1,
        cpus: 8,
        runner: "self-hosted",
        frozen: "true",
        expected: 2,
      },
      {
        label: "missing resources",
        gib: undefined,
        plans: 1,
        cpus: 8,
        runner: "self-hosted",
        frozen: "false",
        expected: undefined,
      },
      {
        label: "missing runner",
        gib: 32,
        plans: 1,
        cpus: 8,
        runner: undefined,
        frozen: "false",
        expected: undefined,
      },
    ]) {
      const text = [
        ...(runner ? [`2026-08-27T23:00:00Z RUNNER_ENVIRONMENT: ${runner}`] : []),
        `2026-08-27T23:00:00Z FROZEN_TARGET: ${frozen}`,
        ...(gib
          ? [
              `2026-08-27T23:00:00Z [shard:resources] logicalCpuCount=${cpus} totalMemoryBytes=${gib * 1024 ** 3} requested plans=${plans} admitted plans=${plans}`,
            ]
          : []),
        admissionLog,
      ].join("\n");
      const result = refitTestTimings(
        [1, 2].map((id) =>
          timingRun(id, [{ kind: "compact", labels: ["blacksmith-32vcpu-ubuntu-2404"], text }]),
        ),
        previous,
      );
      expect(result.timings.compactGroupSeconds.blacksmith[descriptor.timing_key], label).toBe(
        expected === undefined ? 100 : 40,
      );
      expect(
        result.timings.runtimePlacementTimings.blacksmith[0]?.env.OPENCLAW_VITEST_MAX_WORKERS,
        label,
      ).toBe(expected?.toString());
      expect(result.rejectedWorkerKeys.blacksmith, label).toEqual(
        expected === undefined ? ["reader-parent", descriptor.timing_key].toSorted() : [],
      );
    }
    const wholeConfigLog = log(8).replace(
      encodeNodeTestGroups([descriptor]),
      encodeNodeTestGroups([
        {
          ...descriptor,
          includePatterns: undefined,
          fallbackMaxWorkers: 2,
          minTotalMemoryBytes: 28 * 1024 ** 3,
        },
      ]),
    );
    const wholeConfigRuns = [27, 32].map((gib, index) =>
      timingRun(index + 1, [
        {
          kind: "compact",
          labels: ["blacksmith-32vcpu-ubuntu-2404"],
          text: [
            "2026-08-27T23:00:00Z RUNNER_ENVIRONMENT: self-hosted",
            "2026-08-27T23:00:00Z FROZEN_TARGET: false",
            `2026-08-27T23:00:00Z [shard:resources] logicalCpuCount=8 totalMemoryBytes=${gib * 1024 ** 3} requested plans=1 admitted plans=1`,
            wholeConfigLog,
          ].join("\n"),
        },
      ]),
    );
    const whole = refitTestTimings(wholeConfigRuns, previous);
    expect(whole.timings.compactGroupSeconds.blacksmith).toEqual(
      previous.compactGroupSeconds.blacksmith,
    );
    expect(whole.rejectedWorkerKeys.blacksmith).toEqual(
      ["reader-parent", descriptor.timing_key].toSorted(),
    );
    expect(whole.timings.runtimePlacementTimings.blacksmith).toEqual([]);
    for (const suffix of ["#workers-4", "#file-parallel-4"]) {
      const namedKey = createCompactSplitTimingGeneration({
        configs: descriptor.configs,
        parentShardName: `reader${suffix}`,
        stripes: [descriptor.includePatterns],
      }).timingKeys[0]!;
      const namedLog = admissionLog
        .replace(
          encodeNodeTestGroups([
            { ...descriptor, fallbackMaxWorkers: 2, minTotalMemoryBytes: 28 * 1024 ** 3 },
          ]),
          encodeNodeTestGroups([
            {
              ...descriptor,
              timing_key: namedKey,
              env: { OPENCLAW_VITEST_MAX_WORKERS: "4" },
              fallbackMaxWorkers: 2,
              minTotalMemoryBytes: 28 * 1024 ** 3,
            },
          ]),
        )
        .replaceAll(`[shard:${descriptor.timing_key}]`, `[shard:${namedKey}]`);
      const previousNamed: CiTestTimings = {
        ...baseline,
        compactGroupSeconds: { blacksmith: { [namedKey]: 100 }, github: {} },
      };
      for (const gib of [27, 32]) {
        const text = [
          "2026-08-27T23:00:00Z RUNNER_ENVIRONMENT: self-hosted",
          "2026-08-27T23:00:00Z FROZEN_TARGET: false",
          `2026-08-27T23:00:00Z [shard:resources] logicalCpuCount=8 totalMemoryBytes=${gib * 1024 ** 3} requested plans=1 admitted plans=1`,
          namedLog,
        ].join("\n");
        const samples = [1, 2].map((id) =>
          timingRun(id, [{ kind: "compact", labels: ["blacksmith-32vcpu-ubuntu-2404"], text }]),
        );
        const result = refitTestTimings(samples, previousNamed);
        expect(result.timings.compactGroupSeconds.blacksmith[namedKey], `${suffix} ${gib}GiB`).toBe(
          gib === 27 ? 100 : 40,
        );
        expect(result.rejectedWorkerKeys.blacksmith.includes(namedKey)).toBe(gib === 27);
      }
    }
  });

  it("retains measured parent costs across split inventory changes without double-counting retries", () => {
    const parentShardName = "agentic-control-plane-agent-chat";
    const generations = [0, 1, 2].map((index) =>
      createCompactSplitTimingGeneration({
        parentShardName,
        configs: ["test/vitest/vitest.gateway-server.config.ts"],
        stripes: [["a.test.ts"], [`added-${index}.test.ts`]],
      }),
    );
    const runs = generations.map((generation, index) =>
      timingRun(
        index + 1,
        generation.timingKeys.flatMap((key, part) => [
          {
            kind: "compact" as const,
            labels: ["blacksmith-32vcpu-ubuntu-2404"],
            text: compactLog(100 + part * 100 + index * 10, key),
          },
          {
            kind: "compact" as const,
            labels: ["blacksmith-32vcpu-ubuntu-2404"],
            text: compactLog(100 + part * 100 + index * 10, key),
          },
          {
            kind: "compact" as const,
            labels: ["ubuntu-24.04"],
            text: compactLog(300 + part * 100, key),
          },
        ]),
      ),
    );
    const previous = {
      ...baseline,
      compactGroupSeconds: { blacksmith: { [parentShardName]: 167 }, github: {} },
    };
    // No child key has two independent run samples, but every run covers its
    // complete parent. Inventory growth must not erase that measured baseline.
    expect(refitTestTimings(runs, previous).timings.compactGroupSeconds).toEqual({
      blacksmith: { [parentShardName]: 320 },
      github: { [parentShardName]: 700 },
    });
    expect(refitTestTimings([runs[0]!]).timings.compactGroupSeconds).toEqual({
      blacksmith: {},
      github: {},
    });
  });

  it("does not promote selected PR generations into full-parent samples", () => {
    const parent = "changed-agentic-cli";
    const child = createCompactSplitTimingGeneration({
      configs: ["test/vitest/vitest.cli.config.ts"],
      parentShardName: parent,
      stripes: [["src/cli/selected.test.ts"]],
    }).timingKeys[0]!;
    const previous: CiTestTimings = {
      ...baseline,
      compactGroupSeconds: { blacksmith: { [parent]: 1_000 }, github: {} },
    };
    const runs = [20, 40, 60].map((seconds, index) =>
      Object.assign(
        timingRun(index + 1, [
          {
            kind: "compact",
            labels: ["blacksmith-8vcpu-ubuntu-2404"],
            text: `${compactLog(seconds, child)}\n${compactLog(600, parent)}`,
          },
        ]),
        { pullRequestMergeRef: true, completeInventory: false },
      ),
    );
    // Neither selected generations nor repeated unsplit PR spans prove the
    // full owner inventory. Only the exact selected child can refit.
    const expected = {
      [parent]: 1_000,
      [child]: 40,
    };
    expect(refitTestTimings(runs, previous).timings.compactGroupSeconds.blacksmith).toEqual(
      expected,
    );
    const fragments = runs.flatMap((run) => [{ ...run, pullRequestMergeRef: false }, run]);
    expect(refitTestTimings(fragments, previous).timings.compactGroupSeconds.blacksmith).toEqual(
      expected,
    );
    const main = runs.map((run) => Object.assign({}, run, { pullRequestMergeRef: false }));
    expect(refitTestTimings(main, previous).timings.compactGroupSeconds.blacksmith).toEqual({
      [parent]: 600,
      [child]: 40,
    });
  });

  it.each(["missing part", "different generation", "different profile", "different run"])(
    "does not invent a complete parent measurement from %s",
    (condition) => {
      const common = {
        parentShardName: "agentic-control-plane-agent-chat",
        configs: ["test/vitest/vitest.gateway-server.config.ts"],
      };
      const first = createCompactSplitTimingGeneration({
        ...common,
        stripes: [["a.test.ts"], ["b.test.ts"]],
      });
      const second = createCompactSplitTimingGeneration({
        ...common,
        stripes: [["b.test.ts"], ["a.test.ts"]],
      });
      const runs = [1, 2, 3].map((id) => {
        const logs: CiTimingRun["logs"] = [
          {
            kind: "compact",
            labels: ["blacksmith-32vcpu-ubuntu-2404"],
            text: compactLog(
              100,
              first.timingKeys[condition === "different run" ? (id - 1) % 2 : 0]!,
            ),
          },
        ];
        if (condition === "different generation" || condition === "different profile") {
          logs.push({
            kind: "compact",
            labels: [
              condition === "different profile" ? "ubuntu-24.04" : "blacksmith-32vcpu-ubuntu-2404",
            ],
            text: compactLog(
              200,
              (condition === "different generation" ? second : first).timingKeys[1]!,
            ),
          });
        }
        return timingRun(id, logs);
      });
      const result = refitTestTimings(runs).timings.compactGroupSeconds;
      expect(result.blacksmith).not.toHaveProperty(common.parentShardName);
      expect(result.github).not.toHaveProperty(common.parentShardName);
      const previous = {
        ...baseline,
        compactGroupSeconds: { blacksmith: { [common.parentShardName]: 500 }, github: {} },
      };
      expect(
        refitTestTimings(runs, previous).timings.compactGroupSeconds.blacksmith[
          common.parentShardName
        ],
      ).toBe(500);
    },
  );

  it.each([undefined, 900])(
    "counts complete repartitions as one parent sample alongside direct cost %s",
    (directSeconds) => {
      const parentShardName = "agentic-control-plane-agent-chat";
      const generations = [
        [["a.test.ts"], ["b.test.ts"]],
        [["b.test.ts"], ["a.test.ts"]],
      ].map((stripes) =>
        createCompactSplitTimingGeneration({
          parentShardName,
          configs: ["test/vitest/vitest.gateway-server.config.ts"],
          stripes,
        }),
      );
      const logs: CiTimingRun["logs"] = generations.flatMap((generation, index) =>
        generation.timingKeys.map((key) => ({
          kind: "compact" as const,
          labels: ["blacksmith-32vcpu-ubuntu-2404"],
          text: compactLog(index === 0 ? 150 : 350, key),
        })),
      );
      if (directSeconds !== undefined) {
        logs.push({
          kind: "compact",
          labels: ["blacksmith-32vcpu-ubuntu-2404"],
          text: compactLog(directSeconds, parentShardName),
        });
      }
      const runs = [timingRun(1, logs), timingRun(2, logs)];
      expect(refitTestTimings(runs).timings.compactGroupSeconds.blacksmith[parentShardName]).toBe(
        directSeconds ?? 700,
      );
      expect(
        refitTestTimings([runs[0]!]).timings.compactGroupSeconds.blacksmith,
      ).not.toHaveProperty(parentShardName);
    },
  );

  it.each([0, 2, 3])(
    "prunes absent keys only after at least three contributing runs per profile (%s)",
    (count) => {
      const previous: CiTestTimings = {
        ...baseline,
        compactGroupSeconds: {
          blacksmith: { observed: 20, deleted: 30 },
          github: { observed: 20, deleted: 40, "release-full-fixture": 900 },
        },
        uiE2e: {
          ...baseline.uiE2e,
          fileSeconds: { ...baseline.uiE2e.fileSeconds, "deleted.e2e.test.ts": 50 },
        },
      };
      const runs = [1, 2, 3].map((id) => {
        const logs: CiTimingRun["logs"] = [
          {
            kind: "compact",
            labels: ["blacksmith-4vcpu-ubuntu-2404"],
            text: compactLog(20, "observed"),
          },
        ];
        if (id <= count) {
          logs.push(
            { kind: "compact", labels: ["ubuntu-24.04"], text: compactLog(20, "observed") },
            { kind: "uiE2e", text: uiLog({ [measuredFile]: 100 }) },
          );
        }
        return timingRun(id, logs);
      });
      const { timings, changes } = refitTestTimings(runs, previous);
      expect(timings.compactGroupSeconds.blacksmith).toEqual({ observed: 20 });
      expect(timings.compactGroupSeconds.github).toEqual(
        count >= 3
          ? { observed: 20, "release-full-fixture": 900 }
          : previous.compactGroupSeconds.github,
      );
      expect(timings.uiE2e.fileSeconds).toEqual(
        count >= 3 ? { [measuredFile]: 100 } : previous.uiE2e.fileSeconds,
      );
      expect(changes).toEqual(
        count >= 3
          ? [
              { key: "compactGroupSeconds.blacksmith.deleted", old: 30, next: undefined },
              { key: "compactGroupSeconds.github.deleted", old: 40, next: undefined },
              { key: "uiE2e.fileSeconds.deleted.e2e.test.ts", old: 50, next: undefined },
            ]
          : [{ key: "compactGroupSeconds.blacksmith.deleted", old: 30, next: undefined }],
      );
    },
  );

  it.each(["missing", "unparseable"])(
    "preserves all profiles when three sampled runs have %s logs",
    (logs) => {
      const previous: CiTestTimings = {
        ...baseline,
        compactGroupSeconds: { blacksmith: { group: 50 }, github: { g1: 181, g2: 90 } },
      };
      const runs = [1, 2, 3].map((id) =>
        timingRun(
          id,
          logs === "missing" ? [] : [{ kind: "uiE2e", text: "No test results available" }],
        ),
      );
      expect(refitTestTimings(runs, previous)).toMatchObject({ timings: previous, changes: [] });
    },
  );

  it.each([false, true])(
    "retains absent timings when duplicate run fragments include partial inventories (partial first: %s)",
    (partialFirst) => {
      const previous: CiTestTimings = {
        ...baseline,
        compactGroupSeconds: { blacksmith: { observed: 10, retained: 90 }, github: {} },
      };
      const runs = [1, 2, 3].flatMap((id) => {
        const complete = timingRun(id, [
          {
            kind: "compact",
            labels: ["blacksmith-8vcpu-ubuntu-2404"],
            text: compactLog(40, "observed"),
          },
        ]);
        const partial = { ...complete, completeInventory: false };
        return partialFirst ? [partial, complete] : [complete, partial];
      });
      const result = refitTestTimings(runs, previous);
      expect(result.timings.compactGroupSeconds).toEqual({
        blacksmith: { observed: 40, retained: 90 },
        github: {},
      });
      expect(result.contributingRunIds.blacksmith).toEqual([1, 2, 3]);
      expect(result.changes).toEqual([
        { key: "compactGroupSeconds.blacksmith.observed", old: 10, next: 40 },
      ]);
    },
  );

  it("keeps keys observed in only one of three runs", () => {
    const otherFile = "ui/src/e2e/other.e2e.test.ts";
    const previous: CiTestTimings = {
      ...baseline,
      uiE2e: { ...baseline.uiE2e, fileSeconds: { [measuredFile]: 100, [otherFile]: 100 } },
      compactGroupSeconds: {
        blacksmith: { "core-unit-src-security-2": 30, other: 30 },
        github: { "core-unit-src-security-2": 30, other: 30 },
      },
    };
    const runs = [1, 2, 3].map((id) =>
      timingRun(
        id,
        id > 1
          ? [
              { kind: "uiE2e", text: uiLog({ [otherFile]: 100 }) },
              {
                kind: "compact",
                labels: ["blacksmith-4vcpu-ubuntu-2404"],
                text: compactLog(30, "other"),
              },
              { kind: "compact", labels: ["ubuntu-24.04"], text: compactLog(30, "other") },
            ]
          : [
              { kind: "uiE2e", text: uiLog({ [measuredFile]: 100 }) },
              { kind: "compact", labels: ["blacksmith-4vcpu-ubuntu-2404"], text: compactLog(30) },
              { kind: "compact", labels: ["ubuntu-24.04"], text: compactLog(30) },
            ],
      ),
    );
    expect(refitTestTimings(runs, previous)).toMatchObject({ timings: previous, changes: [] });
  });

  it.each([
    [85, 100],
    [115, 100],
    [84, 84],
    [116, 116],
  ])("only writes medians outside the inclusive 15%% band: %s becomes %s", (measured, expected) => {
    const previous = {
      ...baseline,
      uiE2e: {
        ...baseline.uiE2e,
        fileSeconds: { ...baseline.uiE2e.fileSeconds, "ui/src/e2e/absent.e2e.test.ts": 20 },
      },
    };
    const runs = [1, 2].map((id) =>
      timingRun(id, [{ kind: "uiE2e", text: uiLog({ [measuredFile]: measured }) }]),
    );
    const { timings, changes } = refitTestTimings(runs, previous);

    expect(timings.uiE2e.fileSeconds).toEqual({
      [measuredFile]: expected,
      "ui/src/e2e/absent.e2e.test.ts": 20,
    });
    expect(changes).toHaveLength(expected === 100 ? 0 : 1);
    if (expected === 100) {
      expect(timings.source).toBe(previous.source);
      expect(timings.updatedAt).toBe(previous.updatedAt);
    }
  });

  it("applies the overhead write threshold before rounding to a tenth", () => {
    const runs = [1, 2].map((id) =>
      timingRun(id, [{ kind: "uiE2e", text: uiLog({ [measuredFile]: 100 }, 0.69) }]),
    );
    const { timings, changes } = refitTestTimings(runs, baseline);
    expect(timings.uiE2e.perFileOverheadSeconds).toBe(0.6);
    expect(changes).toEqual([]);
  });

  it.each([
    [-2, 0],
    [8, 5],
  ])("clamps measured overhead %s to %s seconds", (measured, expected) => {
    const runs = [1, 2].map((id) =>
      timingRun(id, [{ kind: "uiE2e", text: uiLog({ [measuredFile]: 10 }, measured) }]),
    );
    expect(refitTestTimings(runs).timings.uiE2e.perFileOverheadSeconds).toBe(expected);
  });

  it("generates identical sorted data when equivalent runs, logs, and file rows arrive in different orders", () => {
    const files = { "ui/src/e2e/z.e2e.test.ts": 5, "ui/src/e2e/a.e2e.test.ts": 4 };
    const runtimeSpan = (id: number) => {
      const descriptor = {
        shard_name: "runtime-order",
        configs: ["test/vitest/vitest.runtime-config.config.ts"],
        env: id === 1 ? { FIXTURE_A: "1", FIXTURE_B: "2" } : { FIXTURE_B: "2", FIXTURE_A: "1" },
        includePatterns: id === 1 ? ["a.test.ts", "b.test.ts"] : ["b.test.ts", "a.test.ts"],
      };
      const [begin, end] = compactLog(20, descriptor.shard_name).split("\n");
      return [
        `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([descriptor])}`,
        begin,
        "2026-08-27T23:00:01Z [shard:runtime-order] [test] preparing runtime runtime before Vitest workers",
        end,
      ].join("\n");
    };
    const runs = [2, 1].map((id) =>
      timingRun(id, [
        {
          kind: "compact",
          labels: ["ubuntu-24.04"],
          text: `${compactLog(20)}\n${runtimeSpan(id)}`,
        },
        { kind: "uiE2e", text: uiLog(files) },
      ]),
    );
    const first = refitTestTimings(runs);
    const reordered = runs.toReversed().map((run) =>
      timingRun(run.id, [
        {
          kind: "uiE2e",
          text: uiLog(Object.fromEntries(Object.entries(files).toReversed())),
        },
        {
          kind: "compact",
          labels: ["ubuntu-24.04"],
          text: `${compactLog(20)}\n${runtimeSpan(run.id)}`,
        },
      ]),
    );

    expect(JSON.stringify(refitTestTimings(reordered))).toBe(JSON.stringify(first));
    expect(Object.keys(first.timings)).toEqual(Object.keys(first.timings).toSorted());
    expect(Object.keys(first.timings.uiE2e.fileSeconds)).toEqual([
      "ui/src/e2e/a.e2e.test.ts",
      "ui/src/e2e/z.e2e.test.ts",
    ]);
    expect(
      refitTestTimings(
        runs.map((run) => timingRun(run.id + 2, run.logs)),
        first.timings,
      ).timings,
    ).toEqual(first.timings);
  });
});

describe("CI timing sampler provenance", () => {
  const retained: CiTestTimings = {
    ...baseline,
    compactGroupSeconds: {
      blacksmith: { "core-unit-src-security-2": 20 },
      github: { retained: 90 },
    },
    runtimePlacementTimings: {
      blacksmith: [
        {
          configs: ["test/vitest/reader.config.ts"],
          env: {},
          includePatterns: ["src/reader.test.ts"],
          pretestBuildMode: "runtime",
          seconds: 80,
        },
      ],
      github: [],
    },
    repoE2eFileSeconds: { "test/retained.e2e.test.ts": 50 },
    toolingFileSeconds: {
      blacksmith: { [toolingFile]: 10, "test/scripts/unselected.test.ts": 70 },
      github: { [toolingFile]: 90 },
    },
  };

  it.each(["main", "release", "tooling"] as const)(
    "refills %s samples after a cohort completes beyond the frozen cutoff",
    (source) => {
      const sourceRuns = [1, 4, 5].map((id) =>
        samplerRun(id, {
          run_attempt: id === 1 ? 2 : 1,
          event:
            source === "main"
              ? "push"
              : source === "release"
                ? "workflow_dispatch"
                : "pull_request",
        }),
      );
      const sourceJob = (id: number, runId: number, overrides: Record<string, unknown> = {}) =>
        samplerJob(id, runId, {
          name: source === "release" ? "Repo E2E (Gateway 1/4)" : "checks-node-compact-small-1",
          log:
            source === "main"
              ? compactLog(40)
              : source === "tooling"
                ? samplerToolingLog(40)
                : "✓ test/release.e2e.test.ts (1 test) 40000ms\nDuration 40s",
          ...overrides,
        });
      withSamplerFixture(
        {
          observedAt: "2026-08-28T12:01:00.000Z",
          runs: source === "main" ? sourceRuns : [samplerRun(2), samplerRun(3)],
          ...(source === "release" ? { releaseRuns: sourceRuns } : {}),
          ...(source === "tooling" ? { toolingRuns: sourceRuns } : {}),
          jobs: [
            sourceJob(11, 1),
            sourceJob(12, 1, { run_attempt: 2, completed_at: "2026-08-28T12:00:30.000Z" }),
            sourceJob(41, 4),
            sourceJob(51, 5),
            ...(source === "main" ? [] : [samplerJob(21, 2), samplerJob(31, 3)]),
          ],
        },
        (fixture) => {
          const result = fixture.invoke();
          expect(result.status, result.stderr).toBe(0);
          const timings = ciTestTimingsSchema.parse(JSON.parse(fixture.contents()));
          expect(
            source === "main"
              ? timings.compactGroupSeconds.blacksmith["core-unit-src-security-2"]
              : source === "tooling"
                ? timings.toolingFileSeconds.blacksmith[toolingFile]
                : timings.repoE2eFileSeconds["test/release.e2e.test.ts"],
          ).toBe(40);
          expect(result.stderr).toContain(
            `Skipped ${source === "tooling" ? "pull-request" : source} run 1: jobs completed after frozen UTC cutoff ${sampleNow}.`,
          );
          const requests = fixture.requests();
          expect(requests.some((args) => args[1]?.includes("/runs/1/attempts/2/jobs?"))).toBe(true);
          expect(requests.some((args) => /\/jobs\/(?:11|12)\/logs$/u.test(args[1] ?? ""))).toBe(
            false,
          );
          expect(requests.some((args) => args[1]?.endsWith("/jobs/51/logs"))).toBe(true);
          for (const requestArgs of requests.filter((args) => args[1]?.includes("/workflows/"))) {
            const params = new URL(requestArgs[1]!, "https://api.github.com").searchParams;
            expect(params.get("created")).toBe(`2026-08-21T12:00:00.000Z..${sampleNow}`);
          }
        },
      );
    },
  );

  it("refuses an explicitly requested tooling run that completes after the frozen cutoff", () => {
    withSamplerFixture(
      {
        observedAt: "2026-08-28T12:01:00.000Z",
        runs: [],
        toolingRuns: [samplerRun(1, { event: "pull_request" })],
        jobs: [
          samplerJob(11, 1, { log: samplerToolingLog(40) }),
          samplerJob(12, 1, { completed_at: "2026-08-28T12:00:30.000Z" }),
        ],
      },
      (fixture) => {
        const result = fixture.invoke(false, 2, [1]);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(
          `Requested tooling run 1 has jobs completed after frozen UTC cutoff ${sampleNow}.`,
        );
        expect(fixture.requests().some((args) => args[1]?.endsWith("/logs"))).toBe(false);
        expect(fixture.contents()).toBe(fixture.original);
      },
    );
  });

  it("rejects corrupt provenance even when an earlier job is beyond the frozen cutoff", () => {
    withSamplerFixture(
      {
        observedAt: "2026-08-28T12:01:00.000Z",
        runs: [samplerRun(1)],
        jobs: [
          samplerJob(11, 1, { completed_at: "2026-08-28T12:00:30.000Z" }),
          samplerJob(12, 1, { head_sha: "b".repeat(40) }),
        ],
      },
      (fixture) => {
        const result = fixture.invoke();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("does not match its cohort");
        expect(fixture.requests().some((args) => args[1]?.endsWith("/logs"))).toBe(false);
        expect(fixture.contents()).toBe(fixture.original);
      },
    );
  });

  it("collects successful jobs from failed main workflows without pruning absent timings", () => {
    withSamplerFixture(
      {
        baseline: {
          ...retained,
          compactGroupSeconds: {
            ...retained.compactGroupSeconds,
            blacksmith: { ...retained.compactGroupSeconds.blacksmith, unobserved: 90 },
          },
        },
        runs: [
          ...Array.from({ length: 100 }, (_, index) =>
            samplerRun(100 + index, { conclusion: "cancelled" }),
          ),
          samplerRun(9, { conclusion: "timed_out" }),
          ...[1, 2, 3].map((id) => samplerRun(id, { conclusion: "failure" })),
        ],
        jobs: [1, 2, 3].flatMap((id) => [
          samplerJob(id * 10 + 1, id, { log: compactLog(10 + id * 20) }),
          samplerJob(id * 10 + 2, id, { conclusion: "failure", log: compactLog(900) }),
          samplerJob(id * 10 + 3, id, { conclusion: "cancelled", log: compactLog(900) }),
          samplerJob(id * 10 + 4, id, {
            status: "in_progress",
            conclusion: null,
            completed_at: null,
          }),
        ]),
      },
      (fixture) => {
        const result = fixture.invoke(false, 3);
        expect(result.status, result.stderr).toBe(0);
        const timings = ciTestTimingsSchema.parse(JSON.parse(fixture.contents()));
        expect(timings.compactGroupSeconds).toEqual({
          blacksmith: { "core-unit-src-security-2": 50, unobserved: 90 },
          github: retained.compactGroupSeconds.github,
        });
        expect(timings.runtimePlacementTimings).toEqual(retained.runtimePlacementTimings);
        expect(result.stdout).toContain("| failure | blacksmith | 1 |");
        const requests = fixture.requests();
        const mainPages = requests.filter((args) => args[1]?.includes("event=push"));
        expect(mainPages).toHaveLength(2);
        for (const args of mainPages) {
          const params = new URL(args[1]!, "https://api.github.com").searchParams;
          expect(params.get("status")).toBe("completed");
          expect(params.get("per_page")).toBe("100");
          expect(params.get("branch")).toBe("main");
          expect(params.get("created")).toBe(`2026-08-21T12:00:00.000Z..${sampleNow}`);
        }
        expect(
          requests.some((args) => /\/runs\/(?:1\d\d|9)\/attempts\//u.test(args[1] ?? "")),
        ).toBe(false);
        expect(
          requests.filter((args) => args[1]?.endsWith("/logs")).map((args) => args[1]),
        ).toEqual([
          "repos/fixture/repo/actions/jobs/11/logs",
          "repos/fixture/repo/actions/jobs/21/logs",
          "repos/fixture/repo/actions/jobs/31/logs",
        ]);
      },
    );
  });

  it("samples contributing PR compact and tooling jobs while retaining partial-plan history and runner identity", () => {
    const gatewayGroup = createCompactSplitTimingGeneration({
      configs: ["test/vitest/vitest.gateway-methods.config.ts"],
      parentShardName: "agentic-gateway-methods-hosted-2",
      stripes: [["src/gateway/selected.test.ts"]],
    }).timingKeys[0]!;
    const extensionConfig = "test/vitest/vitest.extension-database-workers.config.ts";
    const extensionFiles = ["extensions/telegram/src/native.test.ts"];
    const extensionKey = createExtensionTestTimingKey(extensionConfig, extensionFiles)!;
    withSamplerFixture(
      {
        baseline: retained,
        runs: [samplerRun(1), samplerRun(2)],
        toolingRuns: [7, 8, 3, 4, 5].map((id) =>
          samplerRun(id, { event: "pull_request", head_branch: "feature" }),
        ),
        jobs: [
          samplerJob(11, 1),
          samplerJob(21, 2),
          samplerJob(81, 8, { log: "No complete shard spans" }),
          ...[3, 4, 5].flatMap((id) => [
            samplerJob(id * 10 + 1, id, {
              name: `checks-node-${id === 3 ? "changed-" : id === 4 ? "changed-config-" : ""}compact-large-1`,
              log: [
                samplerToolingLog((id - 2) * 20),
                compactLog((id - 2) * 100 + 700, gatewayGroup),
                uiLog({ [measuredFile]: 900 }),
              ].join("\n"),
            }),
            samplerJob(id * 10 + 2, id, {
              name: "checks-ui-e2e (1/6)",
              log: uiLog({ [measuredFile]: 900 }),
            }),
            samplerJob(id * 10 + 3, id, {
              name: "checks-node-changed-config-compact-small-1",
              labels: ["ubuntu-24.04"],
              log: compactLog(600, gatewayGroup),
            }),
            samplerJob(id * 10 + 4, id, {
              name:
                id === 4
                  ? "checks-node-changed-extensions-config"
                  : `checks-node-changed-extensions-bundle-${id}`,
              log: [
                "2026-08-27T23:00:00Z OPENCLAW_VITEST_MAX_WORKERS: 2",
                `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups(
                  [
                    {
                      configs: [extensionConfig],
                      includePatterns: extensionFiles,
                      shard_name: `changed-extensions-config-${id}`,
                    },
                  ],
                )}`,
                compactLog(160 + id * 10, `changed-extensions-config-${id}`),
              ].join("\n"),
            }),
          ]),
        ],
      },
      (fixture) => {
        const result = fixture.invoke(false, 3);
        expect(result.status, result.stderr).toBe(0);
        const timings = ciTestTimingsSchema.parse(JSON.parse(fixture.contents()));
        expect(timings).toMatchObject({
          runtimePlacementTimings: retained.runtimePlacementTimings,
          repoE2eFileSeconds: retained.repoE2eFileSeconds,
          uiE2e: retained.uiE2e,
        });
        expect(timings.compactGroupSeconds).toEqual({
          blacksmith: {
            ...retained.compactGroupSeconds.blacksmith,
            [gatewayGroup]: 900,
            [extensionKey]: 200,
          },
          github: { ...retained.compactGroupSeconds.github, [gatewayGroup]: 600 },
        });
        expect(timings.toolingFileSeconds).toEqual({
          blacksmith: { ...retained.toolingFileSeconds.blacksmith, [toolingFile]: 40 },
          github: retained.toolingFileSeconds.github,
        });
        expect(result.stdout).toContain(
          "PR compact and tooling measurements execute the merge-ref",
        );
        expect(result.stdout).toContain("Independent PR compact contributors: 3");
        expect(timings.source).toContain("pull_request merge-ref runs: 3, 4, 5");
        const request = fixture.requests().find((args) => args[1]?.includes("event=pull_request"));
        expect(request).toBeDefined();
        const params = new URL(request![1]!, "https://api.github.com").searchParams;
        expect(params.get("status")).toBe("success");
        expect(params.get("created")).toBe(`2026-08-21T12:00:00.000Z..${sampleNow}`);
        expect(params.has("branch")).toBe(false);
        expect(
          fixture.requests().some((args) => /\/jobs\/(?:32|42|52)\/logs$/u.test(args[1] ?? "")),
        ).toBe(false);
        expect(
          fixture.requests().filter((args) => /\/jobs\/(?:31|41|51)\/logs$/u.test(args[1] ?? "")),
        ).toHaveLength(3);
        expect(
          fixture.requests().filter((args) => /\/jobs\/(?:34|44|54)\/logs$/u.test(args[1] ?? "")),
        ).toHaveLength(3);
      },
    );
  });

  it.each(["release", "tooling"])(
    "keeps failed %s workflows out of the sampling cohort",
    (source) => {
      const failed = samplerRun(9, {
        conclusion: "failure",
        event: source === "release" ? "workflow_dispatch" : "pull_request",
      });
      withSamplerFixture(
        {
          runs: [samplerRun(1), samplerRun(2)],
          jobs: [samplerJob(11, 1), samplerJob(21, 2), samplerJob(91, 9)],
          ...(source === "release" ? { releaseRuns: [failed] } : { toolingRuns: [failed] }),
        },
        (fixture) => {
          const result = fixture.invoke();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("conclusion");
          expect(fixture.requests().some((args) => args[1]?.includes("/runs/9/"))).toBe(false);
          expect(fixture.contents()).toBe(fixture.original);
        },
      );
    },
  );

  it("seeds one exact successful PR run while retaining every unrelated measurement", () => {
    withSamplerFixture(
      {
        baseline: retained,
        runs: [],
        toolingRuns: [samplerRun(3, { event: "pull_request", head_branch: "feature" })],
        jobs: [
          samplerJob(31, 3, {
            name: "checks-node-changed-config-compact-large-1",
            log: `${samplerToolingLog(40)}\n${compactLog(900)}`,
          }),
        ],
      },
      (fixture) => {
        const dryRun = fixture.invoke(true, 2, [3]);
        expect(dryRun.status, dryRun.stderr).toBe(0);
        expect(fixture.contents()).toBe(fixture.original);
        const result = fixture.invoke(false, 2, [3, 3]);
        expect(result.status, result.stderr).toBe(0);
        const timings = ciTestTimingsSchema.parse(JSON.parse(fixture.contents()));
        expect(timings).toEqual({
          ...retained,
          source: expect.stringContaining(
            "tooling seed from successful pull_request CI merge-ref runs: 3",
          ),
          updatedAt: "2026-08-27",
          toolingFileSeconds: {
            blacksmith: { ...retained.toolingFileSeconds.blacksmith, [toolingFile]: 40 },
            github: retained.toolingFileSeconds.github,
          },
        });
        expect(fixture.requests().some((args) => args[1]?.includes("/workflows/"))).toBe(false);
        expect(
          fixture.requests().filter((args) => args[1]?.endsWith("/actions/runs/3")),
        ).toHaveLength(2);
      },
    );
  });

  it.each([
    ["workflow path", { path: ".github/workflows/other.yml" }, "path"],
    ["event", { event: "push" }, "event"],
    ["failed workflow", { conclusion: "failure" }, "conclusion"],
    ["run identity", { id: 4 }, "Requested tooling run 3 returned run 4"],
  ] satisfies [string, Record<string, unknown>, string][])(
    "rejects a tooling seed with the wrong %s before reading jobs",
    (_name, metadata, error) => {
      withSamplerFixture(
        {
          runs: [],
          jobs: [],
          seedRuns: { "3": samplerRun(3, { event: "pull_request", ...metadata }) },
        },
        (fixture) => {
          const result = fixture.invoke(false, 2, [3]);
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain(error);
          expect(fixture.requests().some((args) => args[1]?.includes("/jobs"))).toBe(false);
          expect(fixture.contents()).toBe(fixture.original);
        },
      );
    },
  );

  it("does not let a retried PR satisfy the ordinary two-run compact or tooling minimum", () => {
    withSamplerFixture(
      {
        baseline: retained,
        runs: [samplerRun(1), samplerRun(2)],
        toolingRuns: [samplerRun(3, { event: "pull_request", run_attempt: 2 })],
        jobs: [
          samplerJob(11, 1),
          samplerJob(21, 2),
          samplerJob(31, 3, { log: `${samplerToolingLog(30)}\n${compactLog(900, "pr-only")}` }),
          samplerJob(32, 3, {
            run_attempt: 2,
            log: `${samplerToolingLog(50)}\n${compactLog(900, "pr-only")}`,
          }),
        ],
      },
      (fixture) => {
        const result = fixture.invoke();
        expect(result.status, result.stderr).toBe(0);
        expect(
          fixture.requests().filter((args) => /\/jobs\/(?:31|32)\/logs$/u.test(args[1] ?? "")),
        ).toHaveLength(2);
        expect(fixture.contents()).toBe(fixture.original);
      },
    );
  });

  it.each([
    ["manual main dispatch", { event: "workflow_dispatch" }, "event"],
    ["another branch", { head_branch: "feature" }, "head_branch"],
    ["missing SHA", { head_sha: null }, "head_sha"],
    ["missing attempt", { run_attempt: undefined }, "run_attempt"],
    ["zero attempt", { run_attempt: 0 }, "run_attempt"],
    ["incomplete run", { status: "in_progress" }, "status"],
    ["missing conclusion", { conclusion: undefined }, "conclusion"],
    ["stale run", { created_at: "2026-08-21T11:59:59.999Z" }, "created_at"],
    ["future run", { created_at: "2026-08-28T12:00:00.001Z" }, "created_at"],
  ] satisfies [string, Record<string, unknown>, string][])(
    "rejects %s before reading logs or changing the baseline",
    (_name, metadata, field) => {
      withSamplerFixture(
        {
          runs: [samplerRun(1, metadata), samplerRun(2)],
          jobs: [samplerJob(11, 1), samplerJob(21, 2)],
        },
        (fixture) => {
          const result = fixture.invoke();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain(field);
          expect(fixture.requests().some((args) => args[1]?.endsWith("/logs"))).toBe(false);
          expect(fixture.contents()).toBe(fixture.original);
        },
      );
    },
  );

  it.each([
    ["wrong run", { run_id: 9 }],
    ["wrong attempt", { run_attempt: 2 }],
    ["wrong SHA", { head_sha: "b".repeat(40) }],
    ["unfinished success", { status: "in_progress" }],
    ["missing completion", { completed_at: null }],
    ["stale start", { started_at: "2026-08-21T11:59:59.999Z" }],
    ["future completion", { completed_at: "2026-08-28T12:00:00.001Z" }],
    ["reversed timestamps", { completed_at: "2026-08-27T22:59:59Z" }],
  ] satisfies [string, Record<string, unknown>][])(
    "rejects a job with %s without reading its log",
    (_name, metadata) => {
      const job = samplerJob(11, 1, metadata);
      withSamplerFixture(
        {
          runs: [samplerRun(1), samplerRun(2)],
          jobs: [job, samplerJob(21, 2)],
          jobPages: { "1:1": [[job]] },
          jobTotals: { "1:1": 1 },
        },
        (fixture) => {
          const result = fixture.invoke();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toMatch(/cohort|frozen UTC window/u);
          expect(fixture.requests().some((args) => args[1]?.endsWith("/logs"))).toBe(false);
          expect(fixture.contents()).toBe(fixture.original);
        },
      );
    },
  );

  it("seeks compact contributors past docs-only and unparseable runs, preserving all attempts and unchanged bytes", () => {
    const releaseRuns = [10, 11].map((id) =>
      samplerRun(id, {
        event: "workflow_dispatch",
        head_branch: "release-ci/frozen",
        head_sha: "b".repeat(40),
      }),
    );
    withSamplerFixture(
      {
        runs: [
          samplerRun(1),
          samplerRun(2),
          samplerRun(3, { run_attempt: 2 }),
          samplerRun(4, { run_attempt: 2 }),
        ],
        releaseRuns,
        jobs: [
          samplerJob(11, 1, { name: "docs", log: "No test results" }),
          samplerJob(21, 2, { log: "No complete compact spans" }),
          ...[3, 4].flatMap((id) => [
            samplerJob(id * 10 + 1, id),
            samplerJob(id * 10 + 2, id, {
              name: "checks-ui-e2e (1/6)",
              log: uiLog({ [measuredFile]: 130 }),
            }),
            samplerJob(id * 10 + 3, id, {
              run_attempt: 2,
              labels: ["ubuntu-24.04"],
              log: compactLog(id === 3 ? 40 : 60),
            }),
            samplerJob(id * 10 + 4, id, {
              run_attempt: 2,
              conclusion: "failure",
              log: compactLog(900),
            }),
          ]),
          ...releaseRuns.map((run) =>
            samplerJob(run.id * 10, run.id, {
              head_sha: "b".repeat(40),
              name: "Run repo/live E2E validation / Gateway E2E / Repo E2E (Gateway 1/4)",
              log: "✓ test/release.e2e.test.ts (1 test) 4500ms\nDuration 5s (tests 4.5s)",
            }),
          ),
        ],
      },
      (fixture) => {
        const dryRun = fixture.invoke(true);
        expect(dryRun.status, dryRun.stderr).toBe(0);
        expect(fixture.contents()).toBe(fixture.original);
        expect(dryRun.stdout).toContain(
          "Independent main compact contributors: 2 (Blacksmith: 2; GitHub: 2). Release Gateway contributors: 2.",
        );
        expect(dryRun.stdout).toContain(`| release | 10 | 1 | ${"b".repeat(40)} |`);
        expect(dryRun.stdout).toContain(
          "Release workflow SHAs identify tooling, not the measured target.",
        );
        const requests = fixture.requests();
        const runRequests = requests.filter((args) => args[1]?.includes("/workflows/"));
        expect(runRequests).toHaveLength(4);
        for (const args of runRequests) {
          const params = new URL(args[1]!, "https://api.github.com").searchParams;
          expect(params.get("created")).toBe(`2026-08-21T12:00:00.000Z..${sampleNow}`);
        }
        expect(requests.some((args) => args[1]?.includes("/runs/3/attempts/1/jobs?"))).toBe(true);
        expect(requests.some((args) => args[1]?.includes("/runs/3/attempts/2/jobs?"))).toBe(true);
        expect(requests.some((args) => args[1]?.includes("filter=all"))).toBe(false);
        expect(requests.some((args) => args[1]?.endsWith("/jobs/34/logs"))).toBe(false);
        const write = fixture.invoke();
        expect(write.status, write.stderr).toBe(0);
        const updated = fixture.contents();
        const timings = ciTestTimingsSchema.parse(JSON.parse(updated));
        expect(timings.uiE2e.fileSeconds[measuredFile]).toBe(130);
        expect(timings.repoE2eFileSeconds).toEqual({ "test/release.e2e.test.ts": 5 });
        expect(timings.compactGroupSeconds).toEqual({
          blacksmith: { "core-unit-src-security-2": 20 },
          github: { "core-unit-src-security-2": 50 },
        });
        const unchanged = fixture.invoke();
        expect(unchanged.status, unchanged.stderr).toBe(0);
        expect(unchanged.stdout).toContain("No timing changes");
        expect(fixture.contents()).toBe(updated);
      },
    );
  });

  it("accepts both date boundaries without changing an unobserved profile", () => {
    const lower = "2026-08-21T12:00:00.000Z";
    withSamplerFixture(
      {
        runs: [samplerRun(1, { created_at: lower }), samplerRun(2, { created_at: sampleNow })],
        jobs: [
          samplerJob(11, 1, { started_at: lower, completed_at: lower }),
          samplerJob(21, 2, { started_at: sampleNow, completed_at: sampleNow }),
        ],
        baseline: {
          ...baseline,
          compactGroupSeconds: { blacksmith: {}, github: { retained: 90 } },
        },
      },
      (fixture) => {
        const result = fixture.invoke();
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(fixture.contents()).compactGroupSeconds.github).toEqual({ retained: 90 });
      },
    );
  });

  it.each(["different keys", "one run with retries", "release only"])(
    "rejects %s as evidence for a new compact measurement",
    (condition) => {
      const first = samplerRun(1, { run_attempt: condition === "one run with retries" ? 2 : 1 });
      withSamplerFixture(
        {
          runs:
            condition === "release only"
              ? []
              : condition === "one run with retries"
                ? [first]
                : [first, samplerRun(2)],
          jobs:
            condition === "release only"
              ? [10, 11].map((id) =>
                  samplerJob(id * 10, id, {
                    name: "Repo E2E (Gateway 1/4)",
                    log: "✓ test/release.e2e.test.ts (1 test) 4000ms\nDuration 5s",
                  }),
                )
              : [
                  samplerJob(11, 1),
                  samplerJob(21, condition === "one run with retries" ? 1 : 2, {
                    run_attempt: condition === "one run with retries" ? 2 : 1,
                    log: compactLog(20, condition === "different keys" ? "different" : undefined),
                  }),
                ],
          releaseRuns:
            condition === "release only"
              ? [10, 11].map((id) => samplerRun(id, { event: "workflow_dispatch" }))
              : [],
        },
        (fixture) => {
          const result = fixture.invoke();
          expect(result.status, result.stderr).toBe(1);
          expect(result.stderr).toContain("newly eligible compact measurement");
          expect(fixture.contents()).toBe(fixture.original);
          expect(fixture.requests().some((args) => args[1]?.includes("/workflows/openclaw-"))).toBe(
            false,
          );
        },
      );
    },
  );

  it("deduplicates overlapping run and job pages without treating retries as extra runs", () => {
    const first = samplerRun(1);
    const second = samplerRun(2);
    const compact = samplerJob(11, 1);
    const ui = samplerJob(12, 1, {
      name: "checks-ui-e2e (1/6)",
      log: uiLog({ [measuredFile]: 130 }),
    });
    withSamplerFixture(
      {
        runs: [first, second],
        runPages: [[first, first], [second]],
        jobs: [compact, ui, samplerJob(21, 2)],
        jobPages: { "1:1": [[compact, compact], [ui]] },
      },
      (fixture) => {
        const result = fixture.invoke();
        expect(result.status, result.stderr).toBe(0);
        expect(
          fixture.requests().filter((args) => args[1]?.endsWith("/jobs/11/logs")),
        ).toHaveLength(1);
        expect(result.stdout).toContain("Independent main compact contributors: 2");
      },
    );
  });

  it.each(["run", "job"])("refuses incomplete %s pagination without writing", (kind) => {
    const first = samplerRun(1);
    const job = samplerJob(11, 1);
    withSamplerFixture(
      {
        runs: [first, samplerRun(2)],
        jobs: [job, samplerJob(21, 2)],
        ...(kind === "run"
          ? { runPages: [[first], []] }
          : { jobPages: { "1:1": [[job], []] }, jobTotals: { "1:1": 2 } }),
      },
      (fixture) => {
        const result = fixture.invoke();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("pagination incomplete");
        expect(fixture.contents()).toBe(fixture.original);
      },
    );
  });

  it("keeps the 25-page job budget across all captured attempts", () => {
    withSamplerFixture({ runs: [samplerRun(1, { run_attempt: 26 })], jobs: [] }, (fixture) => {
      const result = fixture.invoke();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("Job pagination limit reached");
      const jobRequests = fixture.requests().filter((args) => args[1]?.includes("/jobs?"));
      expect(jobRequests).toHaveLength(25);
      expect(jobRequests.at(-1)?.[1]).toContain("/attempts/25/jobs?");
      expect(fixture.contents()).toBe(fixture.original);
    });
  });
});

describe("CI timing schema", () => {
  const observation: RuntimePlacementTiming = {
    configs: ["reader.config.ts"],
    env: {},
    includePatterns: ["src/reader.test.ts"],
    pretestBuildMode: "runtime",
    seconds: 20,
  };
  it.each([
    [{ ...observation, includePatterns: [] }],
    [{ ...observation, includePatterns: ["src/*.test.ts"] }],
    [{ ...observation, includePatterns: ["src/reader.test.ts", "src/reader.test.ts"] }],
    [{ ...observation, env: { workers: 2 } }],
    [{ ...observation, configs: [] }],
    [{ ...observation, seconds: 0 }],
    [{ ...observation, pretestBuildMode: "unknown" }],
    [observation, { ...observation }],
  ])("rejects malformed or duplicate runtime observations %j", (...observations) => {
    expect(() =>
      ciTestTimingsSchema.parse({
        ...baseline,
        runtimePlacementTimings: { blacksmith: observations, github: [] },
      }),
    ).toThrow("Invalid CI test timings");
  });

  const invalidTimings: Array<[string, unknown]> = [
    ["non-object root", null],
    ["unknown root key", { ...baseline, extra: 1 }],
    ["empty source", { ...baseline, source: "" }],
    ...["2026-02-29", "1900-02-29", "2026-04-31", "2026-8-22", "2026-08-22T00:00:00Z"].map(
      (updatedAt): [string, unknown] => [`invalid date ${updatedAt}`, { ...baseline, updatedAt }],
    ),
    ["unknown UI key", { ...baseline, uiE2e: { ...baseline.uiE2e, extra: 1 } }],
    [
      "unknown compact profile",
      { ...baseline, compactGroupSeconds: { ...baseline.compactGroupSeconds, extra: {} } },
    ],
    ["missing profile", { ...baseline, compactGroupSeconds: { blacksmith: {} } }],
    ...["ui", "repoE2e", "blacksmith", "github"].flatMap((profile) =>
      (profile === "ui"
        ? [
            null,
            [],
            { "": 1 },
            ...[0, -1, "2", null, 1.2, Number.MAX_SAFE_INTEGER + 1].map((seconds) => ({
              valid: 100,
              invalid: seconds,
            })),
          ]
        : [{ invalid: 0 }]
      ).map((seconds): [string, unknown] => [
        `invalid ${profile} map ${JSON.stringify(seconds)}`,
        profile === "ui"
          ? { ...baseline, uiE2e: { ...baseline.uiE2e, fileSeconds: seconds } }
          : profile === "repoE2e"
            ? { ...baseline, repoE2eFileSeconds: seconds }
            : {
                ...baseline,
                compactGroupSeconds: {
                  blacksmith: { valid: 100 },
                  github: { valid: 100 },
                  [profile]: seconds,
                },
              },
      ]),
    ),
    ["non-finite seconds", { ...baseline, repoE2eFileSeconds: { invalid: Infinity } }],
    ...[-1, 5.1, null, "1", Infinity].map((overhead): [string, unknown] => [
      `invalid overhead ${String(overhead)}`,
      { ...baseline, uiE2e: { ...baseline.uiE2e, perFileOverheadSeconds: overhead } },
    ]),
  ];

  it.each(invalidTimings)("rejects %s", (_name, value) => {
    expect(() => ciTestTimingsSchema.parse(value)).toThrow("Invalid CI test timings");
  });

  it.each([0, 5])("accepts overhead boundary %s, safe integers and leap dates", (overhead) => {
    const data = {
      ...baseline,
      updatedAt: "2000-02-29",
      uiE2e: {
        fileSeconds: { [measuredFile]: Number.MAX_SAFE_INTEGER },
        perFileOverheadSeconds: overhead,
      },
    };
    expect(ciTestTimingsSchema.parse(data)).toEqual(data);
  });
});

describe("committed CI timing loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function readTimings(contents: string | Error) {
    vi.resetModules();
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
    const original = fs.readFileSync;
    const timingPath = fileURLToPath(new URL("../../config/ci-test-timings.json", import.meta.url));
    const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if ((file instanceof URL ? fileURLToPath(file) : file) === timingPath) {
        if (contents instanceof Error) {
          throw contents;
        }
        return contents;
      }
      return original(file, options);
    });
    syncBuiltinESMExports();
    const loader = await import("../../scripts/lib/ci-test-timings.mts");
    return { loader, read, timingPath };
  }

  it.each([
    ["missing", new Error("ENOENT")],
    ["truncated", '{"version":1'],
    ["wrong version", JSON.stringify({ ...baseline, version: 2 })],
  ] satisfies Array<[string, string | Error]>)(
    "ignores the entire %s file without throwing",
    async (_name, contents) => {
      const { loader } = await readTimings(contents);
      expect(loader.readUiE2eFileTimings()).toEqual({ fileSeconds: {}, perFileOverheadSeconds: 0 });
      expect(loader.readRepoE2eFileTimings()).toEqual({});
      expect(loader.readCompactGroupTimings("blacksmith")).toEqual({});
      expect(loader.readCompactGroupTimings("github")).toEqual({});
      expect(loader.readToolingFileTimings("blacksmith")).toEqual({});
      expect(loader.readToolingFileTimings("github")).toEqual({});
    },
  );

  it("reads the repo-relative file once and honors the disable switch even after caching", async () => {
    const data = {
      ...baseline,
      compactGroupSeconds: { blacksmith: { group: 110 }, github: { group: 181 } },
      repoE2eFileSeconds: { "test/example.e2e.test.ts": 90 },
      toolingFileSeconds: {
        blacksmith: { "test/scripts/ci-node-test-plan.test.ts": 300 },
        github: { "test/scripts/ci-node-test-plan.test.ts": 420 },
      },
    };
    const { loader, read, timingPath } = await readTimings(JSON.stringify(data));
    expect(loader.readUiE2eFileTimings()).toEqual(data.uiE2e);
    expect(loader.readRepoE2eFileTimings()).toEqual(data.repoE2eFileSeconds);
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({ group: 110 });
    expect(loader.readCompactGroupTimings("github")).toEqual({ group: 181 });
    expect(loader.readToolingFileTimings("blacksmith")).toEqual(data.toolingFileSeconds.blacksmith);
    expect(loader.readToolingFileTimings("github")).toEqual(data.toolingFileSeconds.github);
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", "0");
    expect(loader.readUiE2eFileTimings()).toEqual({ fileSeconds: {}, perFileOverheadSeconds: 0 });
    expect(loader.readRepoE2eFileTimings()).toEqual({});
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({});
    expect(loader.readCompactGroupTimings("github")).toEqual({});
    expect(loader.readToolingFileTimings("blacksmith")).toEqual({});
    expect(loader.readToolingFileTimings("github")).toEqual({});
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
    expect(loader.readCompactGroupTimings("github")).toEqual({ group: 181 });
    expect(
      read.mock.calls.filter(([file]) => file instanceof URL && fileURLToPath(file) === timingPath),
    ).toHaveLength(1);
  });
});
