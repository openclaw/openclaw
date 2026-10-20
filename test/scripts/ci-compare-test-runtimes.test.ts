import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareTestRuntimeLogs } from "../../scripts/ci-compare-test-runtimes.mjs";

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

describe("CI test runtime comparison", () => {
  it("joins packed timing keys to their child labels without counting the same wall twice", () => {
    expect(
      compareTestRuntimeLogs(
        [
          logLine("packed", "00.000", "[shard:bun:release-full-core#selector-1] begin"),
          logLine("packed", "01.000", "[shard:bun:core] Duration 0.5s"),
          logLine("packed", "02.000", "[shard:bun:release-full-core#selector-1] end (exit 0)"),
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({
        shard: "core",
        runtime: "bun",
        wallSeconds: 2,
        durationSeconds: 0.5,
        completedInvocations: 1,
      }),
    ]);
  });

  it("compares runtime walls and failures per job without treating overlapping cases as wall time", () => {
    const rows = compareTestRuntimeLogs(fixture);
    expect(rows).toEqual([
      expect.objectContaining({
        job: "node-1",
        shard: "core",
        runtime: "bun",
        wallSeconds: 2,
        wallSource: "wrapper",
        durationSeconds: 0.9,
        failedInvocations: 1,
        failedTests: 1,
        failedFiles: 1,
        caseMilliseconds: 350,
        failures: ["|core| src/example.test.ts > handles inputs"],
      }),
      expect.objectContaining({
        job: "node-1",
        shard: "core",
        runtime: "node",
        wallSeconds: 3,
        wallSource: "wrapper",
        durationSeconds: 1.25,
        failedInvocations: 0,
        caseMilliseconds: 1500,
        caseLines: 2,
      }),
      expect.objectContaining({
        job: "node-2",
        shard: "core",
        runtime: "node",
        wallSeconds: 4,
        wallSource: "vitest-duration",
      }),
    ]);
  });

  it("retains incomplete runs, sums serial config durations, and separates native Bun and Node subsets", () => {
    expect(
      compareTestRuntimeLogs(
        [
          "[shard:cache] Duration 999s",
          "[shard:resources] begin",
          "[shard:bun:aborted] begin",
          "[shard:bun:aborted] × project a.test.ts > failure 3ms",
          "[shard:node-subset:exceptions] Duration 2s",
          "[shard:node-subset:exceptions] Duration 3s",
          "[shard:bun-native:native] Duration 40ms",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({
        shard: "aborted",
        runtime: "bun",
        wallSeconds: null,
        wallSource: "missing",
        incompleteInvocations: 1,
      }),
      expect.objectContaining({
        shard: "exceptions",
        runtime: "node",
        wallSeconds: 5,
        durationReports: 2,
      }),
      expect.objectContaining({ shard: "native", runtime: "bun-native", wallSeconds: 0.04 }),
    ]);
  });

  it("replays a saved run log through the CLI and preserves it for repeat analysis", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ci-runtime-log-"));
    try {
      const input = path.join(dir, "input.log"),
        output = path.join(dir, "saved.log");
      writeFileSync(input, fixture);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/ci-compare-test-runtimes.mjs",
          "--log-file",
          input,
          "--save-log",
          output,
          "--json",
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveLength(3);
      expect(readFileSync(output, "utf8")).toBe(fixture);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetches one run archive and ignores duplicate per-step copies of whole-job logs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ci-runtime-fetch-"));
    try {
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
      const result = spawnSync(
        process.execPath,
        ["scripts/ci-compare-test-runtimes.mjs", "123", "--json"],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(
        readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([["api", "repos/openclaw/openclaw/actions/runs/123/logs"]]);
      expect(JSON.parse(result.stdout)).toEqual([
        expect.objectContaining({
          job: "checks-node-core",
          shard: "core",
          runtime: "node",
          wallSeconds: 2,
          durationReports: 1,
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
