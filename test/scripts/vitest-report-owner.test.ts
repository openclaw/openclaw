import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, it, vi, type TestContext } from "vitest";
import { parseCLI, type CliOptions, type JsonTestResults } from "vitest/node";
import { parseVitestExecutionArgs } from "../../scripts/lib/vitest-cli.mts";
import type { VitestReportCapture } from "../../scripts/lib/vitest-report-capture.mts";
import { canParallelizeVitestOutput } from "../../scripts/lib/vitest-report-owner.mts";
import { isPidDefinitelyDead } from "../../src/shared/pid-alive.ts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { createVitestReportFixture, reportChunkTestFiles } from "./vitest-report-fixture.js";

const text = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
const json = (...parts: string[]) => JSON.parse(text(...parts));
const jsonLines = (...parts: string[]) =>
  text(...parts)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
type ReportResult = Awaited<ReturnType<ReturnType<typeof createVitestReportFixture>>>;
type ReportPart = { json: string; blob: string; outcome: { code: number } };
type ReportEntry = { attempts: ReportPart[] };
const indexOf = (result: ReportResult) => json(result.reportSet!, "index.json");
const aggregateOf = (result: ReportResult): VitestReportCapture =>
  json(result.reportSet!, "aggregate.json.capture.json");
const captureOf = (part: { json: string }): VitestReportCapture =>
  json(`${part.json}.capture.json`);
const lastPart = (entry: ReportEntry) => entry.attempts.at(-1)!;
const project = (
  root: string,
  name: string,
  config: string,
  pool: "threads" | "forks",
  namePrefix = "",
) => ({ name, namePrefix, root, config: path.join(root, "test/vitest", config), pool });
const lines = (...parts: string[]) =>
  text(...parts)
    .trimEnd()
    .split("\n")
    .toSorted();
const serialized = (values: unknown[]) => values.map((value) => JSON.stringify(value)).toSorted();
const compareCases = (left: string[], right: string[]) => {
  const a = left.join(","),
    b = right.join(",");
  return a < b ? -1 : a > b ? 1 : 0;
};
const inventory = (report: {
  testResults: { assertionResults: { fullName: string; status: string }[] }[];
}) =>
  report.testResults
    .flatMap((file) => file.assertionResults.map((test) => [test.fullName.trim(), test.status]))
    .toSorted(compareCases);
const expected: [string, string][] = [
  ["alpha/one", "passed"],
  ["alpha/two", "passed"],
  ["beta/one", "passed"],
  ["beta/skip", "skipped"],
  ["beta/todo", "todo"],
];
const failedCases = (failedName: string | undefined, cases = expected): [string, string][] =>
  cases.map(([name, status]) => [name, name === failedName ? "failed" : status]);
function expectPublished(
  expect: TestContext["expect"],
  result: ReportResult,
  cases = expected,
  code = 0,
) {
  expect(result.code, result.stderr).toBe(code);
  expect(inventory(json(result.output))).toEqual(cases);
  const index = indexOf(result);
  expect(index.complete).toBe(true);
  return index;
}

it.for([
  [[], false, false],
  [["--reporter=dot"], false, false],
  [["--coverage.enabled=false"], false, false],
  [["--reporter=dot", "--coverage.enabled=false"], false, true],
  [["--reporter=verbose", "--coverage=false"], false, true],
  [["--reporter=json", "--coverage.enabled=false"], false, false],
  [["--reporter=github-actions", "--coverage.enabled=false"], false, false],
  [["--reporter=json", "--reporter=verbose", "--coverage"], true, true],
  [["--reporter=json", "--reporter=github-actions"], true, false],
  [{ reporter: "dot", coverage: { enabled: false } }, false, true],
  [{ reporters: "verbose", coverage: { enabled: false } }, false, true],
  [{ reporter: ["dot", "verbose"], coverage: { enabled: false } }, false, true],
  [{ reporter: "github-actions" }, true, false],
  [{ reporters: "./custom-reporter.mjs" }, true, false],
  [{ reporters: [["json", { outputFile: "shared.json" }]] }, true, false],
] satisfies [string[] | CliOptions, boolean, boolean][])(
  "requires explicit native output ownership: %j owner=%s",
  ([input, owner, admitted], { expect }) => {
    const options = Array.isArray(input) ? parseCLI(["vitest", "run", ...input]).options : input;
    expect(canParallelizeVitestOutput(options, owner)).toBe(admitted);
  },
);

