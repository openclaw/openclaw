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
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { encodeNodeTestGroups } from "../../scripts/lib/ci-node-test-groups-codec.mts";
import { refitTestTimings, type CiTimingRun } from "../../scripts/lib/ci-test-timings-refit.mts";
import {
  CI_TIMING_PROFILES,
  ciTestTimingsSchema,
  type CiTestTimings,
  type RuntimePlacementTiming,
} from "../../scripts/lib/ci-test-timings-schema.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import { createCompactSplitTimingGeneration as splitTimingGeneration } from "../../scripts/lib/vitest-shard-metadata.mts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { toolingProbeRuntimeEntrypoints } from "./tooling-probe-runtime.test-support.mts";

// CI runtime selection must not choose the timing policy of independent fixtures.
beforeEach(() => vi.stubEnv("OPENCLAW_CI_TEST_RUNTIME", undefined));
afterEach(() => vi.unstubAllEnvs());

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
  compactGroupSeconds: { blacksmith: {}, github: {}, boat: {} },
  runtimePlacementTimings: { blacksmith: [], github: [], boat: [] },
  repoE2eFileSeconds: {},
  source: "median of 2 successful main CI runs: 1, 2",
  toolingFileSeconds: { blacksmith: {}, github: {}, boat: {} },
  uiE2e: { fileSeconds: { [measuredFile]: 100 }, perFileOverheadSeconds: 0.6 },
  updatedAt: "2026-08-22",
  version: 1,
};

const sampleNow = "2026-08-28T12:00:00.000Z";
const compactBaseline = (
  blacksmith: Record<string, number> = {},
  github: Record<string, number> = {},
): CiTestTimings => ({ ...baseline, compactGroupSeconds: { blacksmith, github, boat: {} } });

