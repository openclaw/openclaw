import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  parseStaticDiagnostics,
  parseStaticFailureReport,
} from "../../scripts/lib/ci-static-check-evidence.mjs";

// Native diagnostic and trailer from scheduled main run 36319748969; setup is omitted.
const realTypeDiagnostic =
  "src/tasks/task-registry-acp-cleanup.sqlite.test.ts(200,38): error TS2345: Argument of type 'ProcessEnv' is not assignable to parameter of type '(sql: string) => void'.\n" +
  "  Type 'Dict<string>' provides no match for the signature '(sql: string): void'.";
const realTypeSignature = {
  kind: "tsgo",
  file: "src/tasks/task-registry-acp-cleanup.sqlite.test.ts",
  test:
    "(200,38) TS2345: Argument of type 'ProcessEnv' is not assignable to parameter of type '(sql: string) => void'.\n" +
    "  Type 'Dict<string>' provides no match for the signature '(sql: string): void'.",
};

const lintDiagnostic = {
  filename: "extensions/workboard/browser/lib/workboard/card-alerts.ts",
  message: "'unused' is imported but never used.",
  severity: "error",
  code: "eslint(no-unused-vars)",
  help: "Consider removing this import.",
  labels: [{ span: { line: 1, column: 10 } }],
};
const lintSignature = {
  kind: "oxlint",
  file: lintDiagnostic.filename,
  test: "(1,10) error eslint(no-unused-vars): 'unused' is imported but never used.\n  Consider removing this import.",
};

function stepLog(output: string, exitCode = 2) {
  return [
    "##[group]Run node scripts/run-tsgo-core-test-shards.mjs",
    "##[endgroup]",
    output,
    `##[error]Process completed with exit code ${exitCode}.`,
    "Post job cleanup.",
  ]
    .join("\n")
    .split("\n")
    .map((line) => `2026-09-27T12:41:53.7715041Z ${line}`)
    .join("\n");
}

function fixtureRow(rows: { phase: string; data: Record<string, unknown> }[], index: number) {
  const row = rows[index];
  assert.ok(row, `Missing static evidence fixture row ${index}`);
  return row;
}

function completeStaticLog(
  kind: "tsgo" | "oxlint" = "tsgo",
  change: (rows: { phase: string; data: Record<string, unknown> }[]) => void = () => {},
) {
  const rows = [
    {
      phase: "leaf",
      data: {
        version: 1,
        id: "batch:0",
        config: "test/tsconfig/tsconfig.core.test.state-logging.json",
        exitCode: kind === "tsgo" ? 2 : 1,
        stdout:
          kind === "tsgo" ? realTypeDiagnostic : JSON.stringify({ diagnostics: [lintDiagnostic] }),
        stderr: "",
      },
    },
    {
      phase: "leaf",
      data: {
        version: 1,
        id: "batch:1",
        config: "test/tsconfig/tsconfig.core.test.agents-tools.json",
        exitCode: 0,
        stdout: kind === "tsgo" ? "" : JSON.stringify({ diagnostics: [] }),
        stderr: "",
      },
    },
    {
      phase: "completion",
      data: { version: 1, id: "batch", planned: 2, completed: 2, leaves: ["batch:0", "batch:1"] },
    },
    { phase: "step", data: { version: 1, groups: 1 } },
  ];
  change(rows);
  return stepLog(
    rows
      .map(({ phase, data }) => `[ci-static:${kind}:${phase}] ${JSON.stringify(data)}`)
      .join("\n"),
    kind === "tsgo" ? 2 : 1,
  );
}

