import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  resolveAggregateSqliteInspectionTimeoutMs,
  resolveSqliteInspectionBudget,
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
} from "./sqlite-readonly-worker.js";

const logs = vi.hoisted(() => ({ debug: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      debug: logs.debug,
    }),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileSpy = vi.fn(actual.execFile);
  Object.defineProperties(execFileSpy, Object.getOwnPropertyDescriptors(actual.execFile));
  return { ...actual, execFile: execFileSpy, spawnSync: vi.fn(actual.spawnSync) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.mocked(execFile).mockClear();
  vi.mocked(spawnSync).mockClear();
  logs.debug.mockClear();
});

function createDatabase(paddingBytes: number | null): string {
  const source = path.join(tempDirs.make("openclaw-snapshot-budget-"), "source.sqlite");
  const database = new (requireNodeSqlite().DatabaseSync)(source);
  try {
    if (paddingBytes !== null) {
      database.exec("CREATE TABLE padding (data BLOB)");
      database.prepare("INSERT INTO padding VALUES (zeroblob(?))").run(paddingBytes);
    }
  } finally {
    database.close();
  }
  return source;
}

describe("resolveSqliteInspectionBudget", () => {
  it.each(
    [
      { label: "0 B", sizeBytes: 0, expected: 30_000 },
      { label: "1 B", sizeBytes: 1, expected: 31_000 },
      { label: "32 MiB", sizeBytes: 32 * 1024 * 1024, expected: 31_000 },
      { label: "32 MiB + 1 B", sizeBytes: 32 * 1024 * 1024 + 1, expected: 32_000 },
      { label: "300 MiB", sizeBytes: 300 * 1024 * 1024, expected: 40_000 },
      { label: "9.4 GiB", sizeBytes: Math.floor(9.4 * 1024 ** 3), expected: 331_000 },
      { label: "64 GiB (capped)", sizeBytes: 64 * 1024 ** 3, expected: 1_800_000 },
      { label: "huge file (capped)", sizeBytes: Number.MAX_SAFE_INTEGER, expected: 1_800_000 },
    ].flatMap((testCase) => [
      { ...testCase, inputType: "number" },
      { ...testCase, inputType: "bigint", sizeBytes: BigInt(testCase.sizeBytes) },
    ]),
  )("budgets $label ($inputType)", ({ sizeBytes, expected }) => {
    expect(
      resolveSqliteInspectionBudget("read-only snapshot", "source.sqlite", sizeBytes).timeoutMs,
    ).toBe(expected);
  });
});

it("sums serial size-aware schema inspection budgets without giant fixtures", () => {
  expect(
    resolveAggregateSqliteInspectionTimeoutMs("state schema inspection", [
      { path: "large.sqlite", sizeBytes: 3_489_660_928n },
      { path: "second.sqlite", sizeBytes: 64n * 1024n * 1024n },
    ]),
  ).toBe(166_000);
  expect(resolveAggregateSqliteInspectionTimeoutMs("state schema inspection", [])).toBe(30_000);
  expect(
    resolveAggregateSqliteInspectionTimeoutMs(
      "state schema inspection",
      Array.from({ length: 2_000 }, (_, index) => ({
        path: `database-${index}.sqlite`,
        sizeBytes: BigInt(Number.MAX_SAFE_INTEGER),
      })),
    ),
  ).toBe(2_147_483_647);
});

it("includes WAL and rollback-journal sidecars in inspection size", () => {
  const source = path.join(tempDirs.make("openclaw-snapshot-size-"), "source.sqlite");
  fs.writeFileSync(source, "");
  fs.writeFileSync(`${source}-wal`, "");
  fs.writeFileSync(`${source}-journal`, "");
  fs.truncateSync(source, 64 * 1024 * 1024);
  fs.truncateSync(`${source}-wal`, 3_489_660_928);
  fs.truncateSync(`${source}-journal`, 4 * 1024);

  const stagingRoot = tempDirs.make("openclaw-snapshot-size-staging-");
  // Isolate deadline selection from copying these deliberately sparse sidecars.
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 1,
    output: [null, '{"ok":true,"location":"private.sqlite"}', ""],
    stdout: '{"ok":true,"location":"private.sqlite"}',
    stderr: "",
    status: 0,
    signal: null,
  });
  expect(runSqliteReadOnlyWorkerSync(source, stagingRoot)).toBe("private.sqlite");
  expect(vi.mocked(spawnSync).mock.calls[0]?.[2]).toMatchObject({
    timeout: 137_000,
    killSignal: "SIGKILL",
  });
});

