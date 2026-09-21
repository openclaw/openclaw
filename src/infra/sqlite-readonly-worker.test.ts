import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import {
  resolveAggregateSqliteInspectionTimeoutMs,
  resolveSqliteInspectionBudget,
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
  withSqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import { acquireStateDatabaseHandleExclusion } from "./state-database-coordinator.js";

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

describe.each(["sync", "async", "scoped"] as const)("SQLite child compile cache (%s)", (mode) => {
  it.each([
    { label: "active programmatic cache", active: true, cache: undefined, disable: undefined },
    { label: "explicit cache", active: true, cache: "explicit", disable: undefined },
    { label: "empty explicit cache", active: true, cache: "", disable: undefined },
    { label: "disabled cache", active: true, cache: undefined, disable: "1" },
    { label: "empty disable policy", active: true, cache: undefined, disable: "" },
    { label: "unavailable cache", active: false, cache: undefined, disable: undefined },
  ] as const)("preserves $label through the real worker", async (testCase) => {
    const root = tempDirs.make("openclaw-sqlite-child-cache-");
    const script = path.join(root, "parent.mjs");
    const ownerUrl = pathToFileURL(path.resolve("src/entry.compile-cache.ts")).href;
    const snapshotUrl = pathToFileURL(path.resolve("src/infra/sqlite-snapshot-source.ts")).href;
    const workerUrl = pathToFileURL(path.resolve("src/infra/sqlite-readonly-worker.ts")).href;
    fs.writeFileSync(
      script,
      `import assert from "node:assert/strict";
       import fs from "node:fs";
       import path from "node:path";
       import { pathToFileURL } from "node:url";
       import { getCompileCacheDir } from "node:module";
       import { DatabaseSync } from "node:sqlite";
       import { enableOpenClawCompileCache } from ${JSON.stringify(ownerUrl)};
       import { prepareSqliteReadOnlyLocation, prepareSqliteReadOnlyLocationSync } from ${JSON.stringify(snapshotUrl)};
       import { withSqliteReadOnlyWorkerScope } from ${JSON.stringify(workerUrl)};
       const root = ${JSON.stringify(root)};
       const mode = ${JSON.stringify(mode)};
       const testCase = ${JSON.stringify(testCase)};
       const installRoot = path.join(root, "installed");
       fs.mkdirSync(installRoot);
       fs.writeFileSync(path.join(installRoot, "package.json"), '{"version":"2026.9.6"}');
       assert.equal(getCompileCacheDir(), undefined);
       const beforeEnable = { ...process.env };
       if (testCase.active) enableOpenClawCompileCache({ installRoot });
       assert.deepEqual({ ...process.env }, beforeEnable);
       const activeDirectory = getCompileCacheDir();
       assert.equal(Boolean(activeDirectory), testCase.active);
       const explicitDirectory = path.join(root, "explicit");
       fs.mkdirSync(explicitDirectory);
       const inheritedCache = testCase.cache === "explicit" ? explicitDirectory : testCase.cache;
       if (inheritedCache !== undefined) process.env.NODE_COMPILE_CACHE = inheritedCache;
       if (testCase.disable !== undefined) process.env.NODE_DISABLE_COMPILE_CACHE = testCase.disable;
       const stagingRoot = path.join(root, "staging");
       fs.mkdirSync(stagingRoot);
       process.env.XDG_CACHE_HOME = stagingRoot;
       // Observe the native child before its real entrypoint, without replacing its transport.
       const probes = path.join(root, "probes");
       fs.mkdirSync(probes);
       const probe = path.join(root, "probe.mjs");
       fs.writeFileSync(probe, 'import fs from "node:fs"; import path from "node:path"; import { getCompileCacheDir } from "node:module"; fs.writeFileSync(path.join(' + JSON.stringify(probes) + ', process.pid + ".json"), JSON.stringify({ directory: getCompileCacheDir() ?? null, cache: process.env.NODE_COMPILE_CACHE ?? null, disable: process.env.NODE_DISABLE_COMPILE_CACHE ?? null }));');
       process.env.NODE_OPTIONS = "--import=" + pathToFileURL(probe).href;
       const callEnv = { ...process.env };
       const source = path.join(root, "source.sqlite");
       const database = new DatabaseSync(source);
       try {
         database.exec("CREATE TABLE padding (data BLOB)");
         database.prepare("INSERT INTO padding VALUES (zeroblob(?))").run(0);
       } finally { database.close(); }
       const before = fs.readFileSync(source);
       const prepared = mode === "sync"
         ? prepareSqliteReadOnlyLocationSync(source)
         : mode === "scoped"
           ? await withSqliteReadOnlyWorkerScope(() => prepareSqliteReadOnlyLocation(source, { preserveSourceArtifacts: true }))
           : await prepareSqliteReadOnlyLocation(source);
       try {
         if (mode === "sync") assert.deepEqual(fs.readFileSync(prepared.location), before);
         const snapshot = new DatabaseSync(prepared.location, { readOnly: true });
         try {
           assert.deepEqual(snapshot.prepare("SELECT data FROM padding").all().map(row => ({ ...row })), [{ data: new Uint8Array(0) }]);
           assert.equal(snapshot.prepare("SELECT sql FROM sqlite_schema WHERE name = 'padding'").get().sql, "CREATE TABLE padding (data BLOB)");
           assert.equal(snapshot.prepare("PRAGMA user_version").get().user_version, 0);
           assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
         } finally { snapshot.close(); }
       } finally { assert.equal(await prepared.cleanupAsync(), true); }
       assert.equal(fs.existsSync(prepared.location), false);
       assert.deepEqual(fs.readFileSync(source), before);
       assert.deepEqual(fs.readdirSync(path.join(stagingRoot, "openclaw")), []);
       assert.deepEqual({ ...process.env }, callEnv);
       const observed = fs.readdirSync(probes).map(name => JSON.parse(fs.readFileSync(path.join(probes, name), "utf8")));
       assert.ok(observed.length > 0, "real read-only children must execute");
       for (const child of observed) {
         assert.equal(child.disable, testCase.disable ?? null);
         if (testCase.active && inheritedCache === undefined && testCase.disable === undefined) {
           assert.equal(child.directory, activeDirectory, "readonly parent/child native directory must match exactly");
         } else if (testCase.cache === "explicit") {
           assert.equal(child.cache, explicitDirectory);
           assert.ok(child.directory);
         } else { assert.equal(child.directory, null); }
       }
       const hasCacheFiles = directory => Boolean(directory) && fs.readdirSync(directory, { recursive: true, withFileTypes: true }).some(entry => entry.isFile());
       assert.equal(hasCacheFiles(activeDirectory), testCase.active && inheritedCache === undefined && testCase.disable === undefined);
       assert.equal(hasCacheFiles(explicitDirectory), testCase.cache === "explicit");
       process.stdout.write("readonly-cache:verified");`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      TMP: root,
      TEMP: root,
      TMPDIR: root,
    };
    delete env.NODE_COMPILE_CACHE;
    delete env.NODE_DISABLE_COMPILE_CACHE;
    delete env.NODE_OPTIONS;
    const result = await runNodeScript(
      ["--import", import.meta.resolve("tsx"), script],
      env,
      10_000,
      { requireProcessTreeExit: process.platform !== "win32", maxBuffer: 1024 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("readonly-cache:verified");
  });
});
async function readRawSnapshotVersion(source: string) {
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
    "joins an IPC send %s failure before admitting another request",
    async (failureMode) => {
      const source = createDatabase(0);
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
      await withSqliteReadOnlyWorkerScope(async () => {
        await expect(readRawSnapshotVersion(source)).rejects.toBe(failure);
        expect(vi.mocked(spawn).mock.results[0]?.value.signalCode).toBe("SIGKILL");
        expect(await readRawSnapshotVersion(source)).toBe(0);
      });
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
            expect(await readRawSnapshotVersion(source)).toBe(index + 1);
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
      expect(
        await Promise.all([readRawSnapshotVersion(source), readRawSnapshotVersion(source)]),
      ).toEqual([0, 0]);
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawn).mock.results[0]?.value.pid).not.toBe(
      vi.mocked(execFile).mock.results[0]?.value.pid,
    );
  });

  it("replaces the child when its launch environment changes", async () => {
    const source = createDatabase(0);
    await withSqliteReadOnlyWorkerScope(async () => {
      await readRawSnapshotVersion(source);
      await withEnvAsync(
        { XDG_CACHE_HOME: tempDirs.make("openclaw-scoped-environment-") },
        async () => {
          expect(await readRawSnapshotVersion(source)).toBe(0);
          expect(vi.mocked(spawn).mock.results[0]?.value.exitCode).toBe(0);
        },
      );
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("releases admission between requests and reacquires it against the current exclusion", async () => {
    const source = createDatabase(0);
    await withSqliteReadOnlyWorkerScope(async () => {
      await readRawSnapshotVersion(source);
      const exclusion = acquireStateDatabaseHandleExclusion({
        databasePath: source,
        busyTimeoutMs: 0,
      });
      try {
        await expect(readRawSnapshotVersion(source)).rejects.toThrow("state-handles");
      } finally {
        exclusion.release();
      }
      expect(await readRawSnapshotVersion(source)).toBe(0);
    });
    expect(spawn).toHaveBeenCalledTimes(2);
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

describe("resolveSqliteInspectionBudget", () => {
  it.each(
    [
      { label: "0 B", sizeBytes: 0, expected: 300_000 },
      { label: "1 B", sizeBytes: 1, expected: 301_000 },
      { label: "32 MiB", sizeBytes: 32 * 1024 * 1024, expected: 340_000 },
      { label: "32 MiB + 1 B", sizeBytes: 32 * 1024 * 1024 + 1, expected: 341_000 },
      { label: "300 MiB", sizeBytes: 300 * 1024 * 1024, expected: 675_000 },
      { label: "2 GiB", sizeBytes: 2 * 1024 ** 3, expected: 2_860_000 },
      { label: "9.4 GiB", sizeBytes: Math.floor(9.4 * 1024 ** 3), expected: 12_332_000 },
      { label: "64 GiB", sizeBytes: 64 * 1024 ** 3, expected: 82_220_000 },
      {
        label: "huge file (Node timer limit)",
        sizeBytes: Number.MAX_SAFE_INTEGER,
        expected: MAX_TIMER_TIMEOUT_MS,
      },
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

it("includes WAL, SHM, and rollback-journal sidecars in inspection size", () => {
  const source = path.join(tempDirs.make("openclaw-snapshot-size-"), "source.sqlite");
  fs.writeFileSync(source, "");
  fs.writeFileSync(`${source}-wal`, "");
  fs.writeFileSync(`${source}-shm`, "");
  fs.writeFileSync(`${source}-journal`, "");
  fs.truncateSync(source, 64 * 1024 * 1024);
  fs.truncateSync(`${source}-wal`, 3_489_660_928);
  fs.truncateSync(`${source}-shm`, 32 * 1024 * 1024);
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
    timeout: 4_581_000,
    killSignal: "SIGKILL",
  });
  expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).toContain("sync");
});

it("selects bounded online fallback for opted-in synchronous snapshots", () => {
  const source = createDatabase(0);
  const stagingRoot = tempDirs.make("openclaw-snapshot-fallback-staging-");
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 1,
    output: [null, '{"ok":true,"location":"private.sqlite"}', ""],
    stdout: '{"ok":true,"location":"private.sqlite"}',
    stderr: "",
    status: 0,
    signal: null,
  });

  expect(runSqliteReadOnlyWorkerSync(source, stagingRoot, "sync-fallback")).toBe("private.sqlite");
  expect(vi.mocked(spawnSync).mock.calls[0]?.[1]).toContain("sync-fallback");
});

it("uses online backup instead of raw WAL copying for synchronous fallback", () => {
  const source = createDatabase(0);
  const writer = new (requireNodeSqlite().DatabaseSync)(source);
  const stagingRoot = tempDirs.make("openclaw-snapshot-fallback-live-");
  try {
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE live(value TEXT); INSERT INTO live VALUES ('committed');",
    );
    const location = runSqliteReadOnlyWorkerSync(source, stagingRoot, "sync-fallback");
    const snapshot = new (requireNodeSqlite().DatabaseSync)(location, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT value FROM live").get()).toEqual({ value: "committed" });
      expect(fs.existsSync(`${location}-wal`)).toBe(false);
      expect(fs.existsSync(`${location}-shm`)).toBe(false);
    } finally {
      snapshot.close();
    }
  } finally {
    writer.close();
  }
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
    { label: "empty", paddingBytes: null, timeout: 300_000 },
    { label: "small", paddingBytes: 0, timeout: 301_000 },
    { label: "over 32 MiB", paddingBytes: 32 * 1024 * 1024, timeout: 341_000 },
  ])("snapshots a $label database with its size budget", async ({ paddingBytes, timeout }) => {
    const source = createDatabase(paddingBytes);
    if (paddingBytes) {
      expect(fs.statSync(source).size).toBeGreaterThan(32 * 1024 * 1024);
      expect(fs.statSync(source).size).toBeLessThan(64 * 1024 * 1024);
    }
    const snapshot = await run(source);
    expect(fs.existsSync(snapshot)).toBe(true);
    expectBudget(timeout);
    if (timeout > 300_000) {
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

  it.each([
    { label: "empty", paddingBytes: null, seconds: 300, size: "0 B" },
    { label: "over 32 MiB", paddingBytes: 32 * 1024 * 1024, seconds: 341, size: "32.0 MiB" },
    { label: "missing", paddingBytes: null, seconds: 300, size: "unknown size" },
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
    expectBudget(300_000);
    expect(logs.debug).not.toHaveBeenCalled();
  });
});
