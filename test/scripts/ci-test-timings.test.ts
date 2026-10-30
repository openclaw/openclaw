import { spawnSync } from "node:child_process";
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import {
  type CompactNodeTestShard,
  type NodeTestShardGroup,
  createNodeTestShardBundles as nodeBundles,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { rebalanceRuntimeTestJobs } from "../../scripts/lib/ci-runtime-test-placement.mts";
import { refitTestTimings, type CiTimingRun } from "../../scripts/lib/ci-test-timings-refit.mts";
import {
  createNativeSoloTimingKey,
  ciTestTimingsSchema,
  type CiTestTimings,
  type RuntimePlacementTiming,
} from "../../scripts/lib/ci-test-timings-schema.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import { createExtensionTestTimingKey as extensionTimingKey } from "../../scripts/lib/extension-test-plan.mts";
import * as buildPrerequisites from "../../scripts/lib/vitest-build-prerequisites.mts";
import { createCompactSplitTimingGeneration as splitTimingGeneration } from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { toolingProbeRuntimeEntrypoints } from "./tooling-probe-runtime.test-support.mts";

function runtimeTiming(
  { configs, includePatterns }: Pick<RuntimePlacementTiming, "configs" | "includePatterns">,
  seconds: number,
  env: RuntimePlacementTiming["env"] = {},
): RuntimePlacementTiming {
  return { configs, includePatterns, env, pretestBuildMode: "runtime", seconds };
}

function uiLog(files: Record<string, number>) {
  const body = Object.values(files).reduce((sum, value) => sum + value, 0);
  return [
    ...Object.entries(files).map(
      ([name, value]) =>
        `2026-08-27T23:00:00Z ✓ \u001b[32mui-e2e\u001b[0m ${name} (1 test) ${value * 1000}ms`,
    ),
    `Duration ${body + Object.keys(files).length * 0.6}s (transform 1s, setup 2ms, import 3s, tests ${body}s, environment 1ms)`,
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

function compactRun(id: number, text: string, label = "blacksmith-32vcpu-ubuntu-2404") {
  return timingRun(id, [{ kind: "compact", labels: [label], text }]);
}

function timingLog(
  text: string,
  label = "blacksmith-32vcpu-ubuntu-2404",
  kind: "compact" | "tooling" | "release-packed" = "compact",
) {
  return { kind, labels: [label], text };
}

function mockTimingFile(contents: string) {
  const original = fs.readFileSync;
  const timingPath = fileURLToPath(new URL("../../config/ci-test-timings.json", import.meta.url));
  const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    if ((file instanceof URL ? fileURLToPath(file) : file) !== timingPath) {
      return original(file, options);
    }
    return contents;
  });
  syncBuiltinESMExports();
  onTestFinished(() => {
    read.mockRestore();
    syncBuiltinESMExports();
  });
  return { read, timingPath };
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

function packedReleaseFixture() {
  const configs = ["test/vitest/vitest.unit-fast.config.ts"];
  const stripes = [["first.test.ts"], ["second.test.ts"]];
  const { timingKeys } = splitTimingGeneration({
    configs,
    parentShardName: "release-full-fixture",
    stripes,
  });
  const groups = stripes.map((includePatterns, index) => ({
    configs,
    includePatterns,
    env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    shard_name: `fixture-${index + 1}`,
    timing_key: timingKeys[index],
  }));
  const line = (second: number, body: string) =>
    `${new Date(Date.parse("2026-08-27T23:00:00Z") + second * 1000).toISOString()} ${body}`;
  return {
    timingKeys,
    text: [
      line(0, `OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups(groups)}`),
      line(0, "OPENCLAW_VITEST_MAX_WORKERS: 3"),
      line(0, "OPENCLAW_CI_TEST_RUNTIME_POLICY: dual-all"),
      line(
        0,
        "[shard:resources] logicalCpuCount=4 totalMemoryBytes=7516192768 requested plans=1 admitted plans=1",
      ),
      line(0, `[shard:${timingKeys[0]}] begin`),
      line(10, `[shard:${timingKeys[0]}] end (exit 0)`),
      line(12, `[shard:bun:${timingKeys[0]}] begin`),
      line(32, `[shard:bun:${timingKeys[0]}] end (exit 0)`),
      line(40, `[shard:${timingKeys[1]}] begin`),
      line(50, `[shard:${timingKeys[1]}] end (exit 0)`),
      line(52, `[shard:bun-native:${timingKeys[1]}] begin`),
      line(70, `[shard:bun-native:${timingKeys[1]}] end (exit 0)`),
      line(
        71,
        '[shard:completion] {"version":1,"planned":2,"completed":2,"invocations":4,"failedInvocations":0}',
      ),
    ].join("\n"),
  };
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
const compactBaseline = (
  blacksmith: Record<string, number> = {},
  github: Record<string, number> = {},
): CiTestTimings => ({ ...baseline, compactGroupSeconds: { blacksmith, github } });

function expectCompact(
  runs: CiTimingRun[],
  expected: Record<string, number>,
  previous?: CiTestTimings,
  profile: "blacksmith" | "github" = "blacksmith",
) {
  expect(refitTestTimings(runs, previous).timings.compactGroupSeconds[profile]).toEqual(expected);
}

const repeatedRuns = (text: string, label = "blacksmith-32vcpu-ubuntu-2404", count = 2) =>
  Array.from({ length: count }, (_, index) => compactRun(index + 1, text, label));

describe("resource-qualified native solo timings", () => {
  const descriptor = {
    shard_name: "storage-hosted-2",
    configs: ["test/vitest/vitest.infra.config.ts"],
    includePatterns: ["src/system-agent/setup-inference-activate.test.ts"],
  };
  const key =
    "native-solo-8cpu-8workers:94be95e41d7b2c72236d1aa22e2efd41b5fb6a0c76514f70e53a92232b092bfd";
  const log = (span: number, group = descriptor) => {
    const line = (second: number, body: string) =>
      `${new Date(Date.parse("2026-08-27T23:00:00Z") + second * 1000).toISOString()} ${body}`;
    const child = (second: number, body: string) =>
      line(second, `[shard:${group.shard_name}] ${body}`);
    return [
      line(0, "OPENCLAW_VITEST_MAX_WORKERS: 8"),
      line(0, "OPENCLAW_NODE_TEST_ENV_JSON: null"),
      line(0, "OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: []"),
      line(0, "RUNNER_ENVIRONMENT: self-hosted"),
      line(0, "FROZEN_TARGET: false"),
      line(0, `OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([group])}`),
      line(
        0,
        `[shard:resources] logicalCpuCount=8 totalMemoryBytes=${31 * 1024 ** 3} requested plans=1 admitted plans=1`,
      ),
      child(0, "begin"),
      child(1, `[test] starting ${descriptor.configs[0]}`),
      child(2, "RUN v5.0.1 /checkout"),
      child(3, `✓ infra ${descriptor.includePatterns[0]} > case 1ms`),
      child(span - 3, "Test Files 1 passed (1)"),
      child(span - 3, "Duration 100s (tests 90%, import 10%)"),
      child(span - 2, "[vitest-workers] verifying completed generation before cleanup"),
      child(span - 1, `[test] passed 1 Vitest shard in ${span}s`),
      child(span, "end (exit 0)"),
    ].join("\n");
  };
  const refit = (texts: string[], labels = ["blacksmith-32vcpu-ubuntu-2404"]) =>
    refitTestTimings(
      texts.map((text, index) =>
        Object.assign(timingRun(index + 1, [{ kind: "compact", labels, text }]), {
          completeInventory: false,
          pullRequestMergeRef: true,
        }),
      ),
      baseline,
    );

  it("retains a complete child wall across renamed shards, without lowering legacy floors", () => {
    const renamed = {
      ...descriptor,
      shard_name: "changed-storage-hosted-9",
      env: { OPENCLAW_VITEST_MAX_WORKERS: "8" },
    };
    expect(createNativeSoloTimingKey(descriptor)).toBe(key);
    expect(createNativeSoloTimingKey(renamed)).toBe(key);
    expect(refit([log(121)]).timings.compactGroupSeconds.blacksmith[key]).toBeUndefined();
    const previous = compactBaseline({ storage: 300 });
    const runs = [log(121), log(125, renamed)].map((text, index) =>
      Object.assign(compactRun(index + 1, text), {
        completeInventory: false,
        pullRequestMergeRef: true,
      }),
    );
    expectCompact(runs, { storage: 300, [key]: 123 }, previous);
  });

  it.each([
    {
      name: "job environment",
      from: "OPENCLAW_NODE_TEST_ENV_JSON: null",
      to: 'OPENCLAW_NODE_TEST_ENV_JSON: {"OTHER":"1"}',
      policy: {},
    },
    {
      name: "incomplete cleanup",
      from: "verifying completed generation before cleanup",
      to: "unfinished generation",
      policy: {},
    },
    { name: "dist requirement", from: "", to: "", policy: { requiresDist: true } },
    { name: "worker fallback", from: "", to: "", policy: { fallbackMaxWorkers: 2 } },
  ])("rejects native solo timing with $name", ({ from, to, policy }) => {
    const group = { ...descriptor, ...policy };
    if (Object.keys(policy).length > 0) {
      expect(createNativeSoloTimingKey(group)).toBeUndefined();
    }
    const texts = [121, 125].map((span) => {
      const text = log(span, group);
      return from ? text.replace(from, to) : text;
    });
    expect(refit(texts).timings.compactGroupSeconds.blacksmith[key]).toBeUndefined();
  });

  it("rejects missing/conflicting provenance and multiple descriptors", () => {
    const original = log(121);
    const resources = original.split("\n").find((line) => line.includes("[shard:resources]"))!;
    const groups = original
      .split("\n")
      .find((line) => line.includes("OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64:"))!;
    for (const text of [
      original.replace(resources, ""),
      `${original}\n${resources}`,
      original.replace("FROZEN_TARGET: false", "UNRELATED: false"),
      `${original}\n2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_ENV_JSON: {}`,
      original.replace(
        groups,
        groups.replace(
          encodeNodeTestGroups([descriptor]),
          encodeNodeTestGroups([descriptor, { ...descriptor, shard_name: "second" }]),
        ),
      ),
    ]) {
      expect(refit([text, text]).timings.compactGroupSeconds.blacksmith[key]).toBeUndefined();
    }
    expect(
      refit([original, log(125)], ["blacksmith-16vcpu-ubuntu-2404"]).timings.compactGroupSeconds
        .blacksmith[key],
    ).toBeUndefined();
  });
});

describe("native singleton invocation timings", () => {
  const config = "test/vitest/vitest.extension-database-workers.config.ts";
  const files = ["extensions/telegram/src/one.test.ts", "extensions/telegram/src/two.test.ts"];
  const shard = "changed-extensions-config-1";
  const descriptor = { configs: [config], includePatterns: files, shard_name: shard };
  const line = (second: number, body: string) =>
    `${new Date(Date.parse("2026-09-26T00:00:00Z") + second * 1000).toISOString()} [shard:${shard}] ${body}`;
  const invocationLog = () =>
    [
      "2026-09-26T00:00:00Z OPENCLAW_VITEST_MAX_WORKERS: 2",
      `2026-09-26T00:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([descriptor])}`,
      line(0, "begin"),
      line(1, `[test] starting ${config}`),
      line(2, "RUN v5.0.1 /checkout"),
      line(3, `✓ extension-database-workers ${files[0]} > first case 1ms`),
      line(9, "Test Files 1 passed (1)"),
      line(9, "Duration 8s (tests 60%, import 40%)"),
      line(11, `[test] starting ${config}`),
      line(12, "RUN v5.0.1 /checkout"),
      line(14, `✓ extension-database-workers ${files[1]} > second case 2ms`),
      line(30, "Test Files 1 passed (1)"),
      line(30, "Duration 18s (tests 70%, import 30%)"),
      line(32, "[vitest-workers] verifying completed generation before cleanup"),
      line(33, "[test] passed 2 Vitest shards in 32s"),
      line(34, "end (exit 0)"),
    ].join("\n");
  const refit = (text: string, pullRequestMergeRef = true) =>
    refitTestTimings(
      repeatedRuns(text, "blacksmith-8vcpu-ubuntu-2404").map((run) =>
        Object.assign(run, {
          pullRequestMergeRef,
          completeInventory: !pullRequestMergeRef,
        }),
      ),
    ).timings.compactGroupSeconds.blacksmith;

  it.each([
    { kind: "parallel", interleaved: false, receipts: [2] },
    { kind: "parallel", interleaved: true, receipts: [2] },
    { kind: "fallback", interleaved: false, receipts: [1] },
    { kind: "contradictory", interleaved: false, receipts: [1, 2] },
  ])(
    "qualifies the $kind envelope (interleaved=$interleaved)",
    ({ kind, interleaved, receipts }) => {
      const env = { OPENCLAW_VITEST_MAX_WORKERS: "2", OPENCLAW_TEST_PROJECTS_PARALLEL: "2" };
      let text = invocationLog()
        .replace(encodeNodeTestGroups([descriptor]), encodeNodeTestGroups([{ ...descriptor, env }]))
        .replace(
          line(0, "begin"),
          [
            line(0, "begin"),
            ...receipts.map((count) => line(0, `[test] inner parallelism ${count}`)),
          ].join("\n"),
        );
      if (interleaved) {
        text = text
          .replace(line(11, `[test] starting ${config}`) + "\n", "")
          .replace(
            line(2, "RUN v5.0.1 /checkout"),
            [line(2, `[test] starting ${config}`), line(2, "RUN v5.0.1 /checkout")].join("\n"),
          );
      }
      const observed = refit(text);
      if (kind === "parallel") {
        expect(observed).toEqual({ [extensionTimingKey(config, files, env)!]: 34 });
      } else {
        expect(observed[extensionTimingKey(config, files, env)!]).toBeUndefined();
        expect(observed).toEqual(kind === "fallback" ? refit(invocationLog()) : {});
      }
    },
  );

  it.each([
    [
      "invalid timestamp",
      line(11, `[test] starting ${config}`),
      `2026-99-26T00:00:11Z [shard:${shard}] [test] starting ${config}`,
    ],
    ["foreign file", files[1]!, "extensions/telegram/src/foreign.test.ts"],
    ["multi-file invocation", "Test Files 1 passed (1)", "Test Files 2 passed (2)"],
    ["invalid duration", "Duration 8s (tests 60%, import 40%)", "Duration 1.2.3s"],
    [
      "ambiguous worker environment",
      "OPENCLAW_VITEST_MAX_WORKERS: 2",
      "OPENCLAW_VITEST_MAX_WORKERS: 2\n2026-09-26T00:00:00Z OPENCLAW_VITEST_MAX_WORKERS: 8",
    ],
  ])("rejects derived singleton prices atomically for %s", (_name, from, to) => {
    const result = refit(invocationLog().replace(from, to));
    expect(
      Object.keys(result).filter(
        (key) => key.includes("#include-1-") || key.includes("#wrapper-overhead"),
      ),
    ).toEqual([]);
  });

  it("does not infer singleton prices for a multi-file process owner", () => {
    const ordinaryConfig = "test/vitest/vitest.extension-telegram.config.ts";
    const text = invocationLog()
      .replace(
        encodeNodeTestGroups([descriptor]),
        encodeNodeTestGroups([{ ...descriptor, configs: [ordinaryConfig] }]),
      )
      .replaceAll(`[test] starting ${config}`, `[test] starting ${ordinaryConfig}`);
    expect(refit(text)).toEqual({ [extensionTimingKey(ordinaryConfig, files)!]: 34 });
  });
});

describe("runtime placement observations", () => {
  function selectRuntimeConsumers(
    files: readonly string[] = [
      "src/config/state-startup-corpus.test.ts",
      "src/infra/update-managed-service-handoff-lifecycle.test.ts",
      "src/plugin-state/plugin-state-store.runtime.test.ts",
      "test/plugins/codex-model-catalog.gateway.test.ts",
    ],
  ) {
    const consumers = new Set(files);
    const resolve = buildPrerequisites.resolveVitestPretestBuildMode;
    // Keep real inventories while making this donation's runtime prerequisites explicit.
    const spy = vi
      .spyOn(buildPrerequisites, "resolveVitestPretestBuildMode")
      .mockImplementation((selections) =>
        resolve(
          selections.map((selection) => ({
            ...selection,
            matchesFile: (file, included, patterns) =>
              consumers.has(file) &&
              (selection.matchesFile?.(file, included, patterns) ?? included),
          })),
        ),
      );
    onTestFinished(() => spy.mockRestore());
  }
  function mockRuntimePlacementCosts() {
    // Keep spare capacity independent of growing production prices; observations supply overload.
    const costs = new Proxy<Record<string, number>>(
      { "agentic-gateway-server-isolated": 30, "agentic-agents-core-subagents": 20 },
      {
        get: (target, key) =>
          typeof key === "string" ? (target[key] ?? 39) : Reflect.get(target, key),
      },
    );
    const spy = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue(costs);
    onTestFinished(() => spy.mockRestore());
  }
  it.each(["node", "bun-all"])(
    "retains recorded %s runtime work when its current group gains a file",
    (runtimePolicy) => {
      vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", runtimePolicy);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const corpusFile = "src/config/state-startup-corpus.test.ts";
      const handoffFile = "src/infra/update-managed-service-handoff-lifecycle.test.ts";
      selectRuntimeConsumers([corpusFile, handoffFile]);
      mockRuntimePlacementCosts();
      const readRuntimeTimings = testTimings.readRuntimePlacementTimings;
      const runtimeSpy = vi.spyOn(testTimings, "readRuntimePlacementTimings").mockReturnValue([]);
      onTestFinished(() => runtimeSpy.mockRestore());
      const options = {
        compactMode: "push" as const,
        runnerBackend: "hybrid",
        includeReleaseOnlyPluginShards: false,
      };
      const before = nodeBundles(options);
      const groups = before.flatMap((job) => job.groups);
      const corpus = groups.find((group) => group.includePatterns?.includes(corpusFile))!;
      const handoff = groups.find((group) => group.includePatterns?.includes(handoffFile))!;
      expect(corpus.includePatterns!.length).toBeGreaterThan(1);
      expect(corpus.pretestBuildMode).toBe("runtime");
      expect(handoff.pretestBuildMode).toBe("runtime");
      expect(before.find((job) => job.groups.includes(corpus))).toBe(
        before.find((job) => job.groups.includes(handoff)),
      );
      runtimeSpy.mockImplementation(readRuntimeTimings);
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
            const runtimeShard = `${runtimePolicy === "bun-all" ? "bun:" : ""}${descriptor.shard_name}`;
            const [begin, end] = compactLog(seconds, runtimeShard).split("\n");
            return timingLog(
              [
                `2026-08-27T23:00:00Z OPENCLAW_CI_TEST_RUNTIME_POLICY: ${runtimePolicy}`,
                `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([descriptor])}`,
                begin,
                `2026-08-27T23:00:01Z [shard:${runtimeShard}] [test] preparing runtime runtime before Vitest workers`,
                end,
              ].join("\n"),
              "blacksmith-4vcpu-ubuntu-2404",
            );
          }),
        ),
      );
      const data = refitTestTimings(runs).timings;
      mockTimingFile(JSON.stringify(data));
      const plan = nodeBundles(options);
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
    },
  );
  const reader = {
    configs: ["test/vitest/reader.config.ts"],
    env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    includePatterns: ["src/reader.test.ts"],
    pretestBuildMode: "runtime" as const,
  };

  function runtimeLog(
    id: number,
    overrides: Partial<Omit<typeof reader, "pretestBuildMode">> & {
      pretestBuildMode?: "runtime" | "private-qa";
    } = {},
  ) {
    const group = { ...reader, ...overrides };
    const generation = splitTimingGeneration({
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
  const sample = (id: number, text: string) => compactRun(id, text, "blacksmith-8vcpu-ubuntu-2404");

  it("does not merge runtime placement with changed private-QA ownership", () => {
    const result = refitTestTimings([
      sample(1, runtimeLog(1)),
      sample(2, runtimeLog(2, { pretestBuildMode: "private-qa" })),
    ]);
    expect(result.timings.runtimePlacementTimings.blacksmith).toEqual([]);
  });

  it.each(["gateway-empty", "gateway-packed", "ordinary-spare"] as const)(
    "rebalances runtime work only into spare capacity: %s",
    (scenario) => {
      const gateway = scenario !== "ordinary-spare";
      const packed = scenario === "gateway-packed";
      const runner = gateway ? "large" : "same";
      const group = (name: string, runtime = true): NodeTestShardGroup => ({
        shard_name: name,
        configs: [
          gateway
            ? `fixture-${name === "gateway" ? "gateway" : "runtime"}.config.ts`
            : "reader.config.ts",
        ],
        includePatterns: [`src/${name}.test.ts`],
        requiresDist: false,
        runner,
        ...(runtime ? { pretestBuildMode: "runtime" } : {}),
        ...(gateway || runtime
          ? { env: { OPENCLAW_VITEST_MAX_WORKERS: name === "gateway" ? "8" : "2" } }
          : {}),
      });
      const job = (
        name: string,
        groups: NodeTestShardGroup[],
        runtime = true,
      ): CompactNodeTestShard => ({
        checkName: name,
        shardName: name,
        runner,
        groups,
        requiresDist: false,
        planConcurrency: gateway || runtime ? 1 : 2,
        ...(runtime ? { pretestBuildMode: "runtime" } : {}),
        ...(name === "gateway" ? { env: { OPENCLAW_VITEST_MAX_WORKERS: "2" } } : {}),
      });
      const moved = group("moved"),
        retained = group("retained");
      const gatewayGroup = group("gateway", false);
      const ordinary = group("ordinary", false);
      const jobs = [
        job("donor", [moved, retained]),
        ...(gateway
          ? [job("gateway", packed ? [gatewayGroup, ordinary] : [gatewayGroup], false)]
          : [job("first-runtime", [group("spare")]), job("ordinary", [ordinary], false)]),
      ];
      const weights: Record<string, number> = gateway
        ? { moved: 180, retained: 250, gateway: 30, ordinary: 190 }
        : { moved: 100, retained: 330, spare: 80, ordinary: 50 };
      const cost = (groups: NodeTestShardGroup[]) =>
        (gateway ? 60 : 100) + groups.reduce((sum, entry) => sum + weights[entry.shard_name]!, 0);
      rebalanceRuntimeTestJobs(jobs, {
        cost,
        admits: (groups) => groups.length > 0 && cost(groups) <= (gateway ? 360 : 440),
        runnerRank: () => 0,
        prepareRecipient: (recipient) =>
          gateway
            ? recipient.planConcurrency === 1
              ? recipient.groups
              : undefined
            : recipient.planConcurrency === 2
              ? recipient.groups.map((entry) =>
                  Object.assign({}, entry, { env: { OPENCLAW_VITEST_MAX_WORKERS: "2" } }),
                )
              : recipient.groups,
      });
      expect(jobs.map((entry) => entry.groups.map((value) => value.shard_name))).toEqual(
        gateway
          ? packed
            ? [
                ["moved", "retained"],
                ["gateway", "ordinary"],
              ]
            : [["retained"], ["gateway", "moved"]]
          : [["retained"], ["spare"], ["ordinary", "moved"]],
      );
      if (gateway) {
        if (!packed) {
          expect(jobs.map((entry) => entry.predictedSeconds)).toEqual([310, 270]);
          expect(jobs[1]).toMatchObject({ pretestBuildMode: "runtime", planConcurrency: 1 });
        }
        expect(jobs[1]!.env).toEqual({ OPENCLAW_VITEST_MAX_WORKERS: "2" });
        expect(jobs[1]!.groups[0]).toEqual(gatewayGroup);
        expect(jobs[1]!.groups[0]!.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("8");
        expect(
          jobs
            .flatMap((entry) => entry.groups)
            .filter((entry) => entry.shard_name !== "gateway")
            .every((entry) => entry.env?.OPENCLAW_VITEST_MAX_WORKERS === "2"),
        ).toBe(true);
      } else {
        expect(jobs[2]).toMatchObject({
          pretestBuildMode: "runtime",
          planConcurrency: 1,
          predictedSeconds: 250,
        });
        expect(
          jobs[2]!.groups.every((entry) => entry.env?.OPENCLAW_VITEST_MAX_WORKERS === "2"),
        ).toBe(true);
      }
    },
  );
});

function samplerRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    path: ".github/workflows/ci.yml",
    run_attempt: 1,
    created_at: "2026-08-27T22:00:00Z",
    status: "completed",
    conclusion: "success",
    event: "schedule",
    head_branch: "main",
    head_sha: "a".repeat(40),
    ...overrides,
  };
}

const samplerRuns = (ids: number[], overrides: Record<string, unknown> = {}) =>
  ids.map((id) => samplerRun(id, overrides));

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
  gitDirectory?: string;
  observedAt?: string;
  runs: ReturnType<typeof samplerRun>[];
  jobs: ReturnType<typeof samplerJob>[];
  pushRuns?: ReturnType<typeof samplerRun>[];
  releaseRuns?: ReturnType<typeof samplerRun>[];
  packedReleaseRuns?: ReturnType<typeof samplerRun>[];
  toolingRuns?: ReturnType<typeof samplerRun>[];
  runPages?: ReturnType<typeof samplerRun>[][];
  jobPages?: Record<string, ReturnType<typeof samplerJob>[][]>;
  jobTotals?: Record<string, number>;
  baseline?: CiTestTimings;
};

