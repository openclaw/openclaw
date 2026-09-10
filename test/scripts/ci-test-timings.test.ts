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
import { refitTestTimings, type CiTimingRun } from "../../scripts/lib/ci-test-timings-refit.mts";
import {
  ciTestTimingsSchema,
  type CiTestTimings,
} from "../../scripts/lib/ci-test-timings-schema.mts";
import { createCompactSplitTimingGeneration } from "../../scripts/lib/vitest-shard-metadata.mts";

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
  return { id, createdAt: `2026-08-${String(20 + id).padStart(2, "0")}T23:00:00Z`, logs };
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
  repoE2eFileSeconds: {},
  source: "median of 2 successful main CI runs: 1, 2",
  uiE2e: { fileSeconds: { [measuredFile]: 100 }, perFileOverheadSeconds: 0.6 },
  updatedAt: "2026-08-22",
  version: 1,
};

const sampleNow = "2026-08-28T12:00:00.000Z";

function samplerRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
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

type SamplerFixture = {
  runs: ReturnType<typeof samplerRun>[];
  jobs: ReturnType<typeof samplerJob>[];
  releaseRuns?: ReturnType<typeof samplerRun>[];
  runPages?: ReturnType<typeof samplerRun>[][];
  jobPages?: Record<string, ReturnType<typeof samplerJob>[][]>;
  jobTotals?: Record<string, number>;
  baseline?: CiTestTimings;
};