describe("static CI diagnostic evidence", () => {
  it.each([
    [
      "multiline error",
      `${realTypeDiagnostic}\n[tsgo:state-logging] failed (exit 2) in 47.4s\n[tsgo:agents-tools] passed in 52.4s\n[tsgo:core:test] FAILED (exit 2)`,
      [realTypeSignature],
    ],
    [
      "distinct errors in one file",
      "src/owner.ts(20,7): error TS2367: Types have no overlap.\nsrc/owner.ts(30,9): error TS2554: Expected 3 arguments, but got 2.",
      [
        { kind: "tsgo", file: "src/owner.ts", test: "(20,7) TS2367: Types have no overlap." },
        {
          kind: "tsgo",
          file: "src/owner.ts",
          test: "(30,9) TS2554: Expected 3 arguments, but got 2.",
        },
      ],
    ],
  ])(
    "reads legacy %s for recovery but refuses incomplete gate evidence",
    (_name, output, expected) => {
      expect(parseStaticFailureReport(stepLog(output), "tsgo")).toEqual(expected);
      expect(parseStaticFailureReport(stepLog(output), "tsgo", true)).toEqual([]);
    },
  );

  it.each([
    ["global diagnostic", "error TS5058: The specified path does not exist.", 2],
    ["outside repository", "/tmp/fixture.ts(1,1): error TS2345: Invalid value.", 2],
    ["non-runtime source", "scripts/tool.mts(1,1): error TS2345: Invalid value.", 2],
    ["traversal", "src/../scripts/tool.ts(1,1): error TS2345: Invalid value.", 2],
    ["non-source extension", "src/file.json(1,1): error TS2345: Invalid value.", 2],
    ["wrong exit", "", 1],
  ] as const)("rejects %s beside a recognized compiler diagnostic", (_name, extra, code) => {
    expect(
      parseStaticFailureReport(stepLog(`${realTypeDiagnostic}\n${extra}`, code), "tsgo"),
    ).toEqual([]);
  });

  it("matches the canonical oxlint owner rendering only when all report counts agree", () => {
    // Synthetic diagnostics in run-oxlint.mts's canonical flat report format.
    const output =
      "extensions/workboard/browser/lib/workboard/card-alerts.ts:1:10: error: 'unused' is imported but never used. (eslint(no-unused-vars))\n" +
      "  Consider removing this import.\nFound 0 warnings and 1 error.\n" +
      "extensions/codex/src/app-server/native-subagent-inventory.retirement.test.ts:20:3: error: Promises must be awaited. (typescript(no-floating-promises))\n" +
      "Found 0 warnings and 1 error.";
    expect(parseStaticFailureReport(stepLog(output, 1), "oxlint")).toEqual([
      {
        kind: "oxlint",
        file: "extensions/workboard/browser/lib/workboard/card-alerts.ts",
        test: "(1,10) error eslint(no-unused-vars): 'unused' is imported but never used.\n  Consider removing this import.",
      },
      {
        kind: "oxlint",
        file: "extensions/codex/src/app-server/native-subagent-inventory.retirement.test.ts",
        test: "(20,3) error typescript(no-floating-promises): Promises must be awaited.",
      },
    ]);
    expect(parseStaticFailureReport(stepLog(output, 1), "oxlint", true)).toEqual([]);
    for (const invalid of [
      output.replace("Found 0 warnings and 1 error.", "Found 0 warnings and 2 errors."),
      output.replace(/Found 0 warnings and 1 error\.$/u, ""),
      `${output}\nError: native lint worker terminated`,
    ]) {
      expect(parseStaticFailureReport(stepLog(invalid, 1), "oxlint")).toEqual([]);
    }
  });

  it.each(["tsgo", "oxlint"] as const)(
    "accepts %s diagnostics only after the entire graph joins",
    (kind) => {
      const output = kind === "tsgo" ? realTypeDiagnostic : "";
      const log = completeStaticLog(kind).replace("##[endgroup]", `##[endgroup]\n${output}`);
      const expected = [kind === "tsgo" ? realTypeSignature : lintSignature];
      expect(parseStaticFailureReport(log, kind, true)).toEqual(expected);
      expect(parseStaticFailureReport(log, kind)).toEqual(expected);
    },
  );

  it("normalizes native lint JSON to the same signatures as its flat rendering", () => {
    const warning = { ...lintDiagnostic, severity: "warning", code: "eslint(max-lines)" };
    const report = {
      diagnostics: [lintDiagnostic, warning],
      number_of_errors: 1,
      number_of_warnings: 1,
    };
    expect(parseStaticDiagnostics(JSON.stringify(report), "oxlint")).toEqual([lintSignature]);
    expect(
      parseStaticDiagnostics(
        "ui/src/page.ts:1:0: warning: Too many lines. (eslint(max-lines))\n  Split this file.\nFound 1 warning and 0 errors.",
        "oxlint",
      ),
    ).toEqual([]);
    expect(parseStaticDiagnostics(JSON.stringify({ diagnostics: [warning] }), "oxlint")).toEqual(
      [],
    );
    for (const invalid of [
      { ...report, number_of_errors: 2 },
      { ...report, number_of_warnings: 0 },
      { diagnostics: [{ ...lintDiagnostic, filename: "/tmp/unowned.ts" }] },
      { diagnostics: [{ ...lintDiagnostic, labels: [] }] },
      { diagnostics: [{ ...lintDiagnostic, severity: "panic" }] },
    ]) {
      expect(parseStaticDiagnostics(JSON.stringify(invalid), "oxlint")).toBeNull();
    }
  });

  it.each(["tsgo", "oxlint"] as const)(
    "rejects unaccounted %s step output and malformed historical main evidence",
    (kind) => {
      const log = completeStaticLog(kind);
      for (const invalid of [
        log.replace("##[endgroup]", "##[endgroup]\nError: setup worker crashed"),
        log.replace(
          "##[endgroup]",
          "##[endgroup]\n[tsgo:state-logging] failed (exit 2) in 47.4s; worker killed",
        ),
        log.replace(`[ci-static:${kind}:step]`, `[ci-static:${kind}:unknown]`),
        log.replace('"completed":2', '"completed":1'),
        log.replace('"groups":1', '"groups":2'),
      ]) {
        expect(parseStaticFailureReport(invalid, kind)).toEqual([]);
        expect(parseStaticFailureReport(invalid, kind, true)).toEqual([]);
      }
    },
  );

  it.each([
    ["missing leaf", (rows) => rows.splice(1, 1)],
    ["duplicate leaf", (rows) => rows.splice(1, 0, fixtureRow(rows, 0))],
    ["duplicate step", (rows) => rows.push(fixtureRow(rows, 3))],
    ["duplicate group", (rows) => rows.splice(3, 0, fixtureRow(rows, 2))],
    ["missing step", (rows) => rows.pop()],
    [
      "orphan leaf",
      (rows) => {
        fixtureRow(rows, 2).data.leaves = ["batch:0"];
        fixtureRow(rows, 2).data.planned = 1;
        fixtureRow(rows, 2).data.completed = 1;
      },
    ],
    ["unfinished graph", (rows) => (fixtureRow(rows, 2).data.completed = 1)],
    ["missing group", (rows) => (fixtureRow(rows, 3).data.groups = 2)],
    [
      "duplicate graph coverage",
      (rows) => (fixtureRow(rows, 2).data.leaves = ["batch:0", "batch:0"]),
    ],
    ["non-diagnostic failure", (rows) => (fixtureRow(rows, 1).data.exitCode = 137)],
    ["signaled compiler", (rows) => (fixtureRow(rows, 0).data.signal = "SIGTERM")],
    ["skipped compiler", (rows) => (fixtureRow(rows, 1).data.skipped = true)],
    ["compiler stderr", (rows) => (fixtureRow(rows, 0).data.stderr = "panic: worker stopped")],
    [
      "unparsed compiler output",
      (rows) => (fixtureRow(rows, 0).data.stdout = `${realTypeDiagnostic}\nworker crashed`),
    ],
    ["false successful compiler", (rows) => (fixtureRow(rows, 1).data.stdout = realTypeDiagnostic)],
    ["failure without diagnostics", (rows) => (fixtureRow(rows, 0).data.stdout = "")],
    ["step before completion", (rows) => rows.unshift(...rows.splice(-1))],
  ] satisfies [string, (rows: { phase: string; data: Record<string, unknown> }[]) => void][])(
    "keeps %s blocking despite another matching diagnostic",
    (_name, change) => {
      expect(parseStaticFailureReport(completeStaticLog("tsgo", change), "tsgo", true)).toEqual([]);
    },
  );
});