function createSamplerFixture(fixture: SamplerFixture) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-ci-refit-")));
  const fakeGh = path.join(directory, "gh");
  const output = path.join(directory, "timings.json");
  const requests = path.join(directory, "requests.jsonl");
  const clock = path.join(directory, "clock.cjs");
  const original = `${JSON.stringify(fixture.baseline ?? baseline, null, 2)}\n`;
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(output, original);
  writeFileSync(requests, "");
  writeFileSync(
    clock,
    `const childProcess = require("node:child_process");
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) =>
  file === "git" && args[0] === "diff" && ${!fixture.gitDirectory}
    ? ""
    : execFileSync(file, args, options);
require("node:module").syncBuiltinESMExports();
const OriginalDate = Date;
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
  const packedRelease = ci && endpoint.searchParams.get("event") === "workflow_dispatch";
  const main = ci && !tooling && !packedRelease;
  const rows = tooling ? fixture.toolingRuns || [] : packedRelease ? fixture.packedReleaseRuns || [] : main ? endpoint.searchParams.get("event") === "push" ? fixture.pushRuns || [] : fixture.runs : endpoint.pathname.includes("/openclaw-release-checks.yml/") ? fixture.releaseRuns || [] : [];
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
  const run = (fixture.toolingRuns || []).find(run => run.id === Number(id));
  if (!run) process.exit(2);
  console.log(JSON.stringify(run));
} else {
  console.error("Unexpected gh request", args);
  process.exit(2);
}\n`,
  );
  chmodSync(fakeGh, 0o755);
  return {
    original,
    contents: () => readFileSync(output, "utf8"),
    requestUrls: () =>
      readFileSync(requests, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as string[])[1] ?? ""),
    invoke: (dryRun = false, count = 2, toolingRunIds: number[] = []) =>
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
          cwd: fixture.gitDirectory ?? fileURLToPath(new URL("../../", import.meta.url)),
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, OPENCLAW_GH_BIN: fakeGh, GH_TOKEN: "fixture-token" },
        },
      ),
  };
}

