import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyFailures,
  extractFailingTestFiles,
  finalizeSelection,
  groupCandidates,
} from "../../scripts/ci-codex-test-selection.mts";
import { classifyChangedNodeTestCandidates } from "../../scripts/lib/ci-changed-node-test-plan.mts";
import { summarizeTestSelections } from "../../scripts/lib/ci-codex-test-selection-summary.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const candidates = [
  "src/direct.test.ts",
  "src/related/a.test.ts",
  "src/related/b.test.ts",
  "test/other.test.ts",
];
const prepared = {
  schemaVersion: 1 as const,
  status: "ready",
  base: "base",
  head: "head",
  candidates,
  floor: ["src/direct.test.ts"],
  floorReasons: { "src/direct.test.ts": 2 as const },
  prefixes: ["src/related/"],
  nodeJobs: ["checks-node-changed"],
  preparedAtMs: 0,
};
const proposal = (keep: string[], confidence = "high") =>
  JSON.stringify({
    keep: keep.map((file) => ({ path: file, reason: "May exercise changed behavior" })),
    confidence,
    summary: "Keep related coverage",
  });

describe("shadow Codex test selection", () => {
  it("classifies the complete candidate universe by the first matching floor reason", () => {
    const changed = ["src/local/source.ts", "src/local/changed.test.ts"];
    const files = [
      "src/local/changed.test.ts",
      "src/local/direct.test.ts",
      "src/local/policy.test.ts",
      "test/watched.test.ts",
      "extensions/example/owned.test.ts",
      "extensions/example/imported.test.ts",
    ];
    const evidence = {
      importDepths: new Map(files.map((file, index) => [file, index < 2 ? 1 : 2])),
      nonImportTargets: new Set(["src/local/policy.test.ts", "test/watched.test.ts"]),
      nonImportRows: [],
    };
    const result = classifyChangedNodeTestCandidates(
      changed,
      files,
      evidence,
      new Set(["test/watched.test.ts", "extensions/example/owned.test.ts"]),
    );
    expect(result).toEqual({
      floor: files.slice(0, 5),
      prunable: ["extensions/example/imported.test.ts"],
      floorReasons: {
        "src/local/changed.test.ts": 1,
        "src/local/direct.test.ts": 2,
        "src/local/policy.test.ts": 3,
        "test/watched.test.ts": 4,
        "extensions/example/owned.test.ts": 5,
      },
    });
  });

  it("keeps the floor and expands only offered prefixes or exact candidates", () => {
    const result = finalizeSelection(
      prepared,
      proposal(["src/related/", "made-up.test.ts", "test/", "src/related/../"]),
    );
    expect(result.status).toBe("shadow");
    expect(result.selected).toEqual(candidates.slice(0, 3));
    expect(result.pruned).toEqual(["test/other.test.ts"]);
    expect(result.codex.invalidEntries).toBe(3);
    expect(finalizeSelection(prepared, proposal([])).selected).toEqual(prepared.floor);
    expect(finalizeSelection(prepared, proposal(["test/other.test.ts"])).selected).toEqual([
      "src/direct.test.ts",
      "test/other.test.ts",
    ]);
  });

  it.each([
    ["low-confidence", proposal([], "low"), "success"],
    ["invalid-json", "{bad json", "success"],
    ["invalid-schema", JSON.stringify({ keep: [], confidence: "certain", summary: "" }), "success"],
    [
      "invalid-schema",
      JSON.stringify({ keep: [{ path: "src/related/" }], confidence: "high", summary: "" }),
      "success",
    ],
    [
      "invalid-schema",
      JSON.stringify({ keep: [], confidence: "high", summary: "", selected: [] }),
      "success",
    ],
    ["missing-output", undefined, "success"],
    ["missing-output", "", "success"],
    ["codex-failure", proposal([]), "failure"],
    ["codex-timeout", proposal([]), "timeout"],
  ])("keeps every candidate on %s", (reason, raw, outcome) => {
    const result = finalizeSelection(prepared, raw, outcome, 123);
    expect(result.status).toBe(`fallback:${reason}`);
    expect(result.selected).toEqual(candidates);
    expect(result.pruned).toEqual([]);
    expect(result.codex.durationMs).toBe(123);
  });

  it("preserves eligibility skips and only estimates a fully measured pruned set", () => {
    expect(
      finalizeSelection({ ...prepared, status: "skipped:broad-fallback" }, proposal([])).selected,
    ).toEqual(candidates);
    const fileSeconds = {
      "src/related/a.test.ts": 2,
      "src/related/b.test.ts": 3,
      "test/other.test.ts": 5,
    };
    expect(
      finalizeSelection({ ...prepared, fileSeconds }, proposal([])).estimatedPrunedSeconds,
    ).toBe(10);
    expect(
      finalizeSelection({ ...prepared, fileSeconds: { "test/other.test.ts": 5 } }, proposal([]))
        .estimatedPrunedSeconds,
    ).toBeUndefined();
  });

  it("bounds grouped candidates while preserving every proposed prefix's membership", () => {
    const files = Array.from({ length: 900 }, (_, index) => `src/area-${index}/file.test.ts`);
    const grouped = groupCandidates([...files, "test/small/a.test.ts", "test/small/b.test.ts"]);
    expect(grouped.lines.length).toBeLessThanOrEqual(500);
    expect(grouped.prefixes).toContain("src/");
    expect(grouped.lines).toContain("test/small/a.test.ts");
    const result = finalizeSelection(
      { ...prepared, candidates: files, floor: [], prefixes: grouped.prefixes },
      proposal(["src/"]),
    );
    expect(result.selected).toHaveLength(900);
  });

  it("extracts both reporters' failures and classifies a MISS without crediting unrelated errors", () => {
    const log = [
      "2026-09-26T00:00:00Z FAIL |node| src/direct.test.ts > direct behavior",
      "\u001b[31m FAIL \u001b[0m\u001b[44m tooling \u001b[0m src/related/a.test.ts > related behavior",
      "::error file=/home/runner/work/openclaw/openclaw/src/related/b.test.ts,line=14,title=failed::failure",
      "::error file=test/outside.test.ts,line=1::outside",
      "::error file=src/source.ts,line=1::build error",
      "FAIL src/related/b.test.ts > duplicate reporter output",
    ].join("\n");
    const selection = finalizeSelection(prepared, proposal(["src/related/a.test.ts"]));
    expect(classifyFailures(selection, extractFailingTestFiles(log))).toEqual([
      { path: "src/direct.test.ts", classification: "floor", miss: false },
      { path: "src/related/a.test.ts", classification: "codex-kept", miss: false },
      { path: "src/related/b.test.ts", classification: "codex-pruned", miss: true },
      { path: "test/outside.test.ts", classification: "outside-candidates", miss: false },
    ]);
  });

  it("aggregates statuses, distributions, timing coverage, and per-run misses without double counting reporters", () => {
    const selection = (
      status: string,
      candidateCount: number,
      pruned: number,
      durationMs: number,
      estimate?: number,
    ) => ({
      schemaVersion: 1 as const,
      status,
      counts: { candidates: candidateCount, pruned },
      codex: { durationMs },
      ...(estimate === undefined ? {} : { estimatedPrunedSeconds: estimate }),
    });
    const result = summarizeTestSelections([
      {
        runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
        selection: selection("shadow", 10, 8, 100, 4),
        report: {
          schemaVersion: 1,
          errors: [],
          unknown: [{ job: "cancelled", reason: "cancelled" }],
          failures: [
            { path: "src/floor.test.ts", classification: "floor" },
            { path: "src/kept.test.ts", classification: "codex-kept" },
            { path: "src/missed.test.ts", classification: "codex-pruned" },
            { path: "src/missed.test.ts", classification: "codex-pruned" },
            { path: "src/outside.test.ts", classification: "outside-candidates" },
          ],
        },
      },
      {
        runUrl: "https://github.com/openclaw/openclaw/actions/runs/2",
        selection: selection("ready", 20, 5, 500, 6),
        report: {
          schemaVersion: 1,
          errors: ["log-unavailable"],
          unknown: [{ job: "logs", reason: "log-unavailable" }],
          failures: [{ path: "src/missed.test.ts", classification: "codex-pruned" }],
        },
      },
      { runUrl: "run-3", selection: selection("fallback:low-confidence", 10, 0, 300) },
      { runUrl: "run-4", selection: selection("skipped:no-prunable-candidates", 5, 0, 0) },
      { runUrl: "run-5", selection: selection("skipped:broad-fallback", 0, 0, 0) },
      { runUrl: "run-6" },
    ]);
    expect(result).toEqual({
      runsConsidered: 6,
      runsWithSelection: 5,
      runsWithoutSelection: 1,
      statusCounts: {
        ready: 2,
        "fallback:low-confidence": 1,
        "skipped:no-prunable-candidates": 1,
        "skipped:broad-fallback": 1,
      },
      pruneRatio: { samples: 4, median: 0.125, p90: 0.8 },
      codexDurationMs: { samples: 3, median: 300, p90: 500 },
      estimatedPrunedSeconds: 10,
      runsWithTimingEstimates: 2,
      reports: 2,
      missingReports: 3,
      reportsWithErrors: 1,
      unknownJobs: 2,
      unknownJobsByReason: { cancelled: 1, "log-unavailable": 1 },
      failingFiles: { floor: 1, kept: 1, MISS: 2, outside: 1 },
      misses: [
        {
          runUrl: "https://github.com/openclaw/openclaw/actions/runs/1",
          path: "src/missed.test.ts",
        },
        {
          runUrl: "https://github.com/openclaw/openclaw/actions/runs/2",
          path: "src/missed.test.ts",
        },
      ],
    });
  });

  it("does not invent distribution or timing estimates when no selection is available", () => {
    expect(summarizeTestSelections([{ runUrl: "missing" }])).toMatchObject({
      runsWithSelection: 0,
      runsWithoutSelection: 1,
      statusCounts: {},
      pruneRatio: { samples: 0, median: null, p90: null },
      codexDurationMs: { samples: 0, median: null, p90: null },
      estimatedPrunedSeconds: null,
      runsWithTimingEstimates: 0,
      misses: [],
    });
  });
});