describe.skipIf(process.platform === "win32")("native multi-invocation report ownership", () => {
  const cacheLifetime = createFixtureLifetime();
  let compileCache: string;
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
    compileCache = cacheLifetime.createTempDir("oc-report-compile-");
    vi.setConfig({ maxConcurrency: 2 });
    return () => vi.resetConfig();
  });
  afterAll(async () => {
    try {
      await cacheLifetime.cleanup();
    } finally {
      await receipts.close();
    }
  });
  type ReportRunner = ReturnType<typeof createVitestReportFixture>;
  const reportTest = it.extend<{ reports: { root: string; run: ReportRunner } }>({
    reports: async ({ onTestFinished, signal }, use) => {
      const lifetime = createFixtureLifetime();
      onTestFinished(() => lifetime.cleanup());
      const root = lifetime.createTempDir("oc-report-");
      const invoke = createVitestReportFixture(root, { receipts, signal }, undefined, compileCache);
      await use({
        root,
        run: (...args) => {
          const completion = lifetime.run(() => invoke(...args));
          void cacheLifetime.track(completion.then(() => undefined));
          return completion;
        },
      });
    },
  }).concurrent;

  reportTest.for([
    ["serial", "projects", false, "SIGABRT", 134],
    ["parallel", "projects", false, "SIGABRT", 134],
    ["serial", undefined, false, "SIGABRT", 134],
    ["parallel", undefined, false, "SIGABRT", 134],
    ["serial", "projects", true, "SIGABRT", 134],
    ["parallel", "projects", true, "SIGABRT", 134],
    ["parallel", "projects", true, "SIGKILL", 137],
  ] as const)(
    "preserves shard crashes: %s entry=%s report=%s signal=%s",
    { timeout: 60000 },
    async ([mode, entry, report, crashSignal, exitCode], { expect, reports }) => {
      const result = await reports.run(mode, { entry, report, crashSignal });
      expect(result.code !== 0 || result.signal !== null, result.stderr).toBe(true);
      expect(result.signal === crashSignal || result.code === exitCode, result.stderr).toBe(true);
      expect(result.stderr).not.toMatch(/\[test\] passed /u);
      expect(result.stderr.match(/^\[.*\] FAILED \(exit \d+\)$/gmu)).toEqual([
        `[test] FAILED (exit ${exitCode})`,
      ]);
      expect(result.stderr.trimEnd().split("\n").at(-1)).toBe(`[test] FAILED (exit ${exitCode})`);
      if (report) {
        const index = indexOf(result);
        expect(index.complete).toBe(false);
        expect(index.entries[0].attempts[0].outcome).toMatchObject({
          code: exitCode,
          signal: crashSignal,
        });
        expect(fs.existsSync(result.output)).toBe(false);
      }
    },
  );

  reportTest.for([undefined, "projects", "batch-cli"] as const)(
    "classifies the final index write after assertion-red publication: entry=%s",
    { timeout: 60000 },
    async (entry, { expect, reports }) => {
      const result = await reports.run("failure", { entry, finalIndexFailure: true });
      expect(result, result.stderr).toMatchObject({ code: 2, signal: null });
      expect(result.stderr).toContain("owned final index write failure");
      expect(inventory(json(result.output))).toEqual(failedCases("beta/one"));
      const attempted = json(result.reportSet!, "index.json.final-write-attempt");
      expect(attempted).toMatchObject({
        complete: true,
        aggregate: result.output,
        merge: { code: 1, signal: null },
      });
      const failedEntry = attempted.entries.find((attemptedEntry: { config: string }) =>
        attemptedEntry.config.endsWith("test/vitest/vitest.agents-embedded-agent.config.ts"),
      );
      expect(failedEntry.attempts[0].outcome).toMatchObject({ code: 1, signal: null });
      expect(indexOf(result).complete).toBe(false);
    },
  );

  reportTest.for([
    "serial",
    "parallel",
    "grouped",
    "batch",
    "batch-parallel",
    "retry",
    "dotted",
    "metadata",
    "ignored-unhandled",
    "automatic",
    "config-load-once",
    "nested-shared-leaf",
    "batch-real-home",
    "chunks",
    "empty-group",
  ] as const)(
    "retains the exact case union and native originals: %s",
    { timeout: 60000 },
    async (mode, { expect, reports }) => {
      const { root } = reports;
      const result = await reports.run(
        mode === "empty-group" ? "grouped" : mode,
        mode === "empty-group"
          ? { entry: "projects", nativeArgs: ["--project=beta", "--passWithNoTests"] }
          : mode === "automatic"
            ? { env: { CI: "1" } }
            : {},
      );
      let cases = expected;
      if (mode === "nested-shared-leaf") {
        cases = [...expected.slice(0, 2), ...expected].toSorted(compareCases);
      } else if (mode === "chunks") {
        cases = reportChunkTestFiles.map((_, index) => [
          `chunk/${String(index).padStart(2, "0")}`,
          "passed",
        ]);
      } else if (mode === "empty-group") {
        cases = expected.slice(2);
      }
      const index = expectPublished(expect, result, cases);
      const parts: ReportPart[] = index.entries.map(lastPart);
      expect(parts).toHaveLength(2);
      const captures = parts.map(captureOf);
      for (const [partIndex, part] of parts.entries()) {
        expect(fs.existsSync(part.blob)).toBe(true);
        expect(captures[partIndex]!.ended).toBeTruthy();
      }
      if (mode === "grouped") {
        const [alpha, beta] = captures;
        expect(captures.map((capture) => capture.projects)).toEqual([
          [
            {
              ...project(alpha!.root, "alpha", "vitest.alpha.config.ts", "threads"),
              root: path.join(alpha!.root, "test/vitest"),
            },
          ],
          [project(beta!.root, "beta", "vitest.agents-embedded-agent.config.ts", "forks")],
        ]);
        const replay = aggregateOf(result);
        expect(replay.modules).toEqual(captures.flatMap((capture) => capture.modules));
        expect(index.merge).toMatchObject({ code: 0, signal: null });
      }
      if (mode === "metadata") {
        expect(parts.map((part) => json(part.json).snapshot.matched)).toEqual([1, 1]);
        expect(json(result.output).snapshot.matched).toBe(0);
        expect(json(result.output).coverageMap).toBeUndefined();
        for (const part of parts) {
          expect(Object.keys(json(part.json).coverageMap)).toHaveLength(1);
          expect(
            fs.existsSync(path.join(path.dirname(part.json), "coverage/coverage-final.json")),
          ).toBe(true);
        }
      }
      if (mode === "automatic") {
        expect(result.stderr).toContain("2 exact-target plans with parallelism 2");
        expect(index.entries.map((entry: ReportEntry) => entry.attempts.length)).toEqual([1, 1]);
        expect(new Set(parts.flatMap((part) => [part.json, part.blob])).size).toBe(4);
        expect(text(root, "reports/merge-after-joins")).toBe("joined");
        expect(captures.map((capture) => isPidDefinitelyDead(capture.pid))).toEqual([true, true]);
      }
      if (mode === "config-load-once") {
        expect(lines(root, "reports/config-loads.txt")).toEqual(["alpha", "beta"]);
        const replay = aggregateOf(result);
        const defaultCache = path.join(root, "node_modules/.vitest-cache");
        expect(text(defaultCache, "canary")).toBe("another cache owner");
        expect(text(defaultCache, "_metadata.json")).toBe('{"lockfileHash":"unrelated-owner"}');
        for (const name of ["alpha", "beta"]) {
          expect(json(root, `fs-cache-${name}/_metadata.json`).lockfileHash).toBeTypeOf("string");
        }
        expect(replay.projects).toEqual([
          project(root, "alpha", "vitest.unit-fast-isolated.config.ts", "forks"),
          project(root, "beta", "vitest.agents-embedded-agent.config.ts", "forks"),
        ]);
      }
      if (mode === "nested-shared-leaf") {
        const projects = captures.flatMap((capture) => capture.projects);
        expect(serialized(projects)).toEqual(
          serialized([
            project(
              root,
              "outer (inner) (alpha)",
              "vitest.alpha.config.ts",
              "threads",
              "outer (inner)",
            ),
            project(root, "other (alpha)", "vitest.alpha.config.ts", "threads", "other"),
            project(root, "beta", "vitest.beta.config.ts", "forks"),
          ]),
        );
        const modules = captures.flatMap((capture) => capture.modules);
        expect(modules.map((module) => module.namePrefix).toSorted()).toEqual([
          "",
          "other",
          "outer (inner)",
        ]);
        expect(lines(root, "reports/config-loads.txt")).toEqual(["alpha", "alpha", "beta"]);
        const replay = aggregateOf(result);
        expect(serialized(replay.projects)).toEqual(serialized(projects));
        expect(serialized(replay.modules)).toEqual(serialized(modules));
      }
      if (mode === "batch-real-home") {
        expect(result.signal).toBeNull();
        expect(index.merge).toMatchObject({ code: 0, signal: null });
        expect(text(root, "home/canary")).toBe("synthetic caller home\n");
      }
      if (mode === "chunks") {
        expect(result.reportSet).toBeTypeOf("string");
        const chunks: string[][] = index.entries.map(
          (entry: { includePatterns: string[] }) => entry.includePatterns,
        );
        expect(chunks.map((chunk) => chunk.length)).toEqual([6, 5]);
        expect(chunks.flat().toSorted()).toEqual(reportChunkTestFiles);
        expect(new Set(index.entries.map((entry: { config: string }) => entry.config)).size).toBe(
          1,
        );
      }
      if (mode === "empty-group") {
        expect(parts.map((part) => part.outcome.code)).toEqual([0, 0]);
        expect(captures[0]!.modules).toEqual([]);
        expect(captures[0]!.ended?.reason).toBe("passed");
        expect(captures[1]!.modules).toHaveLength(1);
        expect(captures[0]!.projects).toEqual([]);
        expect(aggregateOf(result).modules).toEqual(captures[1]!.modules);
      }
    },
  );

  reportTest(
    "explicit console and coverage overrides isolate automatic runs from config writers",
    { timeout: 60000 },
    async ({ expect, reports }) => {
      const { root } = reports;
      const result = await reports.run("automatic", {
        env: { CI: "1" },
        report: false,
        configOutput: true,
        nativeArgs: ["--reporter=dot", "--coverage.enabled=false"],
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("2 exact-target plans with parallelism 2");
      expect(result.reportSet).toBeUndefined();
      expect(fs.existsSync(path.join(root, "reports/config-output.json"))).toBe(false);
      expect(text(root, "config-coverage/canary")).toBe("retained");
      const events = jsonLines(root, "reports/executed.jsonl");
      expect(
        events.map((event) => event.name).toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(["alpha/one", "beta/one"]);
      expect(events.every((event) => isPidDefinitelyDead(event.pid))).toBe(true);
    },
  );

  reportTest(
    "preserves the first watchdog failure without publishing an aggregate",
    { timeout: 60000 },
    async ({ expect, reports }) => {
      const result = await reports.run("watchdog");
      expect(result.code, result.stderr).toBe(143);
      expect(text(path.dirname(path.dirname(result.output)), "cold-started")).toBe("started");
      const index = indexOf(result);
      expect(index.complete).toBe(false);
      expect(index.entries[0].attempts).toHaveLength(1);
      expect(index.entries[0].attempts[0].outcome).toMatchObject({
        code: 143,
        noOutputTimedOut: true,
      });
      expect(index.entries[1].attempts).toHaveLength(0);
      expect(fs.existsSync(result.output)).toBe(false);
      expect(result.stderr).not.toContain("[test] retrying");
    },
  );

  reportTest.for([
    ["--outputFile=", "failure", undefined, false, false],
    ["--outputFile.json=", "failure", undefined, false, false],
    ["attached", "failure", "projects", true, false],
    ["--outputFile=", "batch-failure", undefined, false, false],
    ["--outputFile.blob", "empty", "projects", false, false],
    ["--outputFile.blob=", "empty", "projects", false, false],
    ["--outputFile.blob", "empty", "projects", false, true],
    ["--outputFile.blob=", "empty", "projects", false, true],
  ] as const)(
    "preserves native output operands: %s mode=%s entry=%s beta=%s CI=%s",
    { timeout: 60000 },
    async ([option, mode, entry, betaOnly, ci], { expect, reports }) => {
      const { root } = reports;
      const output = path.join(root, "reports", betaOnly ? "result.json=" : "result.json");
      const noTests = mode === "empty";
      const outputArgs = noTests
        ? [`--outputFile.json=${output}`, option, "--passWithNoTests=false"]
        : [
            ...(option === "attached"
              ? [`--outputFile=${output}`, "beta.test.ts"]
              : [option, output]),
            "--passWithNoTests",
          ];
      const nativeArgs = [
        ...(noTests ? [] : ["--reporter=verbose"]),
        "--reporter=json",
        ...outputArgs,
      ];
      const parsed = parseCLI(["vitest", "run", ...nativeArgs]);
      expect(parsed.filter).toEqual(betaOnly ? ["beta.test.ts"] : []);
      if (noTests) {
        expect(parsed.options.outputFile).toEqual({ json: output, blob: true });
        expect(parsed.options.passWithNoTests).toBe(false);
      } else {
        const requested = parsed.options.outputFile;
        expect(typeof requested === "string" ? requested : requested?.json).toBe(output);
      }
      const result = await reports.run(mode, {
        entry,
        report: false,
        nativeArgs,
        env: ci ? { CI: "1" } : {},
      });
      if (noTests) {
        const index = indexOf(result);
        const attempt = index.entries[0].attempts[0];
        const capture: VitestReportCapture = json(`${attempt.json}.capture.json`);
        expect(capture, result.stderr).toMatchObject({
          passWithNoTests: false,
          modules: [],
          ended: { reason: "failed" },
        });
        expect(capture.command).toContain("--passWithNoTests=false");
        expect(attempt.outcome).toMatchObject({ code: 1, signal: null });
        expect(result, result.stderr).toMatchObject({ code: ci ? 1 : 2, signal: null });
        expect(index.complete).toBe(ci);
        if (ci) {
          expect(index.entries[1].attempts).toHaveLength(1);
          expect(index.entries[1].attempts[0].outcome).toMatchObject({ code: 1, signal: null });
          expect(index).toMatchObject({ error: "", merge: { code: 1, signal: null } });
          expect(json(output)).toMatchObject({ numTotalTests: 0, success: false });
        } else {
          expect(index.entries[1].attempts).toEqual([]);
          expect(index.merge).toBeNull();
          expect(fs.existsSync(output)).toBe(false);
        }
      } else {
        const report: JsonTestResults = json(output);
        const cases = failedCases("beta/one", betaOnly ? expected.slice(2) : expected);

        expect(inventory(report), result.stderr).toEqual(cases);
        const failed = report.testResults
          .flatMap((file) => file.assertionResults)
          .find((test) => test.fullName.trim() === "beta/one");
        expect(failed?.failureMessages).toEqual(
          expect.arrayContaining([expect.stringContaining("expected 1 to be 2")]),
        );
        expect(result, result.stderr).toMatchObject({ code: 1, signal: null });
        expect(indexOf(result)).toMatchObject({
          complete: true,
          requested: output,
          aggregate: output,
          merge: { code: 1, signal: null },
        });
      }
    },
  );

  reportTest.for(["failure", "fail-fast", "batch-failure", "unhandled", "suite-error"] as const)(
    "publishes complete evidence without erasing native failure: %s",
    { timeout: 60000 },
    async (mode, { expect, reports }) => {
      const result = await reports.run(mode, {
        env: mode === "fail-fast" ? { CI: "1" } : {},
      });
      const failedName =
        mode === "fail-fast"
          ? "alpha/one"
          : mode === "failure" || mode === "batch-failure"
            ? "beta/one"
            : undefined;
      const cases = failedCases(failedName);
      if (mode === "suite-error") {
        cases.push(["broken suite body", "passed"]);
      }
      const index = expectPublished(expect, result, cases, 1);
      expect(index.entries[0].attempts[0].outcome.code).toBe(mode === "fail-fast" ? 1 : 0);
      expect(index.entries[1].attempts[0].outcome.code).toBe(mode === "fail-fast" ? 0 : 1);
      if (mode === "suite-error") {
        const capture = json(`${index.entries[1].attempts[0].json}.capture.json`);
        expect(capture.ended).toMatchObject({ reason: "failed", failedModules: 1, suiteErrors: 1 });
        expect(aggregateOf(result).ended).toEqual(capture.ended);
      }
      if (mode === "unhandled") {
        const part = index.entries[1].attempts[0].json;
        expect(json(part).success).toBe(true);
        expect(json(`${part}.capture.json`).ended.unhandledErrors).toBe(1);
        expect(result.stderr).toContain("owned unhandled rejection");
      }
    },
  );

  reportTest.for([
    ["config-error", "owned configuration failure"],
    ["pool-identity", "Native merge project identity changed"],
    ["nested-shared-leaf-name-drift", "Native merge project identity changed"],
    ["nested-shared-leaf-root-drift", "Native merge project identity changed"],
  ] as const)(
    "retains the old output on %s",
    { timeout: 60000 },
    async ([mode, diagnostic], { expect, reports }) => {
      const result = await reports.run(mode);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain(diagnostic);
      expect(indexOf(result).complete).toBe(false);
      expect(text(result.output)).toBe("old report");
    },
  );

  reportTest.for([
    "missing",
    "coverage-missing",
    "teardown-timeout",
    "corrupt",
    "merge-failure",
    "child-write",
    "final-write",
    "publish-write",
    "identity",
    "tuple",
    "cancel",
    "batch-fail-fast",
    "batch-cancel",
    "overlap",
  ] as const)(
    "never publishes incomplete or failed evidence: %s",
    { timeout: 60000 },
    async (mode, { expect, reports }) => {
      const result = await reports.run(mode);
      if (mode === "cancel" || mode === "batch-cancel") {
        expect(result.signal).toBe("SIGTERM");
      } else {
        expect(result.code, result.stderr).toBe(2);
      }
      const index = indexOf(result);
      const first = index.entries[0].attempts[0];
      const staged = path.join(result.reportSet!, "aggregate.json");
      if (mode === "cancel" || mode === "batch-cancel") {
        expect(first.outcome.signal).toBe("SIGTERM");
        const events = jsonLines(path.dirname(result.output), "executed.jsonl");
        expect(events.map((event) => event.name)).toEqual(["alpha/one"]);
        const capture = json(`${first.json}.capture.json`);
        expect(text(capture.root, "ready")).toBe(String(events[0].pid));
        // The joined group may leave an unreaped Linux zombie, but no live worker.
        expect(isPidDefinitelyDead(events[0].pid)).toBe(true);
      } else if (mode === "batch-fail-fast") {
        const report = json(first.json);
        expect(inventory(report)).toEqual([
          ["alpha/one", "failed"],
          ["alpha/two", "passed"],
        ]);
        expect(report.testResults[0].assertionResults[0].failureMessages.join("\n")).toContain(
          "expected 1 to be 2",
        );
        expect(first.outcome.code).toBe(1);
        expect(json(`${first.json}.capture.json`).ended.reason).toBe("failed");
      } else if (mode === "overlap") {
        expect(index.error).toContain("overlapping task identities");
        expect(fs.existsSync(result.output)).toBe(false);
        const failures = index.entries.map(
          (entry: ReportEntry) =>
            json(entry.attempts[0]!.json).testResults[0].assertionResults[0].failureMessages[0],
        );
        expect(failures).toHaveLength(2);
        expect(new Set(failures).size).toBe(2);
      } else if (mode === "tuple") {
        expect(result.stderr).toContain("cannot preserve config-owned reporter options");
      } else {
        const capture = json(`${first.json}.capture.json`);
        expect(capture.ended.reason).toBe("passed");
        if (mode === "child-write") {
          expect(fs.statSync(first.json).isDirectory()).toBe(true);
          expect(first.outcome.code).toBe(1);
          expect(result.stderr).toContain("EISDIR");
        } else {
          const original = mode === "missing" ? `${first.json}.native-original` : first.json;
          expect(inventory(json(original))).toEqual(expected.slice(0, 2));
          expect(first.outcome.code).toBe(0);
        }
        if (mode === "missing") {
          expect(fs.existsSync(first.json)).toBe(false);
          expect(index.error).toContain("missing Vitest JSON report");
        } else if (mode === "coverage-missing") {
          const lcov = path.join(capture.coverageDirectory, "lcov.info");
          expect(text(`${lcov}.native-original`)).toContain("covered.ts");
          expect(fs.existsSync(lcov)).toBe(false);
          expect(index.error).toContain(lcov);
        } else if (mode === "teardown-timeout") {
          expect(capture.processTimedOut).toBe(true);
          expect(index.error).toContain("completion evidence missing or interrupted");
        } else if (mode !== "child-write") {
          const second = index.entries[1].attempts[0];
          expect(inventory(json(second.json))).toEqual(expected.slice(2));
          expect(second.outcome.code).toBe(0);
          expect(index.merge.code).toBe(mode === "publish-write" ? 0 : 1);
          if (mode === "corrupt") {
            expect(text(first.blob)).toBe("owned corruption");
            expect(() => json(`${first.blob}.native-original`)).not.toThrow();
            expect(result.stderr).toContain("SyntaxError:");
          } else if (mode === "merge-failure") {
            expect(result.stderr).toContain("owned native merge failure");
          } else if (mode === "identity") {
            expect(result.stderr).toContain("Native merge project identity changed");
          } else if (mode === "final-write") {
            expect(fs.statSync(staged).isDirectory()).toBe(true);
            expect(index.error).toContain("EISDIR");
          } else if (mode === "publish-write") {
            expect(inventory(json(staged))).toEqual(expected);
            expect(text(result.output, "old")).toBe("old");
            expect(fs.readFileSync(path.join(index.publication, "report.json"))).toEqual(
              fs.readFileSync(staged),
            );
            expect(index.error).toMatch(/rename/);
          }
        }
      }
      expect(index.error).not.toBe("");
      expect(index).toMatchObject({ complete: false, aggregate: "" });
      if (
        !["corrupt", "merge-failure", "identity", "final-write", "publish-write"].includes(mode)
      ) {
        expect(index.merge).toBeNull();
      }
      if (["missing", "corrupt", "merge-failure", "final-write", "identity"].includes(mode)) {
        expect(text(result.output)).toBe("old report");
      }
      if (["cancel", "batch-fail-fast", "batch-cancel"].includes(mode)) {
        expect(index.entries[1].attempts).toHaveLength(0);
      }
    },
  );

  const nativeControlCases = [
    ["help", ["--help"], "help", true],
    ["short help", ["-h"], "help", false],
    ["native dash prefix", ["---help"], "help", false],
    ["false help", ["--help=false"], "tests", true],
    ["separate false help", ["--help", "false"], "tests", false],
    ["negated help", ["--no-help"], "tests", false],
    ["negated alias", ["--no-h"], "tests", false],
    ["help then negation", ["--help", "--no-help"], "tests", false],
    ["false alias precedence", ["--help=false", "-h"], "tests", false],
    ["long alias precedence", ["--help=false", "--h"], "tests", false],
    ["repeated false", ["--help=false", "--help=false"], "help", false],
    ["short group", ["-vh"], "help", false],
    ["unknown under help", ["--not-an-option", "--help"], "help", true],
    ["missing under help", ["--pool", "--help"], "help", false],
    ["unknown without help", ["--not-an-option", "--help=false"], "error", true],
    ["missing without help", ["--pool", "--no-help"], "error", true],
    ["named run version", ["--version"], "tests", true],
    ["negated version", ["--no-version"], "tests", false],
    ["wrapper consumes separators", ["--", "--help"], "help", true],
    ["list tags", ["--listTags"], "native-error", true],
    ["clear cache", ["--clearCache"], "idle", true],
    ["standalone", ["--standalone"], "native-error", true],
  ] as const;

  it.for(nativeControlCases)(
    "classifies native report admission: %s",
    ([, nativeArgs, kind], { expect }) => {
      const execution = parseVitestExecutionArgs(["run", ...nativeArgs], parseCLI);
      // Native -- preserves the following literal; the project wrapper's
      // consumption of its leading separator is covered by the executable case.
      expect(execution !== null).toBe(kind === "tests" || nativeArgs[0] === "--");
      if (execution) {
        expect(execution.filter).toEqual([]);
      }
    },
  );

  // Keep real child/report proof for each distinct outcome and entry-point rule;
  // aliases and boolean precedence share the admission contract above.
  reportTest.for([
    ...nativeControlCases
      .filter((entry) => entry[3])
      .map(
        ([, args, kind]) =>
          ["serial", "projects", args, kind === "help" ? 2 : 0, kind, undefined, true] as const,
      ),
    ["batch", undefined, ["--help"], 2, "metadata", undefined, false],
    ["batch", undefined, ["--help=false"], 0, "tests", undefined, false],
    ["batch", undefined, ["--", "--help"], 0, "tests", undefined, false],
    ["batch", "batch-cli", ["--help"], 0, "metadata", undefined, false],
    ["batch", "batch-cli", ["--", "--help"], 0, "metadata", undefined, false],
    ["single", "projects", ["--help"], 1, "metadata", undefined, false],
    ["serial", "projects", ["--help"], 2, "metadata", false, false],
  ] as const)(
    "preserves native control ownership: %s entry=%s args=%j",
    { timeout: 60000 },
    async ([mode, entry, nativeArgs, helpBlocks, kind, report, native], { expect, reports }) => {
      const result = await reports.run(mode, {
        entry,
        report,
        nativeArgs: [...nativeArgs],
      });
      expect(result.code, result.stderr).toBe(kind === "error" || kind === "native-error" ? 1 : 0);
      expect(result.stderr).not.toContain("report publication failed");
      expect(result.stdout.match(/Usage:/gu) ?? []).toHaveLength(helpBlocks);
      if (kind === "tests") {
        expect(inventory(json(result.output))).toEqual(expected);
        if (native) {
          expect(indexOf(result).complete).toBe(true);
        }
      } else {
        expect(result.reportSet).toBeUndefined();
        if (native) {
          expect(fs.existsSync(result.output)).toBe(false);
        }
        if (kind === "error") {
          expect(result.stderr).toMatch(/Unknown option|value is missing/u);
        }
        if (kind === "native-error") {
          expect(result.stderr).toMatch(/No test tags found|standalone mode requires --watch/u);
        }
      }
      if (entry === "batch-cli") {
        expect(result.stderr.match(/Usage: pnpm test:extensions:batch/gu)).toHaveLength(1);
      }
    },
  );

  reportTest.for([
    ["empty", [], true],
    ["single", expected.slice(0, 2), false],
  ] as const)(
    "preserves native %s selection reporting",
    { timeout: 60000 },
    async ([mode, cases, owned], { expect, reports }) => {
      const result = await reports.run(mode);
      expect(result.code, result.stderr).toBe(0);
      expect(inventory(json(result.output))).toEqual(cases);
      if (owned) {
        expect(indexOf(result).complete).toBe(true);
      } else {
        expect(result.reportSet).toBeUndefined();
      }
    },
  );

  reportTest(
    "rejects executed same-name projects with different roots",
    { timeout: 60000 },
    async ({ expect, reports }) => {
      const result = await reports.run("grouped-conflict", {
        entry: "projects",
        nativeArgs: ["--project=beta"],
      });
      const index = indexOf(result);
      const modules: VitestReportCapture["modules"] = index.entries.map((entry: ReportEntry) => {
        const attempt = entry.attempts.at(-1)!;
        expect(attempt.outcome.code).toBe(0);
        expect(inventory(json(attempt.json))).toEqual(expected.slice(2));
        const capture = captureOf(attempt);
        expect(capture.modules).toHaveLength(1);
        return capture.modules[0];
      });
      expect(modules.map((module) => module.name)).toEqual(["beta", "beta"]);
      expect(modules[0]!.root).not.toBe(modules[1]!.root);
      expect(modules[0]!.taskId).not.toBe(modules[1]!.taskId);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain('Project name "beta"');
      expect(result.stderr).toContain("is not unique");
      expect(index.complete).toBe(false);
      expect(fs.existsSync(result.output)).toBe(false);
    },
  );
});
