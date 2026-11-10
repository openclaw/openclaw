import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { compareTestRuntimeLogs } from "../../scripts/ci-compare-test-runtimes.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cli = (args: string[], env = process.env) =>
  spawnSync(process.execPath, ["scripts/ci-compare-test-runtimes.mjs", ...args], {
    encoding: "utf8",
    env,
  });
type Row = ReturnType<typeof compareTestRuntimeLogs>[number];
const row = (
  shard: string,
  runtime: string,
  wallSeconds: number | null,
  fields: Partial<Row> = {},
) => expect.objectContaining({ shard, runtime, wallSeconds, ...fields });
const expectRows = (log: string, rows: ReturnType<typeof row>[]) =>
  expect(compareTestRuntimeLogs(log)).toEqual(rows);

const logLine = (job: string, seconds: string, message: string) =>
  `${job}\tTests\t2026-10-15T12:00:${seconds}Z ${message}`;

const fixture = [
  logLine("node-1", "00.000", "[shard:core] begin"),
  logLine("node-1", "01.000", "[shard:core] ✓ |core| src/example.test.ts > handles inputs 800ms"),
  logLine("node-1", "01.001", "[shard:core] ✓ |core| src/example.test.ts > overlaps 700ms"),
  logLine("node-1", "02.000", "[shard:core] Duration  1.25s (transform 0.25s, tests 1s)"),
  logLine("node-1", "03.000", "[shard:core] end (exit 0)"),
  logLine("node-1", "03.000", "[shard:bun:core] begin"),
  logLine(
    "node-1",
    "04.000",
    "[shard:bun:core] × |core| src/example.test.ts > handles inputs 350ms",
  ),
  logLine("node-1", "04.001", "[shard:bun:core] Test Files  1 failed | 2 passed (3)"),
  logLine("node-1", "04.002", "[shard:bun:core] Tests  1 failed | 4 passed (5)"),
  logLine("node-1", "04.500", "[shard:bun:core] Duration  900ms (tests 350ms)"),
  logLine("node-1", "04.600", "[shard:bun:core] Tests  1 failed | 4 passed (5)"),
  logLine("node-1", "04.700", "[shard:bun:core] Duration  900ms (tests 350ms)"),
  logLine("node-1", "05.000", "[shard:bun:core] end (exit 1)"),
  logLine("node-2", "00.000", "[shard:core] Duration  4s (tests 3s)"),
].join("\n");

it("joins packed timing keys to their child labels without counting the same wall twice", () => {
  expectRows(
    [
      logLine("packed", "00.000", "[shard:bun:release-full-core#selector-1] begin"),
      logLine("packed", "01.000", "[shard:bun:core] Duration 0.5s"),
      logLine("packed", "02.000", "[shard:bun:release-full-core#selector-1] end (exit 0)"),
    ].join("\n"),
    [row("core", "bun", 2, { durationSeconds: 0.5, completedInvocations: 1 })],
  );
});

it("replays saved logs without double-counting overlapping cases or repeated summaries", () => {
  const dir = tempDirs.make("ci-runtime-log-");
  const input = path.join(dir, "input.log"),
    output = path.join(dir, "saved.log");
  writeFileSync(input, fixture);
  const result = cli(["--log-file", input, "--save-log", output, "--json"]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    row("core", "bun", 2, {
      job: "node-1",
      wallSource: "wrapper",
      durationSeconds: 0.9,
      failedInvocations: 1,
      failedTests: 1,
      failedFiles: 1,
      caseMilliseconds: 350,
      failures: ["|core| src/example.test.ts > handles inputs"],
    }),
    row("core", "node", 3, {
      job: "node-1",
      wallSource: "wrapper",
      durationSeconds: 1.25,
      failedInvocations: 0,
      caseMilliseconds: 1500,
      caseLines: 2,
    }),
    row("core", "node", 4, { job: "node-2", wallSource: "vitest-duration" }),
  ]);
  expect(readFileSync(output, "utf8")).toBe(fixture);
});

it("retains incomplete runs, sums serial config durations, and separates native Bun and Node subsets", () => {
  expectRows(
    [
      "[shard:cache] Duration 999s",
      "[shard:resources] begin",
      "[shard:bun:aborted] begin",
      "[shard:bun:aborted] × project a.test.ts > failure 3ms",
      "[shard:node-subset:exceptions] Duration 2s",
      "[shard:node-subset:exceptions] Duration 3s",
      "[shard:bun-native:native] Duration 40ms",
    ].join("\n"),
    [
      row("aborted", "bun", null, { wallSource: "missing", incompleteInvocations: 1 }),
      row("exceptions", "node", 5, { durationReports: 2 }),
      row("native", "bun-native", 0.04),
    ],
  );
});

it("fetches one run archive and ignores duplicate per-step copies of whole-job logs", () => {
  const dir = tempDirs.make("ci-runtime-fetch-");
  // The same Duration line occurs in a whole-job file and its step file.
  const archive =
    "UEsDBBQAAAAIADqcT10M+ng4LgAAAC4AAAAWAAAAMF9jaGVja3Mtbm9kZS1jb3JlLnR4dDMyMDLTNTTQNTQNMTSyMjAAoiiF6OKMxKIUq+T8otRYBZfSosSSzPw8BaNiLgBQSwMEFAAAAAgAOpxPXQz6eDguAAAALgAAABwAAABjaGVja3Mtbm9kZS1jb3JlLzJfVGVzdHMudHh0MzIwMtM1NNA1NA0xNLIyMACiKIXo4ozEohSr5Pyi1FgFl9KixJLM/DwFo2IuAFBLAQIUAxQAAAAIADqcT10M+ng4LgAAAC4AAAAWAAAAAAAAAAAAAACAAQAAAAAwX2NoZWNrcy1ub2RlLWNvcmUudHh0UEsBAhQDFAAAAAgAOpxPXQz6eDguAAAALgAAABwAAAAAAAAAAAAAAIABYgAAAGNoZWNrcy1ub2RlLWNvcmUvMl9UZXN0cy50eHRQSwUGAAAAAAIAAgCOAAAAygAAAAAA";
  const gh = path.join(dir, "gh"),
    calls = path.join(dir, "calls.jsonl");
  writeFileSync(
    gh,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write(Buffer.from(${JSON.stringify(archive)}, 'base64'));\n`,
  );
  chmodSync(gh, 0o755);
  const result = cli(["123", "--json"], {
    ...process.env,
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(
    readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([["api", "repos/openclaw/openclaw/actions/runs/123/logs"]]);
  expect(JSON.parse(result.stdout)).toEqual([
    row("core", "node", 2, { job: "checks-node-core", durationReports: 1 }),
  ]);
});
