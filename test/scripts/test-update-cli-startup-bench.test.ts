// Test Update Cli Startup Bench tests cover fixture updater subprocess deadlines.
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

const UPDATE_SCRIPT_PATH = path.resolve(process.cwd(), "scripts/test-update-cli-startup-bench.mjs");
const originalArgv = [...process.argv];
const originalTimeoutCleanupGrace = process.env.OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS;
const originalProcessCleanupGrace =
  process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS;

function countBenchmarkCases(preset: "startup" | "real" | "all"): number {
  const source = readFileSync(path.resolve(process.cwd(), "scripts/bench-cli-startup.ts"), "utf8");
  const start = source.indexOf("const COMMAND_CASES");
  const end = source.indexOf("] as const;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const cases = [...source.slice(start, end).matchAll(/presets:\s*\[([^\]]+)\]/gu)].map((match) =>
    [...(match[1] ?? "").matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]),
  );
  return preset === "all" ? cases.length : cases.filter((entry) => entry.includes(preset)).length;
}

afterEach(() => {
  process.argv = [...originalArgv];
  if (originalTimeoutCleanupGrace === undefined) {
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS;
  } else {
    process.env.OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS = originalTimeoutCleanupGrace;
  }
  if (originalProcessCleanupGrace === undefined) {
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS;
  } else {
    process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS =
      originalProcessCleanupGrace;
  }
  spawnSyncMock.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("test-update-cli-startup-bench", () => {
  it("gives the benchmark driver a hard total deadline beyond all internal run budgets", async () => {
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS;
    delete process.env.OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS;
    spawnSyncMock.mockReturnValue({ status: 0 } as SpawnSyncReturns<Buffer>);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    for (const preset of ["startup", "real", "all"] as const) {
      process.argv = [
        process.execPath,
        UPDATE_SCRIPT_PATH,
        "--preset",
        preset,
        "--runs",
        "2",
        "--warmup",
        "1",
        "--timeout-ms",
        "100",
      ];
      spawnSyncMock.mockClear();
      await import("../../scripts/test-update-cli-startup-bench.mjs");

      expect(spawnSyncMock).toHaveBeenCalledOnce();
      const options = spawnSyncMock.mock.calls[0]?.[2];
      const internalBudgetMs = countBenchmarkCases(preset) * (2 + 1) * (100 + 2 * 1_000);
      expect(options?.killSignal).toBe("SIGKILL");
      expect(options?.timeout).toBe(internalBudgetMs + 5_000);
      expect(options?.timeout).toBeGreaterThan(internalBudgetMs);
      vi.resetModules();
    }
  });

  it("exits before a hanging benchmark driver can block fixture refresh forever", async () => {
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fixtureRoot = mkdtempSync(
      path.join(process.cwd(), ".tmp-test-update-cli-startup-bench-"),
    );
    const outputPath = path.join(fixtureRoot, "cli-startup-bench.json");
    try {
      mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
      writeFileSync(
        path.join(fixtureRoot, "scripts/bench-cli-startup.ts"),
        ["setInterval(() => {}, 1_000);", "await new Promise(() => {});", ""].join("\n"),
        "utf8",
      );

      const startedAt = Date.now();
      const result = actualChildProcess.spawnSync(
        process.execPath,
        [
          UPDATE_SCRIPT_PATH,
          "--out",
          outputPath,
          "--preset",
          "startup",
          "--runs",
          "1",
          "--warmup",
          "0",
          "--timeout-ms",
          "10",
        ],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            VITEST: "true",
            OPENCLAW_TEST_CLI_STARTUP_TIMEOUT_KILL_GRACE_MS: "0",
            OPENCLAW_TEST_CLI_STARTUP_BENCH_PROCESS_CLEANUP_GRACE_MS: "100",
          },
          killSignal: "SIGKILL",
          timeout: 5_000,
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
