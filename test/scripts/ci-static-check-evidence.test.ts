import { expect, it } from "vitest";
import {
  parseStaticDiagnostics,
  parseStaticFailureReport,
} from "../../scripts/lib/ci-static-check-evidence.mjs";

const typeFile = "src/owner.ts";
const typeMessage = "Invalid argument.\n  Expected a callback.";
const realTypeDiagnostic = `${typeFile}(2,3): error TS2345: ${typeMessage}`;
const signature = (kind: string, file: string, test: string) => ({ kind, file, test });
const realTypeSignature = signature("tsgo", typeFile, `(2,3) TS2345: ${typeMessage}`);

const lint = {
  filename: "extensions/example/card.ts",
  message: "Unused import.",
  severity: "error",
  code: "eslint(no-unused-vars)",
  help: "Remove it.",
  labels: [{ span: { line: 1, column: 10 } }],
};
const lintSignature = signature(
  "oxlint",
  lint.filename,
  "(1,10) error eslint(no-unused-vars): Unused import.\n  Remove it.",
);

function stepLog(output: string, exitCode = 2) {
  return `##[group]Run node scripts/run-tsgo-core-test-shards.mjs
##[endgroup]
${output}
##[error]Process completed with exit code ${exitCode}.
Post job cleanup.`.replace(/^/gmu, "2026-09-27T12:41:53.7715041Z ");
}

type EvidenceRow = { phase: string; data: Record<string, unknown> };
type Kind = "tsgo" | "oxlint";
type Change = (rows: EvidenceRow[]) => void;
const changeRow = (index: number, patch: Record<string, unknown>) => (rows: EvidenceRow[]) => {
  Object.assign(rows[index]!.data, patch);
};
type Signature = { kind: string; file: string; test: string };
function expectReport(log: string, kind: Kind, expected: Signature[], complete = expected) {
  expect(parseStaticFailureReport(log, kind)).toEqual(expected);
  expect(parseStaticFailureReport(log, kind, true)).toEqual(complete);
}

function completeStaticLog(kind: Kind = "tsgo", change: Change = () => {}) {
  const frame = (phase: string, data: Record<string, unknown>) => ({
    phase,
    data: { version: 1, ...data },
  });
  const leaf = (index: number, exitCode: number, stdout: string) =>
    frame("leaf", {
      id: `batch:${index}`,
      config: `test/tsconfig/core.${index}.json`,
      exitCode,
      stdout,
      stderr: "",
    });
  const rows = [
    leaf(
      0,
      kind === "tsgo" ? 2 : 1,
      kind === "tsgo" ? realTypeDiagnostic : JSON.stringify({ diagnostics: [lint] }),
    ),
    leaf(1, 0, kind === "tsgo" ? "" : JSON.stringify({ diagnostics: [] })),
    frame("completion", { id: "batch", planned: 2, completed: 2, leaves: ["batch:0", "batch:1"] }),
    frame("step", { groups: 1 }),
  ];
  change(rows);
  return stepLog(
    rows
      .map(({ phase, data }) => `[ci-static:${kind}:${phase}] ${JSON.stringify(data)}`)
      .join("\n"),
    kind === "tsgo" ? 2 : 1,
  );
}

it("legacy diagnostics permit recovery, not gate exemption", () => {
  const second = "src/owner.ts(3,4): error TS2554: Expected 3 arguments.";
  const telemetry =
    "[tsgo:core] failed (exit 2) in 47.4s\n[tsgo:core] passed in 52.4s\n[tsgo:core] FAILED (exit 2)";
  expectReport(
    stepLog(`${realTypeDiagnostic}\n${second}\n${telemetry}`),
    "tsgo",
    [realTypeSignature, signature("tsgo", typeFile, "(3,4) TS2554: Expected 3 arguments.")],
    [],
  );
});

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

