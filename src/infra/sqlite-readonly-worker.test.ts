import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  runtimeProcessEntrypoints,
  SQLITE_READONLY_CHILD_ARG,
} from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { sqliteReadOnlyWorkerRequestArgs } from "./sqlite-readonly-worker-protocol.js";
import {
  captureSqliteReadOnlyWorkerLaunch,
  createScopedSqliteReadOnlyWorker,
  resolveAggregateSqliteInspectionTimeoutMs,
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
  withSqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker.js";
import {
  prepareSqliteReadOnlyLocation,
  startSqliteReadOnlyLocationAsync,
} from "./sqlite-snapshot-source.js";
import { allocateWorkerOwnedSqliteSnapshotDirectory } from "./sqlite-snapshot-staging-allocation.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";

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
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFileSpy = vi.fn(actual.execFile);
  Object.defineProperty(
    execFileSpy,
    promisify.custom,
    Object.getOwnPropertyDescriptor(actual.execFile, promisify.custom)!,
  );
  return {
    ...actual,
    execFile: execFileSpy,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.mocked(execFile).mockReset();
  vi.mocked(spawn).mockClear();
  vi.mocked(spawnSync).mockClear();
  logs.debug.mockClear();
});

it("keeps execFile resettable while preserving promisified stdout and stderr", async () => {
  const { promisify } = await import("node:util");
  expect(() => vi.resetAllMocks()).not.toThrow();
  await expect(
    promisify(execFile)(process.execPath, [
      "-e",
      'process.stdout.write("synthetic stdout"); process.stderr.write("synthetic stderr");',
    ]),
  ).resolves.toEqual({ stdout: "synthetic stdout", stderr: "synthetic stderr" });
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

async function readSnapshotVersion(source: string) {
  const stagingRoot = tempDirs.make("openclaw-scoped-snapshot-");
  const location = await runSqliteReadOnlyWorker(source, { mode: "sync", stagingRoot });
  const snapshot = new (requireNodeSqlite().DatabaseSync)(location, { readOnly: true });
  try {
    return snapshot.prepare("PRAGMA user_version").get()?.user_version;
  } finally {
    snapshot.close();
  }
}

describe("scoped SQLite read-only children", () => {
  it.each(["callback", "throw"])(
    "joins a staging IPC send %s failure before admitting another request",
    async (failureMode) => {
      const stagingRoot = tempDirs.make("openclaw-staging-send-failure-");
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const failure = new Error("fixture IPC channel closed");
      vi.mocked(spawn).mockImplementationOnce((...args) => {
        const child = actual.spawn(...args);
        vi.spyOn(child, "send").mockImplementationOnce((_message: unknown, callback?: unknown) => {
          if (failureMode === "throw") {
            throw failure;
          }
          if (typeof callback !== "function") {
            throw new Error("fixture expected an IPC completion callback");
          }
          queueMicrotask(() => callback(failure));
          return false;
        });
        return child;
      });
      const failed = createScopedSqliteReadOnlyWorker(captureSqliteReadOnlyWorkerLaunch());
      try {
        await expect(failed.run(stagingRoot, { mode: "staging-create" })).rejects.toBe(failure);
        expect(vi.mocked(spawn).mock.results[0]?.value.signalCode).toBe("SIGKILL");
      } finally {
        await failed.close();
      }
      const replacement = createScopedSqliteReadOnlyWorker(captureSqliteReadOnlyWorkerLaunch());
      try {
        const directory = await replacement.run(stagingRoot, { mode: "staging-create" });
        if (typeof directory !== "string") {
          throw new Error("Expected a staging directory");
        }
        expect(fs.existsSync(directory)).toBe(true);
        await replacement.run(directory, { mode: "staging-retire" });
      } finally {
        await replacement.close();
      }
      expect(spawn).toHaveBeenCalledTimes(2);
    },
  );

  it("reuses fresh raw snapshots while joining backup-capable children before returning", async () => {
    const source = createDatabase(1024 * 1024);
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(source);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    try {
      await withSqliteReadOnlyWorkerScope(async () => {
        for (const [index, mode] of (["sync", "async", "sync"] as const).entries()) {
          writer.exec(`PRAGMA user_version = ${index + 1}`);
          if (mode === "sync") {
            expect(await readSnapshotVersion(source)).toBe(index + 1);
          } else {
            const prepared = await prepareSqliteReadOnlyLocation(source);
            try {
              const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
              try {
                expect(snapshot.prepare("PRAGMA user_version").get()).toEqual({
                  user_version: index + 1,
                });
                expect(
                  snapshot.prepare("SELECT length(data) AS length FROM padding").get(),
                ).toEqual({ length: 1024 * 1024 });
              } finally {
                snapshot.close();
              }
            } finally {
              expect(await prepared.cleanupAsync()).toBe(true);
            }
            const child = vi.mocked(execFile).mock.results.at(-1)?.value;
            expect(child?.exitCode).toBe(0);
            expect(child?.connected).toBe(false);
          }
          expect(vi.mocked(spawn).mock.results[0]?.value.exitCode).toBeNull();
        }
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      const children = vi.mocked(execFile).mock.calls.flatMap(([, args], index) => {
        const marker = args?.indexOf(SQLITE_READONLY_CHILD_ARG) ?? -1;
        return marker < 0
          ? []
          : [{ mode: args?.[marker + 1], child: vi.mocked(execFile).mock.results[index]?.value }];
      });
      expect(children.filter(({ mode }) => mode !== "reclaim").map(({ mode }) => mode)).toEqual([
        "async",
      ]);
      for (const { child } of children) {
        expect(child?.exitCode).toBe(0);
        expect(child?.connected).toBe(false);
      }
      expect(vi.mocked(spawn).mock.results[0]?.value.exitCode).toBe(0);
    } finally {
      writer.close();
    }
  });

  it("keeps concurrent source inspections in separate processes", async () => {
    const source = createDatabase(0);
    await withSqliteReadOnlyWorkerScope(async () => {
      expect(await Promise.all([readSnapshotVersion(source), readSnapshotVersion(source)])).toEqual(
        [0, 0],
      );
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.results[0]?.value.pid).not.toBe(
      vi.mocked(execFile).mock.results[0]?.value.pid,
    );
  });

  it("refuses a descendant inspection after its scope closes", async () => {
    let resume: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let late: Promise<unknown> | undefined;
    await withSqliteReadOnlyWorkerScope(async () => {
      late = resumed.then(() => runSqliteReadOnlyWorker("unused.sqlite", { mode: "async" }));
    });
    resume!();
    await expect(late).rejects.toThrow("scope closed");
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});

it("sums serial size-aware schema inspection budgets without giant fixtures", () => {
  expect(
    resolveAggregateSqliteInspectionTimeoutMs("state schema inspection", [
      { path: "large.sqlite", sizeBytes: 3_489_660_928n },
      { path: "second.sqlite", sizeBytes: 64n * 1024n * 1024n },
    ]),
  ).toBe(4_840_000);
  expect(resolveAggregateSqliteInspectionTimeoutMs("state schema inspection", [])).toBe(300_000);
  expect(
    resolveAggregateSqliteInspectionTimeoutMs(
      "state schema inspection",
      Array.from({ length: 2_000 }, (_, index) => ({
        path: `database-${index}.sqlite`,
        sizeBytes: BigInt(Number.MAX_SAFE_INTEGER),
      })),
    ),
  ).toBe(MAX_TIMER_TIMEOUT_MS);
});

it("preserves an intermittent failed launch without parsing absent worker output", async () => {
  const source = createDatabase(null);
  const stagingRoot = tempDirs.make("openclaw-snapshot-launch-");
  const run = () => runSqliteReadOnlyWorkerSync(source, stagingRoot);
  expect(fs.existsSync(run())).toBe(true);

  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  // Use Node's actual failed-launch result: its declared string outputs can be absent.
  vi.mocked(spawnSync).mockImplementationOnce((_command, args, options) =>
    actual.spawnSync(path.join(stagingRoot, "missing-node"), args, options),
  );
  expect(run).toThrow(
    expect.objectContaining({
      message: expect.stringContaining(`failed to start for ${source}`),
      cause: expect.objectContaining({ code: "ENOENT" }),
    }),
  );

  expect(fs.existsSync(run())).toBe(true);
  expect(fs.readFileSync(source)).toEqual(Buffer.alloc(0));
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

  it("budgets the WAL family while copying committed data from an open writer", async () => {
    const source = createDatabase(null);
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(source);
    try {
      writer.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE padding (data BLOB)",
      );
      writer.prepare("INSERT INTO padding VALUES (zeroblob(?))").run(32 * 1024 * 1024);
      const mainBytes = fs.statSync(source).size;
      const walBytes = fs.statSync(`${source}-wal`).size;
      expect(mainBytes).toBeLessThan(32 * 1024);
      expect(walBytes).toBeGreaterThan(32 * 1024 * 1024);
      const snapshot = await run(source);
      if (mode === "async") {
        expect(fs.existsSync(`${snapshot}-wal`)).toBe(false);
        expect(fs.existsSync(`${snapshot}-shm`)).toBe(false);
      }
      const copied = new sqlite.DatabaseSync(snapshot, { readOnly: true });
      try {
        expect(copied.prepare("SELECT length(data) AS bytes FROM padding").all()).toEqual([
          { bytes: 32 * 1024 * 1024 },
        ]);
      } finally {
        copied.close();
      }
      expectBudget(341_000);
    } finally {
      writer.close();
    }
  });

  it("reports the applied size budget for a timed-out snapshot", async () => {
    const source = createDatabase(32 * 1024 * 1024);
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
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
      `SQLite read-only snapshot timed out after 341 seconds (budget for 32.0 MiB) for ${source}. Stop the Gateway service and other OpenClaw processes using this database, then retry; if already stopped, check storage performance.`,
    );
    expectBudget(341_000);
  });

  it("uses the base budget on stat failure and retains the child's source error", async () => {
    const source = path.join(tempDirs.make("openclaw-snapshot-budget-missing-"), "missing.sqlite");
    await expect(run(source)).rejects.toThrow(/SQLite read-only worker.*ENOENT/);
    expectBudget(300_000);
    expect(logs.debug).not.toHaveBeenCalled();
  });
});

it.each(
  process.platform !== "win32" && process.getuid?.() !== 0
    ? ["unavailable", "inaccessible"]
    : ["unavailable"],
)("cold-starts an absolute SQLite snapshot when the invoking cwd is %s", async (condition) => {
  const root = tempDirs.make("openclaw-sqlite-unavailable-cwd-");
  const source = path.join(root, "source.sqlite");
  const stagingRoot = path.join(root, "staging");
  fs.mkdirSync(stagingRoot);
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(source);
  writer.exec("CREATE TABLE witness (value TEXT); INSERT INTO witness VALUES ('preserved');");
  writer.close();
  const before = fs.readFileSync(source);
  const inaccessibleCwd = path.join(root, "inaccessible-cwd");
  fs.mkdirSync(inaccessibleCwd, { mode: 0o000 });
  const unavailable = new Error("ENOENT: invoking directory was removed");
  const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
    if (condition === "inaccessible") {
      return inaccessibleCwd;
    }
    throw unavailable;
  });
  let worker: ReturnType<typeof createScopedSqliteReadOnlyWorker> | undefined;
  let witness: unknown;
  try {
    worker = createScopedSqliteReadOnlyWorker(captureSqliteReadOnlyWorkerLaunch());
    const location = await worker.run(source, { mode: "sync", stagingRoot });
    if (typeof location !== "string") {
      throw new Error("Snapshot worker did not return its absolute location");
    }
    const reader = new DatabaseSync(location, { readOnly: true });
    try {
      witness = reader.prepare("SELECT value FROM witness").get();
    } finally {
      reader.close();
    }
  } finally {
    cwd.mockRestore();
    fs.chmodSync(inaccessibleCwd, 0o700);
    await worker?.close();
  }
  expect(witness).toEqual({ value: "preserved" });
  expect(fs.readFileSync(source)).toEqual(before);
});

it.each(["source", "allocation", "staging"] as const)(
  "refuses unresolved relative %s paths instead of rebasing them after cwd loss",
  async (input) => {
    const source = path.join(tempDirs.make("openclaw-sqlite-relative-cwd-"), "source.sqlite");
    const unavailable = new Error("ENOENT: invoking directory was removed");
    const cwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw unavailable;
    });
    let observed: unknown;
    try {
      try {
        if (input === "source") {
          await startSqliteReadOnlyLocationAsync("relative.sqlite").result;
        } else if (input === "allocation") {
          await allocateWorkerOwnedSqliteSnapshotDirectory("relative-staging", false);
        } else {
          sqliteReadOnlyWorkerRequestArgs(source, {
            mode: "sync",
            stagingRoot: "relative-staging",
          });
        }
      } catch (error) {
        observed = error;
      }
    } finally {
      cwd.mockRestore();
    }
    expect(observed).toBe(unavailable);
  },
);

it.runIf(process.platform !== "win32")(
  "reports the real SQLite write errcode across the isolated worker boundary",
  () => {
    const cacheRoot = tempDirs.make("openclaw-sqlite-snapshot-worker-full-");
    const sqlite = requireNodeSqlite();
    const databasePath = path.join(tempDirs.make("openclaw-sqlite-diagnostics-"), "state.sqlite");
    const database = new sqlite.DatabaseSync(databasePath);
    database.exec("CREATE TABLE probe (payload BLOB); INSERT INTO probe VALUES (zeroblob(8192));");
    database.close();
    const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteReadOnly);
    const extension = workerUrl.pathname.endsWith(".ts") ? ".ts" : ".js";
    const moduleUrl = new URL(`./sqlite-snapshot-source${extension}`, workerUrl).href;
    const script = `
      const { prepareSqliteReadOnlyLocation } = await import(${JSON.stringify(moduleUrl)});
      try {
        await prepareSqliteReadOnlyLocation(${JSON.stringify(databasePath)});
        process.exitCode = 24;
      } catch (error) {
        console.log(JSON.stringify({ message: error.message }));
      }
    `;
    const child = spawnSync(
      "/bin/sh",
      [
        "-c",
        'ulimit -f 1; exec "$@"',
        "openclaw-sqlite-snapshot-quota",
        process.execPath,
        ...resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, XDG_CACHE_HOME: cacheRoot },
      },
    );

    expect(child.status, child.stderr).toBe(0);
    const reported = JSON.parse(child.stdout) as { message: string };
    expect(reported.message).toContain(cacheRoot);
    expect(reported.message).toContain("check filesystem health and write permissions");
    expect(reported.message).not.toContain("free disk space/quota");
    expect(reported.message).toContain("(code=ERR_SQLITE_ERROR, errcode=778)");
  },
);

