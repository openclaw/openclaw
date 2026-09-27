import { describe, expect, it } from "vitest";
import {
  classifyFailures,
  extractFailingTestFiles,
  finalizeSelection,
  groupCandidates,
} from "../../scripts/ci-codex-test-selection.mts";
import { classifyChangedNodeTestCandidates } from "../../scripts/lib/ci-changed-node-test-plan.mts";

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
    keep: keep.map((path) => ({ path, reason: "May exercise changed behavior" })),
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
});