it("accepts canonical oxlint output only with matching report counts", () => {
  const output =
    "extensions/example/card.ts:1:10: error: Unused import. (eslint(no-unused-vars))\n" +
    "  Remove it.\nFound 0 warnings and 1 error.\n" +
    "test/worker.ts:20:3: error: Await. (typescript(await))\n" +
    "Found 0 warnings and 1 error.";
  const worker = signature("oxlint", "test/worker.ts", "(20,3) error typescript(await): Await.");
  expectReport(stepLog(output, 1), "oxlint", [lintSignature, worker], []);
  for (const invalid of [
    output.replace("Found 0 warnings and 1 error.", "Found 0 warnings and 2 errors."),
    output.replace(/Found 0 warnings and 1 error\.$/u, ""),
    `${output}\nError: native lint worker terminated`,
  ]) {
    expect(parseStaticFailureReport(stepLog(invalid, 1), "oxlint")).toEqual([]);
  }
});

it.each(["tsgo", "oxlint"] as const)("accepts %s after the graph joins", (kind) => {
  const output = kind === "tsgo" ? realTypeDiagnostic : "";
  const log = completeStaticLog(kind).replace("##[endgroup]", `##[endgroup]\n${output}`);
  expectReport(log, kind, [kind === "tsgo" ? realTypeSignature : lintSignature]);
});

it("normalizes native lint JSON to the same signatures as its flat rendering", () => {
  const warning = { ...lint, severity: "warning", code: "eslint(max-lines)" };
  const report = { diagnostics: [lint, warning], number_of_errors: 1, number_of_warnings: 1 };
  expect(parseStaticDiagnostics(JSON.stringify(report), "oxlint")).toEqual([lintSignature]);
  const warningText =
    "ui/page.ts:1:0: warning: Too many lines. (eslint(max-lines))\n  Split this file.\nFound 1 warning and 0 errors.";
  for (const output of [warningText, JSON.stringify({ diagnostics: [warning] })]) {
    expect(parseStaticDiagnostics(output, "oxlint")).toEqual([]);
  }
  for (const invalid of [
    { ...report, number_of_errors: 2 },
    { ...report, number_of_warnings: 0 },
    { diagnostics: [{ ...lint, filename: "/tmp/unowned.ts" }] },
    { diagnostics: [{ ...lint, labels: [] }] },
    { diagnostics: [{ ...lint, severity: "panic" }] },
  ]) {
    expect(parseStaticDiagnostics(JSON.stringify(invalid), "oxlint")).toBeNull();
  }
});

it.each(["tsgo", "oxlint"] as const)("rejects unaccounted %s step output", (kind) => {
  const log = completeStaticLog(kind);
  for (const invalid of [
    log.replace("##[endgroup]", "##[endgroup]\nError: setup worker crashed"),
    log.replace(`[ci-static:${kind}:step]`, `[ci-static:${kind}:unknown]`),
  ]) {
    expectReport(invalid, kind, []);
  }
});

it.each([
  ["missing leaf", (rows) => rows.splice(1, 1)],
  ["duplicate leaf", (rows) => rows.splice(1, 0, rows[0]!)],
  ["duplicate step", (rows) => rows.push(rows[3]!)],
  ["missing step", (rows) => rows.pop()],
  ["orphan leaf", changeRow(2, { leaves: ["batch:0"], planned: 1, completed: 1 })],
  ["unfinished graph", changeRow(2, { completed: 1 })],
  ["missing group", changeRow(3, { groups: 2 })],
  ["duplicate graph coverage", changeRow(2, { leaves: ["batch:0", "batch:0"] })],
  ["non-diagnostic failure", changeRow(1, { exitCode: 137 })],
  ["signaled compiler", changeRow(0, { signal: "SIGTERM" })],
  ["compiler stderr", changeRow(0, { stderr: "panic: worker stopped" })],
  ["unparsed compiler output", changeRow(0, { stdout: `${realTypeDiagnostic}\nworker crashed` })],
  ["false successful compiler", changeRow(1, { stdout: realTypeDiagnostic })],
  ["failure without diagnostics", changeRow(0, { stdout: "" })],
  ["step before completion", (rows) => rows.unshift(...rows.splice(-1))],
] satisfies [string, Change][])("blocks %s despite another diagnostic", (_name, change) => {
  expect(parseStaticFailureReport(completeStaticLog("tsgo", change), "tsgo", true)).toEqual([]);
});