describe("CI test timing refit", () => {
  it("learns default Bun spans separately and preserves unobserved Node timing history", () => {
    const previous: CiTestTimings = compactBaseline({ retained: 90, "bun:legacy-subset": 5 });
    const runs = repeatedRuns(
      `2026-08-27T23:00:00Z OPENCLAW_CI_TEST_RUNTIME_POLICY: bun-all\n${compactLog(30, "bun:core-unit-src-security-2")}`,
      "blacksmith-4vcpu-ubuntu-2404",
      3,
    );
    const result = refitTestTimings(runs, previous);
    expect(result.timings.compactGroupSeconds.blacksmith).toEqual({
      retained: 90,
      "bun:legacy-subset": 5,
      "bun-all:core-unit-src-security-2": 30,
    });
    expect(result.contributingRunIds.blacksmith).toEqual([1, 2, 3]);
  });

  it("keeps the partial Bun pass in dual validation out of complete Bun timing history", () => {
    const descriptor = {
      shard_name: "owner",
      configs: ["test/vitest/vitest.unit-fast.config.ts"],
      includePatterns: ["bun.test.ts", "native.test.ts", "node.test.ts"],
      env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
    };
    const text = [
      `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([descriptor])}`,
      "2026-08-27T23:00:00Z OPENCLAW_CI_TEST_RUNTIME_POLICY: dual-all",
      "2026-08-27T23:00:00Z [shard:owner] begin",
      "2026-08-27T23:00:01Z [shard:owner] [test] preparing runtime runtime before Vitest workers",
      "2026-08-27T23:00:20Z [shard:owner] end (exit 0)",
      "2026-08-27T23:00:22Z [shard:bun:owner] begin",
      "2026-08-27T23:00:40Z [shard:bun:owner] end (exit 0)",
      "2026-08-27T23:00:46Z [shard:bun-native:owner] begin",
      "2026-08-27T23:00:50Z [shard:bun-native:owner] end (exit 0)",
    ].join("\n");
    const previous: CiTestTimings = compactBaseline({ "bun-all:owner": 70 });
    const result = refitTestTimings(repeatedRuns(text, "blacksmith-4vcpu-ubuntu-2404"), previous);
    expect(result.timings.compactGroupSeconds.blacksmith).toEqual({
      owner: 20,
      "bun-all:owner": 70,
      "dual-all:owner": 50,
    });
    expect(result.timings.runtimePlacementTimings.blacksmith).toEqual([
      runtimeTiming(descriptor, 50, {
        ...descriptor.env,
        OPENCLAW_CI_TEST_RUNTIME_POLICY: "dual-all",
      }),
      runtimeTiming(descriptor, 20, descriptor.env),
    ]);
  });

  it.each([
    "missing runtime",
    "unfinished runtime",
    "failed runtime",
    "missing receipt",
    "partial Node selection",
    "wrong workers",
  ])("retains packed release costs on %s", (fault) => {
    const fixture = packedReleaseFixture();
    let text = fixture.text;
    if (fault === "missing runtime") {
      text = text
        .split("\n")
        .filter((line) => !line.includes("[shard:bun:"))
        .join("\n");
    } else if (fault === "unfinished runtime") {
      text = text.replace(`[shard:bun:${fixture.timingKeys[0]}] end (exit 0)`, "missing end");
    } else if (fault === "failed runtime") {
      text = text.replace(
        `[shard:bun:${fixture.timingKeys[0]}] end (exit 0)`,
        `[shard:bun:${fixture.timingKeys[0]}] end (exit 1)`,
      );
    } else if (fault === "missing receipt") {
      text = text.split("\n").slice(0, -1).join("\n");
    } else if (fault === "partial Node selection") {
      text = text.replaceAll(
        `[shard:${fixture.timingKeys[0]}]`,
        `[shard:node-subset:${fixture.timingKeys[0]}]`,
      );
    } else if (fault === "wrong workers") {
      text = text.replace("OPENCLAW_VITEST_MAX_WORKERS: 3", "OPENCLAW_VITEST_MAX_WORKERS: 1");
    }
    const previous: CiTestTimings = compactBaseline({}, { [fixture.timingKeys[0]!]: 400 });
    const runs = [1, 2, 3].map((id) =>
      timingRun(id, [timingLog(text, "ubuntu-24.04", "release-packed")]),
    );
    expectCompact(runs, previous.compactGroupSeconds.github, previous, "github");
  });

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

  it("refits complete explicit plugin PR work without trusting ordinal or family names", () => {
    const configs = ["test/vitest/vitest.extension-database-workers.config.ts"];
    const files = [
      "extensions/telegram/src/native-a.test.ts",
      "extensions/telegram/src/native-b.test.ts",
    ];
    const env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
    const key = extensionTimingKey(configs[0]!, files, env)!;
    const runs = [1, 2].map((id) => {
      const name = `changed-extensions-config-${id * 20}`;
      const text = [
        "2026-08-27T23:00:00Z OPENCLAW_VITEST_MAX_WORKERS: 2",
        `2026-08-27T23:00:00Z OPENCLAW_VITEST_SHARD_NAME: ${name}`,
        `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_CONFIGS_JSON: ${JSON.stringify(configs, null, 2)}`,
        `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: ${JSON.stringify(files, null, 2)}`,
        "2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_ENV_JSON: null",
        compactLog(id === 1 ? 180 : 220, name),
        // Nested tests cannot overwrite their containing job's resource/worker provenance.
        "2026-08-27T23:04:00Z [shard:fixture] OPENCLAW_VITEST_MAX_WORKERS: 8",
        `2026-08-27T23:04:01Z [shard:fixture] [shard:${name}] begin`,
        `2026-08-27T23:59:00Z [shard:fixture] [shard:${name}] end (exit 0)`,
        `2026-08-27T23:04:01Z [shard:fixture] job\tstep\t2026-08-27T23:04:01Z [shard:${name}] begin`,
        `2026-08-27T23:59:00Z [shard:fixture] job\tstep\t2026-08-27T23:59:00Z [shard:${name}] end (exit 0)`,
      ].join("\n");
      return Object.assign(timingRun(id, [timingLog(text, "blacksmith-8vcpu-ubuntu-2404")]), {
        completeInventory: false,
        pullRequestMergeRef: true,
      });
    });
    expectCompact([runs[0]!, runs[0]!], {});
    const result = refitTestTimings(runs);
    expect(result.timings.compactGroupSeconds.blacksmith).toEqual({ [key]: 200 });
    expect(result.timings.runtimePlacementTimings.blacksmith).toEqual([]);
    for (const run of runs) {
      run.completeInventory = true;
      run.pullRequestMergeRef = false;
    }
    expectCompact(runs, { [key]: 200 });
  });

  it("keeps mixed worker ceilings out of compact weights and keys runtime observations by their inherited ceiling", () => {
    const descriptor = {
      configs: ["test/vitest/reader.config.ts"],
      includePatterns: ["src/reader.test.ts"],
      shard_name: "reader",
      timing_key: splitTimingGeneration({
        configs: ["test/vitest/reader.config.ts"],
        parentShardName: "reader-parent",
        stripes: [["src/reader.test.ts"]],
      }).timingKeys[0]!,
    };
    const previous: CiTestTimings = compactBaseline({
      [descriptor.timing_key]: 100,
      "reader-parent": 100,
    });
    const qualifiedGroup = (patch: Partial<NodeTestShardGroup> = {}) => ({
      ...descriptor,
      fallbackMaxWorkers: 2,
      minTotalMemoryBytes: 28 * 1024 ** 3,
      ...patch,
    });
    const replaceGroup = (group: ReturnType<typeof qualifiedGroup>) =>
      log(8).replace(encodeNodeTestGroups([descriptor]), encodeNodeTestGroups([group]));
    const resources = (
      text: string,
      gib = 32,
      plans = 1,
      cpus = 8,
      runner: string | undefined = "self-hosted",
      frozen = "false",
    ) =>
      [
        ...(runner ? [`2026-08-27T23:00:00Z RUNNER_ENVIRONMENT: ${runner}`] : []),
        `2026-08-27T23:00:00Z FROZEN_TARGET: ${frozen}`,
        ...(gib
          ? [
              `2026-08-27T23:00:00Z [shard:resources] logicalCpuCount=${cpus} totalMemoryBytes=${gib * 1024 ** 3} requested plans=${plans} admitted plans=${plans}`,
            ]
          : []),
        text,
      ].join("\n");
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
      timingRun(index + 1, [timingLog(log(workers)), timingLog(log(4), "ubuntu-24.04")]),
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
      runtimeTiming(descriptor, 40, { OPENCLAW_VITEST_MAX_WORKERS: "8" }),
    ]);
    // Both the job JSON and group pins can lower, but never raise, an inherited ceiling.
    const pinned = refitTestTimings(
      [log(8, 2), log(2, 8), log(8, 8, 2)].map((text, index) => compactRun(index + 1, text)),
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
        compactRun(
          index + 1,
          text.replaceAll(
            `[shard:${descriptor.timing_key}]`,
            `[shard:bun:${descriptor.timing_key}]`,
          ),
        ),
      ),
    );
    expect(subset.rejectedWorkerKeys.blacksmith).toEqual([]);
    expect(subset.timings.compactGroupSeconds.blacksmith).toEqual({
      [`bun:${descriptor.timing_key}`]: 40,
      "bun:reader-parent": 40,
    });
    expect(subset.timings.runtimePlacementTimings.blacksmith).toEqual([]);
    const admissionLog = replaceGroup(qualifiedGroup());
    for (const [label, gib, plans, cpus, runner, frozen, expected] of [
      ["qualified", 32, 1, 8, "self-hosted", "false", 8],
      ["memory floor", 27, 1, 8, "self-hosted", "false", 2],
      ["overlapping plans", 32, 2, 8, "self-hosted", "false", 2],
      ["constrained CPU", 32, 1, 4, "self-hosted", "false", 2],
      ["hosted", 32, 1, 8, "github-hosted", "false", 2],
      ["frozen target", 32, 1, 8, "self-hosted", "true", 2],
      ["missing resources", 0, 1, 8, "self-hosted", "false", undefined],
      ["missing runner", 32, 1, 8, "", "false", undefined],
    ] satisfies [
      string,
      number | undefined,
      number,
      number,
      string | undefined,
      string,
      number | undefined,
    ][]) {
      const text = resources(admissionLog, gib, plans, cpus, runner, frozen);
      const result = refitTestTimings(repeatedRuns(text), previous);
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
    const wholeConfigLog = replaceGroup(qualifiedGroup({ includePatterns: undefined }));
    const wholeConfigRuns = [27, 32].map((gib, index) =>
      compactRun(index + 1, resources(wholeConfigLog, gib)),
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
      const namedKey = splitTimingGeneration({
        configs: descriptor.configs,
        parentShardName: `reader${suffix}`,
        stripes: [descriptor.includePatterns],
      }).timingKeys[0]!;
      const namedLog = replaceGroup(
        qualifiedGroup({
          timing_key: namedKey,
          env: { OPENCLAW_VITEST_MAX_WORKERS: "4" },
        }),
      ).replaceAll(`[shard:${descriptor.timing_key}]`, `[shard:${namedKey}]`);
      const previousNamed: CiTestTimings = compactBaseline({ [namedKey]: 100 });
      for (const gib of [27, 32]) {
        const text = resources(namedLog, gib);
        const samples = repeatedRuns(text);
        const result = refitTestTimings(samples, previousNamed);
        expect(result.timings.compactGroupSeconds.blacksmith[namedKey], `${suffix} ${gib}GiB`).toBe(
          gib === 27 ? 100 : 40,
        );
        expect(result.rejectedWorkerKeys.blacksmith.includes(namedKey)).toBe(gib === 27);
      }
      const missingWorkers = refitTestTimings(
        repeatedRuns(compactLog(40, namedKey)),
        previousNamed,
      );
      expect(missingWorkers.timings.compactGroupSeconds.blacksmith[namedKey]).toBe(100);
      expect(missingWorkers.rejectedWorkerKeys.blacksmith).toContain(namedKey);
    }
  });

  it("retains measured parent costs across split inventory changes without double-counting retries", () => {
    const parentShardName = "agentic-control-plane-agent-chat";
    const generations = [0, 1, 2].map((index) =>
      splitTimingGeneration({
        parentShardName,
        configs: ["test/vitest/vitest.gateway-server.config.ts"],
        stripes: [["a.test.ts"], [`added-${index}.test.ts`]],
      }),
    );
    const runs = generations.map((generation, index) =>
      timingRun(
        index + 1,
        generation.timingKeys.flatMap((key, part) => [
          timingLog(compactLog(100 + part * 100 + index * 10, key)),
          timingLog(compactLog(100 + part * 100 + index * 10, key)),
          timingLog(compactLog(300 + part * 100, key), "ubuntu-24.04"),
        ]),
      ),
    );
    const previous = compactBaseline({ [parentShardName]: 167 });
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
    const configs = ["test/vitest/vitest.cli.config.ts"];
    const files = ["src/cli/selected.test.ts"];
    const child = splitTimingGeneration({
      configs,
      parentShardName: parent,
      stripes: [files],
    }).timingKeys[0]!;
    const descriptor = {
      shard_name: "selected-cli",
      timing_key: child,
      configs,
      includePatterns: files,
    };
    const selectionLine = `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([descriptor])}`;
    const previous: CiTestTimings = compactBaseline({ [parent]: 1_000 });
    const runs = [20, 40, 60].map((seconds, index) =>
      Object.assign(
        compactRun(
          index + 1,
          `${selectionLine}\n2026-08-27T23:00:00Z OPENCLAW_VITEST_MAX_WORKERS: 2\n${compactLog(seconds, child)}\n${compactLog(600, parent)}`,
          "blacksmith-8vcpu-ubuntu-2404",
        ),
        { pullRequestMergeRef: true, completeInventory: false },
      ),
    );
    // Neither selected generations nor repeated unsplit PR spans prove the
    // full owner inventory. Only the exact selected child can refit.
    const expected = {
      [parent]: 1_000,
      [child]: 40,
    };
    expectCompact(runs, expected, previous);
    const fragments = runs.flatMap((run) => [{ ...run, pullRequestMergeRef: false }, run]);
    expectCompact(fragments, expected, previous);
    const missingWorkers = runs.map((run) => ({
      ...run,
      logs: run.logs.map((log) => ({
        ...log,
        text: log.text.replace("2026-08-27T23:00:00Z OPENCLAW_VITEST_MAX_WORKERS: 2\n", ""),
      })),
    }));
    expectCompact(missingWorkers, previous.compactGroupSeconds.blacksmith, previous);
    for (const [reason, selection] of [
      ["missing descriptor", ""],
      [
        "malformed descriptor",
        "2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: invalid",
      ],
      [
        "duplicate descriptor",
        `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([descriptor, descriptor])}`,
      ],
      [
        "different files",
        `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([{ ...descriptor, includePatterns: ["src/cli/other.test.ts"] }])}`,
      ],
      [
        "glob files",
        `2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: ${encodeNodeTestGroups([{ ...descriptor, includePatterns: ["src/cli/*.test.ts"] }])}`,
      ],
      [
        "filtered invocation",
        `${selectionLine}\n2026-08-27T23:00:00Z OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: ["--shard=1/2"]`,
      ],
    ] as const) {
      const incomplete = runs.map((run) => ({
        ...run,
        logs: run.logs.map((log) => ({ ...log, text: log.text.replace(selectionLine, selection) })),
      }));
      expect(
        refitTestTimings(incomplete, previous).timings.compactGroupSeconds.blacksmith,
        reason,
      ).toEqual(previous.compactGroupSeconds.blacksmith);
    }
    const main = runs.map((run) => Object.assign({}, run, { pullRequestMergeRef: false }));
    expectCompact(main, { [parent]: 600, [child]: 40 }, previous);
  });

  it("does not invent a complete parent measurement across runner profiles", () => {
    const common = {
      parentShardName: "agentic-control-plane-agent-chat",
      configs: ["test/vitest/vitest.gateway-server.config.ts"],
    };
    const generation = splitTimingGeneration({
      ...common,
      stripes: [["a.test.ts"], ["b.test.ts"]],
    });
    const runs = [1, 2, 3].map((id) =>
      timingRun(id, [
        timingLog(compactLog(100, generation.timingKeys[0]!)),
        timingLog(compactLog(200, generation.timingKeys[1]!), "ubuntu-24.04"),
      ]),
    );
    const result = refitTestTimings(runs).timings.compactGroupSeconds;
    expect(result.blacksmith).not.toHaveProperty(common.parentShardName);
    expect(result.github).not.toHaveProperty(common.parentShardName);
    const previous = compactBaseline({ [common.parentShardName]: 500 });
    expect(
      refitTestTimings(runs, previous).timings.compactGroupSeconds.blacksmith[
        common.parentShardName
      ],
    ).toBe(500);
  });

  it.each([false, true])(
    "retains absent timings when duplicate run fragments include partial inventories (partial first: %s)",
    (partialFirst) => {
      const previous: CiTestTimings = compactBaseline({ observed: 10, retained: 90 });
      const runs = [1, 2, 3].flatMap((id) => {
        const complete = compactRun(id, compactLog(40, "observed"), "blacksmith-8vcpu-ubuntu-2404");
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
        timingLog(`${compactLog(20)}\n${runtimeSpan(id)}`, "ubuntu-24.04"),
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
        timingLog(`${compactLog(20)}\n${runtimeSpan(run.id)}`, "ubuntu-24.04"),
      ]),
    );

    expect(JSON.stringify(refitTestTimings(reordered))).toBe(JSON.stringify(first));
    expect(
      refitTestTimings(
        runs.map((run) => timingRun(run.id + 2, run.logs)),
        first.timings,
      ).timings,
    ).toEqual(first.timings);
  });
});

