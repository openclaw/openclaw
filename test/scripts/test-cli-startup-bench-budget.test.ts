import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/test-cli-startup-bench-budget.mjs";
const TEST_BACKSTOP_MS = process.env.CI ? 8_000 : 4_000;

type SpawnCall = {
  args: string[];
  call: number;
  killSignal?: string;
  timeout?: number;
};

function runWithResidentSpawn(hangOnCall: number): {
  calls: SpawnCall[];
  result: ReturnType<typeof spawnSync>;
} {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-startup-budget-deadline-"));
  const callsPath = path.join(tempDir, "spawn-calls.jsonl");
  const preloadPath = path.join(tempDir, "mock-spawn-sync.cjs");
  writeFileSync(
    preloadPath,
    [
      'const childProcess = require("node:child_process");',
      'const fs = require("node:fs");',
      'const { syncBuiltinESMExports } = require("node:module");',
      "const originalSpawnSync = childProcess.spawnSync;",
      "let call = 0;",
      "childProcess.spawnSync = (command, args, options = {}) => {",
      "  call += 1;",
      "  fs.appendFileSync(",
      "    process.env.OPENCLAW_TEST_SPAWN_CALLS_PATH,",
      "    `${JSON.stringify({ call, args, timeout: options.timeout, killSignal: options.killSignal })}\\n`,",
      "  );",
      "  if (call < Number(process.env.OPENCLAW_TEST_HANG_ON_SPAWN_CALL)) {",
      "    return { error: undefined, output: [null, null, null], pid: 1, signal: null, status: 0, stderr: null, stdout: null };",
      "  }",
      "  return originalSpawnSync(",
      "    process.execPath,",
      '    ["--eval", "setInterval(() => {}, 1000)"],',
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
    expect(calls).toEqual([
      expect.objectContaining({
        call: 1,
        killSignal: "SIGKILL",
        timeout: 3,
      }),
    ]);
  });

  it("bounds the whole benchmark after build success before the test backstop", () => {
    const { calls, result } = runWithResidentSpawn(2);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(
      expect.objectContaining({
        call: 2,
        killSignal: "SIGKILL",
        timeout: 1_252,
      }),
    );
  });
});
