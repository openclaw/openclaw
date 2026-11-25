import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { beforeAll, expect, it } from "vitest";
import noForcedProcessExit from "../../scripts/lib/no-forced-process-exit.mjs";
import { ADMISSION_FILES } from "../../scripts/lib/no-operator-permission-read.mjs";
import noRecursiveReaddir from "../../scripts/lib/no-recursive-readdir.mjs";
import {
  CAPABILITY_PROVENANCE_FILES,
  OWNER_PRODUCER_FILES,
  TURN_FLAG_FILES,
} from "../../scripts/lib/no-turn-authority-derivation.mjs";

const FIXTURES = "test/fixtures/oxlint-boundary-guards";
const forcedExit = "no-forced-process-exit";
const cases = [
  [
    forcedExit,
    "forced-process-exit-violation.ts",
    25,
    [2, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 23, 24, 24, 25, 26, 27, 28, 30, 32],
  ],
  [forcedExit, "forced-process-exit-violation.cjs", 6, [3, 4, 5, 6, 7, 9]],
  [forcedExit, "forced-process-exit-violation.mjs", 2, [2, 4]],
  [forcedExit, "forced-process-escaped.ts", 5, [2, 4, 5, 6, 8]],
  [forcedExit, "forced-process-uppercase.ts", 1, [1]],
  [forcedExit, "../forced-process-exit.test-support.cjs", 0],
  ["no-register-http-handler-call", "register-http-handler-violation.ts", 3],
  ["no-raw-window-open-call", "raw-window-open-violation.ts", 5],
  ["no-raw-window-open-call", "boundary-calls.tsx", 2, [3, 4]],
  ["no-register-http-handler-call", "boundary-calls.tsx", 1, [5]],
  ["no-raw-window-open-call", "boundary-calls.test-harness.tsx", 0],
  ["no-register-http-handler-call", "boundary-calls.test-harness.tsx", 0],
  ["no-widen-then-assert", "widen-then-assert-violation.test.ts", 3, [3, 7, 13]],
  ["no-operator-permission-read", "operator-permission-recheck-violation.ts", 4, [1, 4, 6, 8]],
  // Planted divergence: a resumed turn reads its start kind; owner status comes from
  // destructuring defaults (source and aliased destination), from scopes, from defaults to
  // owner and from function values. Pass-throughs (lines 9-10) and narrowing forms (lines
  // 23-30) are not reported.
  [
    "no-turn-authority-derivation",
    "turn-authority-derivation-violation.ts",
    9,
    [11, 12, 13, 13, 18, 32, 33, 36, 41],
  ],
  ["no-chained-type-assertions", "chained-type-assertions-violation.ts", 3],
] satisfies [string, string, number, number[]?][];

// Shrink only. When a file leaves a list, lower its ceiling in the same change; never raise one.
const allowlists = [
  ["no-operator-permission-read", "", ADMISSION_FILES, 59],
  ["no-turn-authority-derivation", "Turn-kind flag:", TURN_FLAG_FILES, 19],
  ["no-turn-authority-derivation", "Owner status:", OWNER_PRODUCER_FILES, 28],
  ["no-turn-authority-derivation", "Capability module:", CAPABILITY_PROVENANCE_FILES, 3],
] as const;

it.each(allowlists)(
  "keeps the %s %s allowlist at or below its ceiling",
  (_rule, _kind, files, ceiling) => {
    expect(files.size).toBeLessThanOrEqual(ceiling);
  },
);