describe("CI timing sampler provenance", () => {
  type Fixture = ReturnType<typeof createSamplerFixture>;
  const pair = () => ({
    runs: samplerRuns([1, 2]),
    jobs: [samplerJob(11, 1), samplerJob(21, 2)],
  });
  const makeFixture = (overrides: Partial<SamplerFixture>) =>
    createSamplerFixture({ ...pair(), ...overrides });
  const uiJob = (
    id: number,
    runId: number,
    files: Record<string, number>,
    overrides: Record<string, unknown> = {},
  ) => samplerJob(id, runId, { name: "checks-ui-e2e (1/9)", log: uiLog(files), ...overrides });
  const invoke = (fixture: Fixture, ...args: Parameters<Fixture["invoke"]>) => {
    const result = fixture.invoke(...args);
    expect(result.status, result.stderr).toBe(0);
    return result;
  };
  const readTimings = (fixture: Fixture) =>
    ciTestTimingsSchema.parse(JSON.parse(fixture.contents()));
  const reject = (
    fixture: Fixture,
    message: string | RegExp,
    noLogs = true,
    ...args: Parameters<Fixture["invoke"]>
  ) => {
    const result = fixture.invoke(...args);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(message);
    if (noLogs) {
      expect(fixture.requestUrls().some((url) => url.endsWith("/logs"))).toBe(false);
    }
    expect(fixture.contents()).toBe(fixture.original);
  };
  const expectWindow = (url: string) =>
    expect(new URL(url, "https://api.github.com").searchParams.get("created")).toBe(
      `2026-08-21T12:00:00.000Z..${sampleNow}`,
    );
  it("skips noncontributing dispatches to discover packed release jobs without repricing partial siblings", () => {
    const { timingKeys, text } = packedReleaseFixture();
    const fixture = makeFixture({
      packedReleaseRuns: samplerRuns([13, 14, 11, 12], {
        event: "workflow_dispatch",
        conclusion: "failure",
      }),
      jobs: [
        samplerJob(1, 1),
        samplerJob(2, 2),
        samplerJob(130, 13),
        samplerJob(140, 14),
        ...[11, 12].map((id) =>
          samplerJob(id * 10, id, {
            name: "checks-node-release-packed-1",
            labels: ["ubuntu-24.04"],
            log: text,
          }),
        ),
        samplerJob(111, 11, {
          name: "checks-node-release-packed-2",
          conclusion: "failure",
          log: text,
        }),
      ],
    });
    invoke(fixture);
    expect(JSON.parse(fixture.contents()).compactGroupSeconds.github).toEqual({
      [`dual-all:${timingKeys[0]}`]: 32,
      [`dual-all:${timingKeys[1]}`]: 30,
    });
    const requests = fixture.requestUrls();
    expect(
      requests.some((url) => url.includes("ci.yml/runs?event=workflow_dispatch&status=completed")),
    ).toBe(true);
    expect(requests.some((url) => url.endsWith("/jobs/111/logs"))).toBe(false);
  });

  const retained: CiTestTimings = {
    ...compactBaseline({ "core-unit-src-security-2": 20 }, { retained: 90 }),
    runtimePlacementTimings: {
      blacksmith: [
        runtimeTiming(
          { configs: ["test/vitest/reader.config.ts"], includePatterns: ["src/reader.test.ts"] },
          80,
        ),
      ],
      github: [],
    },
  };

  it.each([
    ["main", "schedule", "checks-node-compact-small-1", compactLog(40)],
    [
      "release",
      "workflow_dispatch",
      "Repo E2E (Gateway 1/4)",
      "✓ test/release.e2e.test.ts (1 test) 40000ms\nDuration 40s",
    ],
    ["tooling", "pull_request", "checks-node-compact-small-1", samplerToolingLog(40)],
  ] as const)(
    "refills %s samples after a cohort completes beyond the frozen cutoff",
    (source, event, name, log) => {
      const sourceRuns = [1, 4, 5].map((id) =>
        samplerRun(id, {
          run_attempt: id === 1 ? 2 : 1,
          event,
        }),
      );
      const sourceJob = (id: number, runId: number, overrides: Record<string, unknown> = {}) =>
        samplerJob(id, runId, {
          name,
          log,
          ...overrides,
        });
      const fixture = createSamplerFixture({
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
      });
      const result = invoke(fixture);
      const timings = readTimings(fixture);
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
      const requests = fixture.requestUrls();
      expect(requests.some((url) => url.includes("/runs/1/attempts/2/jobs?"))).toBe(true);
      expect(requests.some((url) => /\/jobs\/(?:11|12)\/logs$/u.test(url))).toBe(false);
      expect(requests.some((url) => url.endsWith("/jobs/51/logs"))).toBe(true);
      for (const requestUrl of requests.filter((url) => url.includes("/workflows/"))) {
        expectWindow(requestUrl);
      }
    },
  );

  it("refuses an explicitly requested tooling run that completes after the frozen cutoff", () => {
    const fixture = createSamplerFixture({
      observedAt: "2026-08-28T12:01:00.000Z",
      runs: [],
      toolingRuns: [samplerRun(1, { event: "pull_request" })],
      jobs: [
        samplerJob(11, 1, { log: samplerToolingLog(40) }),
        samplerJob(12, 1, { completed_at: "2026-08-28T12:00:30.000Z" }),
      ],
    });
    reject(
      fixture,
      `Requested tooling run 1 has jobs completed after frozen UTC cutoff ${sampleNow}.`,
      true,
      false,
      2,
      [1],
    );
  });

  it("rejects corrupt provenance even when an earlier job is beyond the frozen cutoff", () => {
    const fixture = createSamplerFixture({
      observedAt: "2026-08-28T12:01:00.000Z",
      runs: [samplerRun(1)],
      jobs: [
        samplerJob(11, 1, { completed_at: "2026-08-28T12:00:30.000Z" }),
        samplerJob(12, 1, { head_sha: "b".repeat(40) }),
      ],
    });
    reject(fixture, "does not match its cohort");
  });

  it("collects successful jobs from failed main workflows without pruning absent timings", () => {
    const fixture = createSamplerFixture({
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
        samplerRun(6),
        samplerRun(7),
        ...samplerRuns([1, 2, 3, 4, 5], { conclusion: "failure", run_attempt: 2 }),
      ],
      pushRuns: Array.from({ length: 1_001 }, (_, index) =>
        samplerRun(index + 10, { event: "push", conclusion: "cancelled" }),
      ),
      jobs: [
        samplerJob(61, 6, { name: "docs", log: "No test results" }),
        samplerJob(71, 7, { log: "No complete compact spans" }),
        ...[1, 2, 3, 4, 5].flatMap((id) => [
          samplerJob(id * 10 + 1, id, { log: compactLog(10 + id * 20) }),
          samplerJob(id * 10 + 5, id, {
            run_attempt: 2,
            labels: ["ubuntu-24.04"],
            log: compactLog(50),
          }),
          samplerJob(id * 10 + 2, id, { conclusion: "failure", log: compactLog(900) }),
          samplerJob(id * 10 + 3, id, { conclusion: "cancelled", log: compactLog(900) }),
          samplerJob(id * 10 + 4, id, {
            status: "in_progress",
            conclusion: null,
            completed_at: null,
          }),
        ]),
      ],
    });
    invoke(fixture, true, 5);
    expect(fixture.contents()).toBe(fixture.original);
    const requests = fixture.requestUrls();
    invoke(fixture, false, 5);
    const timings = readTimings(fixture);
    expect(timings.compactGroupSeconds).toEqual({
      blacksmith: { "core-unit-src-security-2": 70, unobserved: 90 },
      github: { ...retained.compactGroupSeconds.github, "core-unit-src-security-2": 50 },
    });
    expect(timings.runtimePlacementTimings).toEqual(retained.runtimePlacementTimings);
    expect(requests.some((url) => url.includes("event=push"))).toBe(false);
    const mainPages = requests.filter((url) => url.includes("event=schedule"));
    expect(mainPages).toHaveLength(2);
    for (const attempt of [1, 2]) {
      expect(requests.some((url) => url.includes(`/runs/3/attempts/${attempt}/jobs?`))).toBe(true);
    }
    expect(requests.some((url) => /\/runs\/(?:1\d\d|9)\/attempts\//u.test(url))).toBe(false);
    const updated = fixture.contents();
    invoke(fixture, false, 5);
    expect(fixture.contents()).toBe(updated);
  });

  it("requires two PR runs before repricing tooling from compact logs", () => {
    const runs = [1, 2, 3, 4].map((id) =>
      Object.assign(compactRun(id, samplerToolingLog(id * 10), "blacksmith-8vcpu-ubuntu-2404"), {
        pullRequestMergeRef: id > 2,
        completeInventory: id <= 2,
      }),
    );
    expect(refitTestTimings(runs.slice(0, 3)).timings.toolingFileSeconds).toEqual({
      blacksmith: {},
      github: {},
    });
    const result = refitTestTimings(runs);
    expect(result.timings.toolingFileSeconds).toEqual({
      blacksmith: { [toolingFile]: 35 },
      github: {},
    });
    expect(result.contributingRunIds.toolingBlacksmith).toEqual([3, 4]);
  });

  it.each(["release", "tooling"])(
    "keeps failed %s workflows out of the sampling cohort",
    (source) => {
      const failed = samplerRun(9, {
        conclusion: "failure",
        event: source === "release" ? "workflow_dispatch" : "pull_request",
      });
      const fixture = makeFixture({
        jobs: [...pair().jobs, samplerJob(91, 9)],
        ...(source === "release" ? { releaseRuns: [failed] } : { toolingRuns: [failed] }),
      });
      reject(fixture, "conclusion", false);
      expect(fixture.requestUrls().some((url) => url.includes("/runs/9/"))).toBe(false);
    },
  );

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
      reject(makeFixture({ runs: [samplerRun(1, metadata), samplerRun(2)] }), field);
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
      reject(
        makeFixture({
          jobs: [job, samplerJob(21, 2)],
          jobPages: { "1:1": [[job]] },
          jobTotals: { "1:1": 1 },
        }),
        /cohort|frozen UTC window/u,
      );
    },
  );

  it("refits unchanged UI neighbors without fetching historical blobs for moved tests", () => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-refit-history-")));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const origin = path.join(directory, "origin");
    const checkout = path.join(directory, "checkout");
    const oldFile = "ui/src/old.e2e.test.ts";
    const newFile = "extensions/demo/new.e2e.test.ts";
    const changed = "ui/src/changed.e2e.test.ts";
    const deleted = "ui/src/deleted.e2e.test.ts";
    const prices = {
      [oldFile]: 8,
      [newFile]: 9,
      [changed]: 10,
      [deleted]: 11,
      [measuredFile]: 100,
    };
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(origin, file)), { recursive: true });
      writeFileSync(path.join(origin, file), text);
    };
    const commit = (message: string) => {
      git(origin, "add", "-A");
      git(origin, "commit", "-qm", message);
      return git(origin, "rev-parse", "HEAD");
    };
    fs.mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.name", "Timing Fixture");
    git(origin, "config", "user.email", "fixture@example.com");
    git(origin, "config", "uploadpack.allowFilter", "true");
    const content = Array.from({ length: 100 }, (_, index) => `line ${index}\n`).join("");
    for (const file of [oldFile, changed, deleted, measuredFile]) {
      write(file, file === oldFile ? content : `${file}\n${content}`);
    }
    const beforeMove = commit("measured source");
    const oldBlob = git(origin, "rev-parse", `HEAD:${oldFile}`);
    write(newFile, `${content}moved\n`);
    fs.unlinkSync(path.join(origin, oldFile));
    const afterMove = commit("move test");
    write(newFile, `${content}moved and edited\n`);
    write(changed, "changed\n");
    fs.unlinkSync(path.join(origin, deleted));
    const head = commit("current source");
    git(
      directory,
      "clone",
      "-q",
      "--filter=blob:none",
      "--no-checkout",
      pathToFileURL(origin).href,
      checkout,
    );
    git(checkout, "checkout", "-q", head);
    git(checkout, "config", "diff.renames", "true");
    git(checkout, "remote", "set-url", "origin", path.join(directory, "unavailable"));
    const missing = () =>
      git(checkout, "rev-list", "--objects", "--all", "--missing=print")
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .toSorted();
    const absent = missing();
    expect(absent).toContain(`?${oldBlob}`);
    expect(git(checkout, "rev-list", "--count", "HEAD")).toBe("3");
    git(checkout, "merge-base", "--is-ancestor", beforeMove, head);
    expect(readFileSync(path.join(checkout, newFile), "utf8")).toBe(`${content}moved and edited\n`);
    const runs = [1, 2, 3, 4].map((id) =>
      samplerRun(id, { head_sha: id < 3 ? beforeMove : afterMove }),
    );
    const fixture = createSamplerFixture({
      runs,
      gitDirectory: checkout,
      baseline: {
        ...baseline,
        uiE2e: { ...baseline.uiE2e, fileSeconds: prices },
      },
      jobs: runs.flatMap(({ id, head_sha }) => [
        samplerJob(id * 10, id, { head_sha }),
        uiJob(
          id * 10 + 1,
          id,
          {
            [id < 3 ? oldFile : newFile]: 69,
            [changed]: 69,
            [deleted]: 69,
            [measuredFile]: 130,
          },
          { head_sha },
        ),
      ]),
    });
    invoke(fixture, false, 4);
    expect(readTimings(fixture).uiE2e.fileSeconds).toEqual({ ...prices, [measuredFile]: 130 });
    expect(missing()).toEqual(absent);
  });

  it("accepts both date boundaries without changing an unobserved profile", () => {
    const lower = "2026-08-21T12:00:00.000Z";
    const fixture = createSamplerFixture({
      runs: [samplerRun(1, { created_at: lower }), samplerRun(2, { created_at: sampleNow })],
      jobs: [
        samplerJob(11, 1, { started_at: lower, completed_at: lower }),
        samplerJob(21, 2, { started_at: sampleNow, completed_at: sampleNow }),
      ],
      baseline: compactBaseline({}, { retained: 90 }),
    });
    invoke(fixture);
    expect(JSON.parse(fixture.contents()).compactGroupSeconds.github).toEqual({ retained: 90 });
  });

  it.each(["different keys", "one run with retries", "release only"])(
    "rejects %s as evidence for a new compact measurement",
    (condition) => {
      const retry = condition === "one run with retries";
      const release = condition === "release only";
      const first = samplerRun(1, { run_attempt: retry ? 2 : 1 });
      const fixture = createSamplerFixture({
        runs: release ? [] : retry ? [first] : [first, samplerRun(2)],
        jobs: release
          ? [10, 11].map((id) =>
              samplerJob(id * 10, id, {
                name: "Repo E2E (Gateway 1/4)",
                log: "✓ test/release.e2e.test.ts (1 test) 4000ms\nDuration 5s",
              }),
            )
          : [
              samplerJob(11, 1),
              samplerJob(21, retry ? 1 : 2, {
                run_attempt: retry ? 2 : 1,
                log: compactLog(20, condition === "different keys" ? "different" : undefined),
              }),
            ],
        releaseRuns: release ? samplerRuns([10, 11], { event: "workflow_dispatch" }) : [],
      });
      reject(fixture, "newly eligible compact measurement", false);
      expect(fixture.requestUrls().some((url) => url.includes("/workflows/openclaw-"))).toBe(false);
    },
  );

  it("deduplicates overlapping run and job pages without treating retries as extra runs", () => {
    const first = samplerRun(1);
    const second = samplerRun(2);
    const compact = samplerJob(11, 1);
    const ui = uiJob(12, 1, { [measuredFile]: 130 }, { name: "checks-ui-e2e (1/6)" });
    const fixture = createSamplerFixture({
      runs: [first, second],
      runPages: [[first, first], [second]],
      jobs: [compact, ui, samplerJob(21, 2)],
      jobPages: { "1:1": [[compact, compact], [ui]] },
    });
    invoke(fixture);
    expect(fixture.requestUrls().filter((url) => url.endsWith("/jobs/11/logs"))).toHaveLength(1);
  });

  it.each(["run", "job"])("refuses incomplete %s pagination without writing", (kind) => {
    const first = samplerRun(1);
    const job = samplerJob(11, 1);
    const fixture = createSamplerFixture({
      runs: [first, samplerRun(2)],
      jobs: [job, samplerJob(21, 2)],
      ...(kind === "run"
        ? { runPages: [[first], []] }
        : { jobPages: { "1:1": [[job], []] }, jobTotals: { "1:1": 2 } }),
    });
    reject(fixture, "pagination incomplete", false);
  });

  it("keeps the 25-page job budget across all captured attempts", () => {
    const fixture = createSamplerFixture({ runs: [samplerRun(1, { run_attempt: 26 })], jobs: [] });
    reject(fixture, "Job pagination limit reached", false);
    const jobRequests = fixture.requestUrls().filter((url) => url.includes("/jobs?"));
    expect(jobRequests).toHaveLength(25);
    expect(jobRequests.at(-1)).toContain("/attempts/25/jobs?");
  });
});