function boatLog(text: string, workers = 2): string {
  return [
    `2026-08-27T23:00:00Z OPENCLAW_VITEST_MAX_WORKERS: ${workers}`,
    `2026-08-27T23:00:00Z [shard:resources] logicalCpuCount=16 totalMemoryBytes=${31 * 1024 ** 3} requested plans=1 admitted plans=1`,
    text,
  ].join("\n");
}

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
import fs from "node:fs";
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
  it("reports complete and incomplete parent generations without changing their contribution", () => {
    const parentShardName = "agentic-control-plane-agent-chat";
    const complete = splitTimingGeneration({
      parentShardName,
      configs: ["test/vitest/vitest.gateway-server.config.ts"],
      stripes: [["a.test.ts"], ["b.test.ts"]],
    });
    const incomplete = splitTimingGeneration({
      parentShardName,
      configs: ["test/vitest/vitest.gateway-server.config.ts"],
      stripes: [["a.test.ts"], ["b.test.ts"], ["c.test.ts"]],
    });
    const fixture = makeFixture({
      jobs: [1, 2].map((id) =>
        samplerJob(id * 10, id, {
          completed_at: "2026-08-27T23:30:00Z",
          log: [
            compactLog(100 + (id - 1) * 10, complete.timingKeys[0]!),
            compactLog(100 + (id - 1) * 10, complete.timingKeys[0]!),
            compactLog(200 + (id - 1) * 10, complete.timingKeys[1]!),
            compactLog(999, incomplete.timingKeys[0]!),
            compactLog(400 + (id - 1) * 20, parentShardName),
          ].join("\n"),
        }),
      ),
    });
    const result = invoke(fixture);
    expect(readTimings(fixture).compactGroupSeconds.blacksmith[parentShardName]).toBe(410);
    expect(result.stdout).toContain(`| 1 | blacksmith | ${complete.selectorKey}#generation-`);
    expect(result.stdout).toContain("| 2/2 | 300 | 400 |");
    expect(result.stdout).toContain("| 2/2 | 320 | 420 |");
    expect(result.stdout.match(/\| 1\/3 \| 999 \| — \|/gu)).toHaveLength(2);
  });
  it("counts qualified Boat main contributors through the sampler and preserves old prices", () => {
    const fixture = makeFixture({
      jobs: [1, 2].map((id) =>
        samplerJob(id * 10, id, {
          labels: ["boat-xlarge"],
          log: boatLog(compactLog(40)),
        }),
      ),
      baseline: compactBaseline({ retained: 80 }, { retained: 90 }),
    });
    const result = invoke(fixture);
    expect(result.stdout).toContain("Boat: 2");
    expect(readTimings(fixture).compactGroupSeconds).toEqual({
      blacksmith: { retained: 80 },
      github: { retained: 90 },
      boat: { "core-unit-src-security-2": 40 },
    });
  });

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
        samplerJob(130, 13, { name: "unrelated-job" }),
        samplerJob(140, 14, { name: "unrelated-job" }),
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
    const result = invoke(fixture);
    expect(result.stdout).toContain(
      "Independent main compact contributors: 2 (Blacksmith: 2; GitHub: 0; Boat: 0).",
    );
    expect(result.stdout).toContain("Independent packed release contributors: 2;");
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

  it("collects full-dispatch compact runtime spans without repricing single-run or failed siblings", () => {
    const log = (runtime: "node" | "bun") =>
      [
        "2026-08-27T23:00:00Z OPENCLAW_CI_TEST_RUNTIME_POLICY: dual-all",
        "2026-08-27T23:00:00Z OPENCLAW_CI_TEST_RUNTIME: " + runtime,
        compactLog(
          runtime === "node" ? 30 : 40,
          (runtime === "bun" ? "bun:" : "") + "dispatch-fixture",
        ),
      ].join("\n");
    const fixture = makeFixture({
      packedReleaseRuns: samplerRuns([11, 12], { event: "workflow_dispatch" }),
      jobs: [
        samplerJob(11, 1),
        samplerJob(21, 2),
        ...[11, 12].flatMap((id) => [
          samplerJob(id * 10, id, {
            name: "checks-node-compact-small-1 (node)",
            labels: ["ubuntu-24.04"],
            log: log("node"),
          }),
          samplerJob(id * 10 + 1, id, {
            name: "checks-node-compact-small-1 (bun)",
            labels: ["ubuntu-24.04"],
            log: log("bun"),
            conclusion: id === 12 ? "failure" : "success",
          }),
        ]),
      ],
      baseline: compactBaseline({}, { retained: 90 }),
    });
    const result = invoke(fixture);
    expect(result.stdout).toContain(
      "Independent main compact contributors: 2 (Blacksmith: 2; GitHub: 0; Boat: 0).",
    );
    expect(result.stdout).toContain("Independent packed release contributors: 2;");
    expect(readTimings(fixture).compactGroupSeconds.github).toEqual({
      retained: 90,
      "dispatch-fixture": 30,
    });
    expect(fixture.requestUrls().some((url) => url.endsWith("/jobs/111/logs"))).toBe(true);
    expect(fixture.requestUrls().some((url) => url.endsWith("/jobs/121/logs"))).toBe(false);
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
      boat: [],
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
      boat: {},
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
      boat: {},
      github: {},
    });
    const result = refitTestTimings(runs);
    expect(result.timings.toolingFileSeconds).toEqual({
      blacksmith: { [toolingFile]: 35 },
      boat: {},
      github: {},
    });
    expect(result.contributingRunIds.toolingBlacksmith).toEqual([3, 4]);
  });

  it("collects successful jobs from failed PR workflows without pruning absent timings", () => {
    const fixture = makeFixture({
      baseline: {
        ...retained,
        toolingFileSeconds: { blacksmith: { unobserved: 90 }, github: {}, boat: {} },
      },
      toolingRuns: [
        ...Array.from({ length: 100 }, (_, index) =>
          samplerRun(100 + index, { event: "pull_request", conclusion: "cancelled" }),
        ),
        ...samplerRuns([3, 4], {
          event: "pull_request",
          conclusion: "failure",
          run_attempt: 2,
        }),
      ],
      jobs: [
        ...pair().jobs,
        ...[3, 4].flatMap((id) => [
          samplerJob(id * 10 + 1, id, { log: samplerToolingLog(20) }),
          samplerJob(id * 10 + 5, id, {
            run_attempt: 2,
            log: samplerToolingLog(60),
          }),
          samplerJob(id * 10 + 2, id, {
            conclusion: "failure",
            log: samplerToolingLog(900),
          }),
          samplerJob(id * 10 + 3, id, {
            conclusion: "cancelled",
            log: samplerToolingLog(900),
          }),
        ]),
      ],
    });
    const result = invoke(fixture);
    expect(readTimings(fixture).toolingFileSeconds).toEqual({
      blacksmith: { unobserved: 90, [toolingFile]: 40 },
      github: {},
      boat: {},
    });
    expect(result.stdout).toContain("Independent PR tooling contributors: 2");
    const requests = fixture.requestUrls();
    const prPages = requests.filter((url) => url.includes("event=pull_request"));
    expect(prPages).toHaveLength(2);
    for (const url of prPages) {
      expect(new URL(url, "https://api.github.com").searchParams.get("status")).toBe("completed");
      expectWindow(url);
    }
    expect(requests.some((url) => /\/jobs\/(?:32|33|42|43)\/logs$/u.test(url))).toBe(false);
    expect(requests.some((url) => /\/runs\/1\d\d\/attempts\//u.test(url))).toBe(false);
  });

  it.each(["release", "explicit tooling"])(
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
      reject(fixture, "conclusion", false, false, 2, source === "release" ? [] : [9]);
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

  it("samples exact split extension job names across retry attempts", () => {
    const log = (runtime: string) =>
      [
        "2026-08-27T23:00:00Z OPENCLAW_CI_TEST_RUNTIME_POLICY: dual-all",
        "2026-08-27T23:00:00Z OPENCLAW_CI_TEST_RUNTIME: " + runtime,
        compactLog(40, (runtime === "bun" ? "bun:" : "") + "split-extension"),
      ].join("\n");
    const fixture = createSamplerFixture({
      runs: samplerRuns([1, 2], { run_attempt: 2 }),
      jobs: [1, 2].flatMap((id) => [
        samplerJob(id * 10, id, {
          name: "checks-node-changed-extensions-config-1 (node)",
          log: log("node"),
        }),
        samplerJob(id * 10 + 1, id, {
          name: "checks-node-changed-extensions-bundle-1 (bun)",
          log: log("bun"),
          run_attempt: 2,
        }),
        samplerJob(id * 10 + 2, id, {
          name: "checks-node-changed-extensions-config-1 (bun) extra",
          log: "not a timing log",
        }),
      ]),
      baseline: compactBaseline({ "dual-all:split-extension": 100 }),
    });
    invoke(fixture);
    expect(readTimings(fixture).compactGroupSeconds.blacksmith).toEqual({
      "dual-all:split-extension": 100,
      "split-extension": 40,
      "dual-all:bun:split-extension": 40,
    });
    expect(fixture.requestUrls().filter((url) => /\/jobs\/(?:12|22)\/logs$/u.test(url))).toEqual(
      [],
    );
  });

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
    for (const profile of CI_TIMING_PROFILES) {
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
      compactGroupSeconds: {
        blacksmith: { group: 110 },
        github: { group: 181 },
        boat: { group: 55 },
      },
      repoE2eFileSeconds: { "test/example.e2e.test.ts": 90 },
      toolingFileSeconds: {
        blacksmith: { "test/scripts/ci-node-test-plan.test.ts": 300 },
        boat: { "test/scripts/ci-node-test-plan.test.ts": 75 },
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
          boat: {},
          github: {},
        },
        toolingFileSeconds: {
          blacksmith: { "file.test.ts": 50, "bun-all:file.test.ts": 30 },
          boat: {},
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