function withSamplerFixture(
  fixture: SamplerFixture,
  check: (context: {
    invoke: (dryRun?: boolean, count?: number) => SpawnSyncReturns<string>;
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
  static now() { return OriginalDate.parse(${JSON.stringify(sampleNow)}); }
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
  const main = endpoint.pathname.includes("/ci.yml/");
  const rows = main ? fixture.runs : endpoint.pathname.includes("/openclaw-release-checks.yml/") ? fixture.releaseRuns || [] : [];
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
      invoke: (dryRun = false, count = 2) =>
        spawnSync(
          process.execPath,
          [
            "--require",
            clock,
            "--import",
            "tsx",
            "scripts/ci-refit-test-timings.mts",
            "--runs",
            String(count),
            "--repo",
            "fixture/repo",
            "--out",
            output,
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

it("rejects a populated baseline without fresh compact contributors before writing", () => {
  withSamplerFixture({ runs: [samplerRun(1), samplerRun(2)], jobs: [] }, (fixture) => {
    const result = fixture.invoke();
    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(result.stderr).toContain("compact");
    expect(fixture.contents()).toBe(fixture.original);
  });
});

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
    { parallelProject: "ui-e2e-bundled", serialProject: "ui-e2e-serial", mixed: false },
    { parallelProject: "ui-e2e-bundled", serialProject: "ui-e2e-serial", mixed: true },
    {
      parallelProject: "ui-e2e-standalone",
      serialProject: "ui-e2e-serial-standalone",
      mixed: false,
    },
    {
      parallelProject: "ui-e2e-standalone",
      serialProject: "ui-e2e-serial-standalone",
      mixed: true,
    },
    ...["ui-e2e-real-gateway", "ui-e2e-real-gateway-standalone"].flatMap((parallelProject) =>
      [false, true].map((mixed) => ({
        parallelProject,
        serialProject: "ui-e2e-serial-standalone",
        mixed,
      })),
    ),
  ])(
    "keeps $parallelProject weights without refitting $serialProject overhead (mixed: $mixed)",
    ({ parallelProject, serialProject, mixed }) => {
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

  it.each([0, 1, 2, 3])(
    "prunes absent keys only after at least three contributing runs per profile (%s)",
    (count) => {
      const previous: CiTestTimings = {
        ...baseline,
        compactGroupSeconds: {
          blacksmith: { observed: 20, deleted: 30 },
          github: { observed: 20, deleted: 40 },
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
        count >= 3 ? { observed: 20 } : previous.compactGroupSeconds.github,
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

  it.each([1, 2])("keeps keys observed in %s of three runs", (observedRuns) => {
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
        id > observedRuns
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
    const runs = [2, 1].map((id) =>
      timingRun(id, [
        { kind: "compact", labels: ["ubuntu-24.04"], text: compactLog(20) },
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
        { kind: "compact", labels: ["ubuntu-24.04"], text: compactLog(20) },
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
  it.each([
    ["manual main dispatch", { event: "workflow_dispatch" }, "event"],
    ["pull request", { event: "pull_request" }, "event"],
    ["another branch", { head_branch: "feature" }, "head_branch"],
    ["missing SHA", { head_sha: null }, "head_sha"],
    ["missing attempt", { run_attempt: undefined }, "run_attempt"],
    ["zero attempt", { run_attempt: 0 }, "run_attempt"],
    ["incomplete run", { status: "in_progress" }, "status"],
    ["failed run", { conclusion: "failure" }, "conclusion"],
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
  const invalidTimings: Array<[string, string]> = [
    ["non-object root", "null"],
    ["unknown root key", JSON.stringify({ ...baseline, extra: 1 })],
    ["empty source", JSON.stringify({ ...baseline, source: "" })],
    ...["2026-02-29", "1900-02-29", "2026-04-31", "2026-8-22", "2026-08-22T00:00:00Z"].map(
      (updatedAt): [string, string] => [
        `invalid date ${updatedAt}`,
        JSON.stringify({ ...baseline, updatedAt }),
      ],
    ),
    ["unknown UI key", JSON.stringify({ ...baseline, uiE2e: { ...baseline.uiE2e, extra: 1 } })],
    [
      "unknown compact profile",
      JSON.stringify({
        ...baseline,
        compactGroupSeconds: { ...baseline.compactGroupSeconds, extra: {} },
      }),
    ],
    ["missing profile", JSON.stringify({ ...baseline, compactGroupSeconds: { blacksmith: {} } })],
    ...["ui", "repoE2e", "blacksmith", "github"].flatMap((profile) =>
      [
        null,
        [],
        { "": 1 },
        ...[0, -1, "2", null, 1.2, Number.MAX_SAFE_INTEGER + 1].map((seconds) => ({
          valid: 100,
          invalid: seconds,
        })),
      ].map((seconds): [string, string] => [
        `invalid ${profile} map ${JSON.stringify(seconds)}`,
        JSON.stringify(
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
        ),
      ]),
    ),
    ["non-finite seconds", JSON.stringify(baseline).replace(":100", ":1e999")],
    ...[-1, 5.1, null, "1"].map((overhead): [string, string] => [
      `invalid overhead ${String(overhead)}`,
      JSON.stringify({
        ...baseline,
        uiE2e: { ...baseline.uiE2e, perFileOverheadSeconds: overhead },
      }),
    ]),
    ["non-finite overhead", JSON.stringify(baseline).replace(":0.6", ":1e999")],
  ];

  it.each(invalidTimings)("rejects %s", (_name, contents) => {
    expect(() => ciTestTimingsSchema.parse(JSON.parse(contents))).toThrow(
      "Invalid CI test timings",
    );
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
    ["unreadable", new Error("EACCES")],
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
    },
  );

  it("reads the repo-relative file once and honors the disable switch even after caching", async () => {
    const data = {
      ...baseline,
      compactGroupSeconds: { blacksmith: { group: 110 }, github: { group: 181 } },
      repoE2eFileSeconds: { "test/example.e2e.test.ts": 90 },
    };
    const { loader, read, timingPath } = await readTimings(JSON.stringify(data));
    expect(loader.readUiE2eFileTimings()).toEqual(data.uiE2e);
    expect(loader.readRepoE2eFileTimings()).toEqual(data.repoE2eFileSeconds);
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({ group: 110 });
    expect(loader.readCompactGroupTimings("github")).toEqual({ group: 181 });
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", "0");
    expect(loader.readUiE2eFileTimings()).toEqual({ fileSeconds: {}, perFileOverheadSeconds: 0 });
    expect(loader.readRepoE2eFileTimings()).toEqual({});
    expect(loader.readCompactGroupTimings("blacksmith")).toEqual({});
    expect(loader.readCompactGroupTimings("github")).toEqual({});
    vi.stubEnv("OPENCLAW_CI_TEST_TIMINGS", undefined);
    expect(loader.readCompactGroupTimings("github")).toEqual({ group: 181 });
    expect(
      read.mock.calls.filter(([file]) => file instanceof URL && fileURLToPath(file) === timingPath),
    ).toHaveLength(1);
  });
});