describe("CI timing schema", () => {
  const invalidTimings: Array<[string, unknown]> = [
    [
      "non-plain file map",
      {
        ...baseline,
        uiE2e: {
          ...baseline.uiE2e,
          fileSeconds: Object.create({ inherited: 1 }),
        },
      },
    ],
    ["unknown root key", { ...baseline, extra: 1 }],
  ];

  it.each(invalidTimings)("rejects %s", (_name, value) => {
    expect(() => ciTestTimingsSchema.parse(value)).toThrow("Invalid CI test timings");
  });
});

describe("committed CI timing loader", () => {
  const emptyTimings = { ...baseline, uiE2e: { fileSeconds: {}, perFileOverheadSeconds: 0 } };
  function expectLoaded(loader: typeof testTimings, data: CiTestTimings) {
    expect(loader.readUiE2eFileTimings()).toEqual(data.uiE2e);
    expect(loader.readRepoE2eFileTimings()).toEqual(data.repoE2eFileSeconds);
    for (const profile of ["blacksmith", "github"] as const) {
      expect(loader.readCompactGroupTimings(profile)).toEqual(data.compactGroupSeconds[profile]);
      expect(loader.readToolingFileTimings(profile)).toEqual(data.toolingFileSeconds[profile]);
    }
  }
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function readTimings(contents: string) {
    vi.resetModules();
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
    vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", undefined);
    const { read, timingPath } = mockTimingFile(contents);
    const loader = await import("../../scripts/lib/ci-test-timings.mts");
    return { loader, read, timingPath };
  }

  it("ignores the entire wrong-version file without throwing", async () => {
    const { loader } = await readTimings(JSON.stringify({ ...baseline, version: 2 }));
    expectLoaded(loader, emptyTimings);
  });

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
    expectLoaded(loader, data);
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", "0");
    expectLoaded(loader, emptyTimings);
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
    expect(loader.readCompactGroupTimings("github")).toEqual({ group: 181 });
    expect(
      read.mock.calls.filter(([file]) => file instanceof URL && fileURLToPath(file) === timingPath),
    ).toHaveLength(1);
  });
  it("prefers matching runtime weights and retains historical estimates for unmeasured keys", async () => {
    const { loader } = await readTimings(
      JSON.stringify({
        ...baseline,
        compactGroupSeconds: {
          blacksmith: {
            group: 100,
            unmeasured: 150,
            "bun:group": 1,
            "bun-all:group": 60,
            "dual-all:group": 170,
          },
          github: {},
        },
        toolingFileSeconds: {
          blacksmith: { "file.test.ts": 50, "bun-all:file.test.ts": 30 },
          github: {},
        },
      }),
    );
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({ group: 100, unmeasured: 150 });
    vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", "bun-all");
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({ group: 60, unmeasured: 150 });
    expect(loader.readToolingFileTimings("blacksmith")).toEqual({ "file.test.ts": 30 });
    vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", "dual-all");
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({ group: 170, unmeasured: 150 });
    expect(loader.readToolingFileTimings("blacksmith")).toEqual({ "file.test.ts": 50 });
    vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME_POLICY", "node");
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({ group: 100, unmeasured: 150 });
  });
});