it("distinguishes actual worker startup from serialized directory creation failures", async () => {
  const root = tempDirs.make("openclaw-sqlite-worker-diagnostics-");
  const notDirectory = path.join(root, "file");
  fs.writeFileSync(notDirectory, "preserved");
  const allocationError = await createSqliteSnapshotStagingDirectory(
    notDirectory,
    false,
    undefined,
    true,
  ).catch((error: unknown) => error);
  expect(allocationError).toBeInstanceOf(Error);
  expect((allocationError as Error).message).toContain(`snapshot staging root ${notDirectory}`);
  expect((allocationError as Error).message).toContain("XDG_CACHE_HOME");
  expect((allocationError as Error).message).not.toContain("free disk space/quota");
  expect((allocationError as Error).message.match(/snapshot staging root/gu)).toHaveLength(1);
  expect(fs.readFileSync(notDirectory, "utf8")).toBe("preserved");

  const cwd = path.join(root, "missing-cwd");
  const worker = createScopedSqliteReadOnlyWorker({
    cwd,
    env: { ...process.env },
    transport: { kind: "native" },
    retainLifetime: false,
  });
  try {
    const startupError = await worker
      .run(root, { mode: "staging-create" })
      .catch((error: unknown) => error);
    expect(startupError).toMatchObject({ code: "ENOENT", cause: { code: "ENOENT" } });
    expect((startupError as Error).message).toContain(process.execPath);
    expect((startupError as Error).message).toContain(cwd);
    expect((startupError as Error).message).not.toContain("XDG_CACHE_HOME");
  } finally {
    await worker.close();
  }
});