describe("selection prepare command", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.doUnmock("../../scripts/lib/ci-changed-node-test-plan.mts");
    vi.resetModules();
  });

  it.each([
    {
      context: { options: { runnerBackend: "hybrid" } },
      names: ["second", "first"],
      status: "ready",
    },
    {
      context: { options: { runnerBackend: "hybrid" } },
      names: ["first", "missing"],
      status: "fallback:plan-mismatch",
    },
    {
      context: { oversized: true },
      names: ["first", "second"],
      status: "skipped:context-too-large",
    },
  ])("records $status without transporting a matrix", async ({ context, names, status }) => {
    const dir = tempDirs.make("openclaw-selector-prepare-");
    const output = path.join(dir, "github-output");
    vi.stubEnv("OPENCLAW_CI_SELECTION_CONTEXT", JSON.stringify(context));
    vi.stubEnv("OPENCLAW_CI_SELECTION_CHECK_NAMES", JSON.stringify(names));
    vi.stubEnv("OPENCLAW_CI_SELECTION_MATRIX", undefined);
    vi.stubEnv("GITHUB_OUTPUT", output);
    vi.stubEnv("GITHUB_STEP_SUMMARY", undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("node:child_process", async () => ({
      ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
      execFileSync: (_command: string, args: string[]) =>
        args[0] === "rev-parse"
          ? args[2] === "base^{commit}"
            ? "base"
            : "head"
          : args.includes("--name-only")
            ? "src/direct.ts\0"
            : "one changed file",
      spawnSync: () => ({ status: 0, stdout: "small diff" }),
    }));
    vi.doMock("../../scripts/lib/ci-changed-node-test-plan.mts", () => ({
      createChangedNodeTestShards: (
        changedPaths: string[],
        options: { onSelectionEvidence: (evidence: unknown) => void },
      ) => {
        expect(changedPaths).toEqual(["src/direct.ts"]);
        expect(options).toMatchObject({ runnerBackend: "hybrid" });
        options.onSelectionEvidence({
          importDepths: new Map(candidates.map((file) => [file, 2])),
          nonImportTargets: new Set(),
          nonImportRows: [],
        });
        return [
          { checkName: "first", targets: candidates.slice(0, 2) },
          { checkName: "second", targets: candidates.slice(2) },
          { checkName: "dist", targets: ["src/dist.test.ts"], requiresDist: true },
        ];
      },
      createChangedExtensionFallbackShards: () => [],
      classifyChangedNodeTestCandidates,
    }));
    const argv = process.argv;
    try {
      process.argv = [
        process.execPath,
        fileURLToPath(new URL("../../scripts/ci-codex-test-selection.mts", import.meta.url)),
        "prepare",
        "--base",
        "base",
        "--head",
        "head",
        "--output-dir",
        dir,
      ];
      vi.resetModules();
      await import("../../scripts/ci-codex-test-selection.mts");
    } finally {
      process.argv = argv;
    }
    const result = JSON.parse(readFileSync(path.join(dir, "prepared.json"), "utf8"));
    expect(result.status).toBe(status);
    expect(readFileSync(output, "utf8")).toBe(`eligible=${status === "ready"}\n`);
    const oversized = status === "skipped:context-too-large";
    expect(result.candidates).toEqual(oversized ? [] : candidates);
    expect(result.floor).toEqual(oversized ? [] : prepared.floor);
    expect(result.nodeJobs).toEqual(names.toSorted());
    if (status !== "ready") {
      const selection = finalizeSelection(result, proposal([]));
      expect(selection.status).toBe(status);
      expect(selection.selected).toEqual(result.candidates);
      expect(selection.pruned).toEqual([]);
    }
  });
});