describe.each(["async", "sync"] as const)("SQLite read-only snapshot worker (%s)", (mode) => {
  async function run(source: string): Promise<string> {
    const stagingRoot = tempDirs.make("openclaw-snapshot-budget-staging-");
    return mode === "sync"
      ? runSqliteReadOnlyWorkerSync(source, stagingRoot)
      : runSqliteReadOnlyWorker(source, { mode: "async", stagingRoot });
  }

  function expectBudget(timeout: number): void {
    const calls =
      mode === "sync" ? vi.mocked(spawnSync).mock.calls : vi.mocked(execFile).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).toMatchObject({ timeout, killSignal: "SIGKILL" });
  }

  it.each([
    { label: "empty", paddingBytes: null, timeout: 30_000 },
    { label: "small", paddingBytes: 0, timeout: 31_000 },
    { label: "over 32 MiB", paddingBytes: 32 * 1024 * 1024, timeout: 32_000 },
  ])("snapshots a $label database with its size budget", async ({ paddingBytes, timeout }) => {
    const source = createDatabase(paddingBytes);
    if (paddingBytes) {
      expect(fs.statSync(source).size).toBeGreaterThan(32 * 1024 * 1024);
      expect(fs.statSync(source).size).toBeLessThan(64 * 1024 * 1024);
    }
    const snapshot = await run(source);
    expect(fs.existsSync(snapshot)).toBe(true);
    expectBudget(timeout);
    if (timeout > 30_000) {
      expect(logs.debug).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`SQLite read-only snapshot for ${source}:`),
      );
      expect(logs.debug).toHaveBeenCalledWith(
        expect.stringContaining(`budget ${timeout / 1000} seconds`),
      );
    } else {
      expect(logs.debug).not.toHaveBeenCalled();
    }
  });

  it.each([
    { label: "empty", paddingBytes: null, seconds: 30, size: "0 B" },
    { label: "over 32 MiB", paddingBytes: 32 * 1024 * 1024, seconds: 32, size: "32.0 MiB" },
    { label: "missing", paddingBytes: null, seconds: 30, size: "unknown size" },
  ])(
    "reports the applied budget and size for a $label timeout",
    async ({ label, paddingBytes, seconds, size }) => {
      const source =
        label === "missing"
          ? path.join(tempDirs.make("openclaw-snapshot-budget-missing-"), "missing.sqlite")
          : createDatabase(paddingBytes);
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      // Keep the real timeout/close behavior without waiting out the production budget.
      if (mode === "sync") {
        vi.mocked(spawnSync).mockImplementationOnce((command, args, options) =>
          actual.spawnSync(command, args, { ...options, timeout: 1 }),
        );
      } else {
        vi.mocked(execFile).mockImplementationOnce((file, args, options, callback) =>
          actual.execFile(file, args, { ...options, timeout: 1 }, callback),
        );
      }
      await expect(run(source)).rejects.toThrow(
        `SQLite read-only snapshot timed out after ${seconds} seconds (budget for ${size}) for ${source}. Stop the Gateway service and other OpenClaw processes using this database, then retry; if already stopped, check storage performance.`,
      );
      expectBudget(seconds * 1000);
    },
  );

  it("uses the base budget on stat failure and retains the child's source error", async () => {
    const source = path.join(tempDirs.make("openclaw-snapshot-budget-missing-"), "missing.sqlite");
    await expect(run(source)).rejects.toThrow(/SQLite read-only worker.*ENOENT/);
    expectBudget(30_000);
    expect(logs.debug).not.toHaveBeenCalled();
  });
});
