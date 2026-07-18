import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/test-cli-startup-bench-budget.mjs";
const TEST_BACKSTOP_MS = process.env.CI ? 8_000 : 4_000;
const BENCHMARK_START_BACKSTOP_MS = process.env.CI ? 20_000 : 12_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type SpawnCall = {
  args: string[];
  call: number;
  detached?: boolean;
};

function runWithResidentSpawn(hangOnCall: number): {
  calls: SpawnCall[];
  result: ReturnType<typeof spawnSync>;
} {
  const tempDir = tempDirs.make("openclaw-startup-budget-deadline-");
  const callsPath = path.join(tempDir, "spawn-calls.jsonl");
  const preloadPath = path.join(tempDir, "mock-spawn.cjs");
  writeFileSync(
    preloadPath,
    [
      'const childProcess = require("node:child_process");',
      'const { EventEmitter } = require("node:events");',
      'const fs = require("node:fs");',
      'const { syncBuiltinESMExports } = require("node:module");',
      "const originalSpawn = childProcess.spawn;",
      "let call = 0;",
      "childProcess.spawn = (command, args, options = {}) => {",
      "  call += 1;",
      "  fs.appendFileSync(",
      "    process.env.OPENCLAW_TEST_SPAWN_CALLS_PATH,",
      "    `${JSON.stringify({ call, args, detached: options.detached })}\\n`,",
      "  );",
      "  if (call < Number(process.env.OPENCLAW_TEST_HANG_ON_SPAWN_CALL)) {",
      "    const child = new EventEmitter();",
      "    child.kill = () => true;",
      "    child.pid = undefined;",
      '    process.nextTick(() => child.emit("close", 0, null));',
      "    return child;",
      "  }",
      "  return originalSpawn(",
      "    process.execPath,",
      '    ["--eval", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"],',
      "    options,",
      "  );",
      "};",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        preloadPath,
        SCRIPT_PATH,
        "--preset",
        "all",
        "--runs",
        "2",
        "--warmup",
        "3",
        "--timeout-ms",
        "1",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CLI_STARTUP_BUILD_TIMEOUT_MS: "1",
          OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS: "2",
          OPENCLAW_TEST_HANG_ON_SPAWN_CALL: String(hangOnCall),
          OPENCLAW_TEST_SPAWN_CALLS_PATH: callsPath,
          VITEST: "1",
        },
        killSignal: "SIGKILL",
        timeout: TEST_BACKSTOP_MS,
      },
    );
    const calls = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SpawnCall);
    return { calls, result };
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

describe("test-cli-startup-bench-budget deadlines", () => {
  it("bounds a stalled build child before the test backstop", () => {
    const { calls, result } = runWithResidentSpawn(1);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build timed out after 3ms");
    expect(calls).toEqual([
      expect.objectContaining({
        args: ["scripts/ensure-cli-startup-build.mjs"],
        call: 1,
        detached: process.platform !== "win32",
      }),
    ]);
  });

  it("bounds the whole benchmark after build success before the test backstop", () => {
    const { calls, result } = runWithResidentSpawn(2);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("benchmark timed out after 1254ms");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(
      expect.objectContaining({
        call: 2,
        detached: process.platform !== "win32",
      }),
    );
  });

  it.runIf(process.platform !== "win32")(
    "cleans an active detached sample when the benchmark is terminated",
    async () => {
      const tempDir = tempDirs.make("openclaw-startup-budget-cleanup-");
      const samplePidPath = path.join(tempDir, "sample.pid");
      const entryPath = path.join(tempDir, "resident-entry.mjs");
      const reportPath = path.join(tempDir, "report.json");
      writeFileSync(
        entryPath,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(samplePidPath)}, JSON.stringify({ pid: process.pid, runRoot: process.env.OPENCLAW_HOME }));`,
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      let benchmarkPid = 0;
      let samplePid = 0;
      let sampleRunRoot = "";
      try {
        const benchmark = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "scripts/bench-cli-startup.ts",
            "--entry",
            entryPath,
            "--case",
            "version",
            "--runs",
            "1",
            "--warmup",
            "0",
            "--timeout-ms",
            "10000",
            "--output",
            reportPath,
          ],
          {
            cwd: process.cwd(),
            detached: true,
            env: {
              ...process.env,
              OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS: "50",
              VITEST: "1",
            },
            stdio: "ignore",
          },
        );
        benchmarkPid = benchmark.pid ?? 0;
        expect(benchmarkPid).toBeGreaterThan(0);
        expect(
          await waitForCondition(() => existsSync(samplePidPath), BENCHMARK_START_BACKSTOP_MS),
        ).toBe(true);
        const sampleState = JSON.parse(readFileSync(samplePidPath, "utf8")) as {
          pid: number;
          runRoot: string;
        };
        samplePid = sampleState.pid;
        sampleRunRoot = sampleState.runRoot;
        expect(samplePid).toBeGreaterThan(0);
        expect(isProcessAlive(samplePid)).toBe(true);
        expect(existsSync(sampleRunRoot)).toBe(true);

        process.kill(-benchmarkPid, "SIGTERM");
        expect(
          await waitForCondition(
            () => benchmark.exitCode !== null || benchmark.signalCode !== null,
            TEST_BACKSTOP_MS,
          ),
        ).toBe(true);
        expect(await waitForCondition(() => !isProcessAlive(samplePid), 1_000)).toBe(true);
        expect(existsSync(sampleRunRoot)).toBe(false);
      } finally {
        if (samplePid > 0 && isProcessAlive(samplePid)) {
          process.kill(-samplePid, "SIGKILL");
        }
        if (benchmarkPid > 0 && isProcessAlive(benchmarkPid)) {
          process.kill(-benchmarkPid, "SIGKILL");
        }
        if (sampleRunRoot) {
          rmSync(sampleRunRoot, { force: true, recursive: true });
        }
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );
});