it("drops every allowlist entry that no longer trips its check", () => {
  const config = join(mkdtempSync(join(tmpdir(), "turn-authority-allowlists-")), "oxlint.json");
  writeFileSync(
    config,
    JSON.stringify({
      plugins: [],
      jsPlugins: [resolve("scripts/oxlint-boundary-guards.mjs")],
      categories: { correctness: "off" },
      rules: Object.fromEntries(
        allowlists.map(([rule]) => [
          `openclaw-boundaries/${rule}`,
          ["error", { ignoreAllowlists: true }],
        ]),
      ),
    }),
  );
  const files = [...new Set(allowlists.flatMap((allowlist) => [...allowlist[2]]))];
  const run = spawnSync(
    process.execPath,
    [
      "scripts/run-oxlint.mjs",
      "--openclaw-focused-config",
      "--config",
      config,
      "--format",
      "json",
      ...files,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  expect(run.error).toBeUndefined();
  const found = (JSON.parse(run.stdout) as { diagnostics: typeof diagnostics }).diagnostics;
  const stale = allowlists.flatMap(([rule, kind, list]) =>
    [...list]
      .filter(
        (file) =>
          !found.some(
            (diagnostic) =>
              diagnostic.filename.replaceAll("\\", "/") === file &&
              diagnostic.code === `openclaw-boundaries(${rule})` &&
              diagnostic.message.startsWith(kind),
          ),
      )
      .map((file) => `${rule} ${kind} ${file}`),
  );
  expect(stale, "Remove these entries and lower the ceiling").toEqual([]);
});

const recursiveKinds = {
  unsafe: expect.stringMatching(/^Recursive readdir /),
  unverifiable: expect.stringMatching(/^Cannot verify nonrecursive readdir /),
};
const recursiveCases = [
  [
    "recursive-readdir-violation.ts",
    {
      unsafe: [3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 19, 21, 23, 25],
      unverifiable: [27],
    },
  ],
  [
    "recursive-readdir-mutation.ts",
    { unsafe: [], unverifiable: [4, 7, 10, 14, 17, 20, 36, 38, 41, 48, 53, 59, 64, 69, 74] },
  ],
  ["recursive-readdir-builtins.ts", { unsafe: [4, 6, 7, 10, 12, 22], unverifiable: [] }],
  ["recursive-readdir-import-equals.ts", { unsafe: [3, 4], unverifiable: [] }],
] satisfies [string, Record<keyof typeof recursiveKinds, number[]>][];

it.each([
  ["src/runtime.ts", true],
  ["extensions/example/src/harness-runtime.ts", true],
  ["openclaw.mjs", true],
  ["scripts/openclaw-immutable-launcher.mjs", true],
  ["scripts/build.mts", false],
  ["extensions/example/scripts/build.mjs", false],
  ["src/child.test-support.cjs", false],
  ["extensions/example/dist/worker.js", false],
])("reports forced termination in %s: %s", (file, expected) => {
  let reported = false;
  const listeners = noForcedProcessExit.create({
    cwd: process.cwd(),
    physicalFilename: `${process.cwd()}/${file}`,
    sourceCode: { text: "process.exit(1);", scopeManager: { scopes: [] } },
    report() {
      reported = true;
    },
  });
  // Scope admission is separate from the real AST/binding checks below.
  listeners.MemberExpression?.({
    type: "MemberExpression",
    computed: false,
    object: { type: "Identifier", name: "process", start: 0 },
    property: { type: "Identifier", name: "exit" },
  });
  expect(reported).toBe(expected);
});

it("does not analyze scopes for unrelated destructuring", () => {
  let scopeReads = 0;
  const listeners = noForcedProcessExit.create({
    cwd: process.cwd(),
    physicalFilename: `${process.cwd()}/src/runtime.ts`,
    sourceCode: {
      text: 'const { pid } = process; process.on("exit", cleanup);',
      scopeManager: {
        get scopes() {
          scopeReads += 1;
          return [];
        },
      },
    },
    report() {
      throw new Error("Unrelated destructuring must not be reported");
    },
  });
  expect(typeof listeners.VariableDeclarator).toBe("function");
  listeners.VariableDeclarator?.({
    init: { type: "Identifier", name: "process", start: 16 },
    id: {
      type: "ObjectPattern",
      properties: [{ type: "Property", key: { type: "Identifier", name: "pid" }, computed: false }],
    },
  });
  expect(scopeReads).toBe(0);
});

let diagnostics: Array<{
  filename: string;
  code: string;
  severity: string;
  message: string;
  labels: Array<{ span: { line: number } }>;
}>;

beforeAll(() => {
  const violation = spawnSync(
    process.execPath,
    [
      "scripts/run-oxlint.mjs",
      "--openclaw-focused-config",
      "--config",
      "config/oxlint/boundary-guards.json",
      "--format",
      "json",
      ...new Set(
        [...cases.map(([, file]) => file), ...recursiveCases.map(([file]) => file)].map((file) =>
          posix.join(FIXTURES, file),
        ),
      ),
    ],
    { encoding: "utf8" },
  );
  expect(violation.error).toBeUndefined();
  expect(violation.status, violation.stderr).toBe(1);
  const report = JSON.parse(violation.stdout) as {
    diagnostics: typeof diagnostics;
  };
  diagnostics = report.diagnostics;
});

it.each(cases)(
  "reports expected violations for %s in %s",
  (rule, file, violations, lines?: number[]) => {
    // A fixture can trigger sibling rules; match both its file and its owning rule.
    const matching = diagnostics.filter(
      (diagnostic) =>
        diagnostic.filename.replaceAll("\\", "/") === posix.join(FIXTURES, file) &&
        diagnostic.code === `openclaw-boundaries(${rule})`,
    );
    expect(matching.map((diagnostic) => diagnostic.severity)).toEqual(
      Array(violations).fill("error"),
    );
    if (lines) {
      expect(
        matching
          .map((diagnostic) => diagnostic.labels[0]?.span.line)
          .toSorted((a, b) => (a ?? 0) - (b ?? 0)),
      ).toEqual(lines);
    }
  },
);

it.each(recursiveCases)(
  "reports recursive readdir diagnostic kinds by line in %s",
  (file, kinds) => {
    const actual = diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.filename.replaceAll("\\", "/") === posix.join(FIXTURES, file) &&
          diagnostic.code === "openclaw-boundaries(no-recursive-readdir)",
      )
      .map((diagnostic) => ({
        line: diagnostic.labels[0]?.span.line,
        message: diagnostic.message,
        severity: diagnostic.severity,
      }))
      .toSorted((a, b) => (a.line ?? 0) - (b.line ?? 0));
    const expected = (Object.keys(recursiveKinds) as Array<keyof typeof recursiveKinds>)
      .flatMap((kind) =>
        kinds[kind].map((line) => ({ line, message: recursiveKinds[kind], severity: "error" })),
      )
      .toSorted((a, b) => a.line - b.line);
    expect(actual).toEqual(expected);
  },
);

it("does no scope or listener work when the source cannot mention readdir", () => {
  expect(
    noRecursiveReaddir.create({
      sourceCode: {
        text: "export const answer = 42;",
        get scopeManager() {
          throw new Error("unnecessary scope materialization");
        },
      },
    }),
  ).toEqual({});
});
