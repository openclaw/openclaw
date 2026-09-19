import { spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import * as nodeSqlite from "./node-sqlite.js";
import {
  releaseSnapshotTempDirectory,
  removeTempDirectory,
  removeTempDirectoryAsync,
} from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import {
  createSqliteSnapshotStagingDirectory,
  createSqliteSnapshotStagingDirectorySync,
  createSqliteSnapshotStagingTokenSync,
  reconcileSqliteSnapshotRetirement,
  reclaimAbandonedSqliteSnapshots,
  reclaimAbandonedSqliteSnapshotsAsync,
} from "./sqlite-snapshot-staging.js";

vi.mock("node:child_process", { spy: true });

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await testApi.flushFileLogQueueForTests();
    } finally {
      setLoggerOverride(null);
      cleanup();
    }
  });
});
const nodeArguments = ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e"];
const snapshotModule = new URL("./sqlite-readonly-location.ts", import.meta.url).href;
const stagingModule = new URL("./sqlite-snapshot-staging.ts", import.meta.url).href;
const loggerModule = new URL("../logging/logger.ts", import.meta.url).href;

beforeAll(async () => {
  // Prepare worker artifacts before measuring the reclamation operation.
  const root = tempDirs.make("sqlite-staging-warm-");
  removeTempDirectory(await createSqliteSnapshotStagingDirectory(root));
});

it("shares one token process across concurrent and nested async snapshot lifetimes", async () => {
  const cache = tempDirs.make("sqlite-staging-async-owner-");
  const started = performance.now();
  const children = vi.spyOn(childProcess, "spawn");
  const nativeOpen = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation(() => {
    throw new Error("snapshot token opened on the host");
  });
  const directories: string[] = [];
  try {
    directories.push(
      ...(await Promise.all(
        Array.from({ length: 3 }, () =>
          createSqliteSnapshotStagingDirectory(cache, false, undefined, true),
        ),
      )),
    );
    await expect(
      createSqliteSnapshotStagingDirectory(path.join(cache, "missing"), false, undefined, true),
    ).rejects.toThrow();
    expect(directories.every((directory) => fs.existsSync(directory))).toBe(true);
    const nested = await createSqliteSnapshotStagingDirectory(
      directories[0],
      false,
      undefined,
      true,
    );
    directories.push(nested);
    const sessions = children.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("session"),
    );
    expect(sessions).toHaveLength(1);
    console.info("async snapshot token owner", {
      directories: directories.length,
      tokenProcesses: sessions.length,
      elapsedMs: Math.round(performance.now() - started),
    });
  } finally {
    try {
      for (const directory of directories.toReversed()) {
        expect(await removeTempDirectoryAsync(directory)).toBe(true);
      }
    } finally {
      nativeOpen.mockRestore();
    }
  }
  expect(fs.readdirSync(cache)).toEqual([]);
});

function createFixture() {
  const root = tempDirs.make("sqlite-staging-ownership-");
  const cache = path.join(root, "cache");
  const source = path.join(root, "source.sqlite");
  fs.mkdirSync(cache);
  const database = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(source);
  database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');");
  database.close();
  return { root, cache, source };
}

function assertReadable(location: string) {
  const database = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(location, { readOnly: true });
  try {
    expect(database.prepare("SELECT value FROM probe").get()).toEqual({ value: "preserved" });
  } finally {
    database.close();
  }
}

function ageSnapshotTree(directory: string, ageMs = 25 * 60 * 60 * 1000): void {
  const stale = new Date(Date.now() - ageMs);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      ageSnapshotTree(location, ageMs);
    } else {
      fs.utimesSync(location, stale, stale);
    }
  }
  fs.utimesSync(directory, stale, stale);
}

function runChild(script: string, signal?: NodeJS.Signals) {
  const result = spawnSync(process.execPath, [...nodeArguments, script], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(signal ? null : 0);
  if (signal) {
    expect(result.signal, result.stderr).toBe(signal);
  }
  return result.stdout;
}

it("reconciles a released fresh token without waiting for idle reclamation", () => {
  const { cache, source } = createFixture();
  const owned = createSqliteSnapshotStagingTokenSync(cache);
  const location = path.join(owned.directory, "database.sqlite");
  fs.copyFileSync(source, location);
  owned.release();
  try {
    reconcileSqliteSnapshotRetirement(owned.directory);
    expect(() =>
      openOpenClawStateReadConnection(source, location, undefined, owned.directory),
    ).toThrow("parent retired");
    expect(fs.readFileSync(location)).toEqual(fs.readFileSync(source));
  } finally {
    owned.release();
    removeTempDirectory(owned.directory);
  }
});

it("keeps snapshot bytes fenced after creator release until native reader close succeeds", () => {
  const { cache, source } = createFixture();
  const directory = createSqliteSnapshotStagingDirectorySync(cache);
  const location = path.join(directory, "database.sqlite");
  fs.copyFileSync(source, location);
  const reader = openOpenClawStateReadConnection(source, location, undefined, directory);
  const close = vi.spyOn(reader.database.db, "close").mockImplementationOnce(() => {
    throw new Error("reader close did not finish");
  });
  const reclaim = () =>
    runChild(`
    import { reclaimAbandonedSqliteSnapshots } from ${JSON.stringify(stagingModule)};
    for (const ignored of reclaimAbandonedSqliteSnapshots(${JSON.stringify(cache)}, () => {})) {}
  `);
  try {
    releaseSnapshotTempDirectory(directory);
    ageSnapshotTree(directory);
    expect(() => reader.close()).toThrow("reader close did not finish");
    expect(() => reconcileSqliteSnapshotRetirement(directory)).toThrow();
    reclaim();
    expect(fs.existsSync(location)).toBe(true);
    close.mockRestore();
    expect(reader.close()).toBe(true);
    reconcileSqliteSnapshotRetirement(directory);
    ageSnapshotTree(directory);
    reclaim();
    expect(fs.existsSync(directory)).toBe(false);
  } finally {
    close.mockRestore();
    reader.close();
    removeTempDirectory(directory);
  }
});

it("refuses a private reader admitted after snapshot retirement", () => {
  const { cache, source } = createFixture();
  const owned = createSqliteSnapshotStagingTokenSync(cache);
  const location = path.join(owned.directory, "database.sqlite");
  fs.copyFileSync(source, location);
  try {
    owned.release(true);
    expect(() =>
      openOpenClawStateReadConnection(source, location, undefined, owned.directory),
    ).toThrow("parent retired");
  } finally {
    owned.release();
    removeTempDirectory(owned.directory);
  }
});

it("releases snapshot transactions before deferred native close can block parent retirement", () => {
  const cache = tempDirs.make("sqlite-staging-deferred-close-");
  const open = nodeSqlite.openNodeSqliteDatabase;
  const closeHandles: (() => void)[] = [];
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    const close = database.close.bind(database);
    closeHandles.push(() => {
      if (database.isOpen) {
        close();
      }
    });
    // Bun's close_v2 leaves transactions locked while statements await GC.
    vi.spyOn(database, "close").mockImplementation(() => {
      if (!database.isTransaction) {
        close();
      }
    });
    return database;
  });
  try {
    const parent = createSqliteSnapshotStagingDirectorySync(cache);
    const child = createSqliteSnapshotStagingDirectorySync(parent);
    fs.writeFileSync(path.join(child, "database.sqlite"), "private snapshot");
    releaseSnapshotTempDirectory(child);
    const failures: unknown[] = [];
    expect(removeTempDirectory(parent, (error) => failures.push(error))).toBe(true);
    expect(failures).toEqual([]);
    expect(fs.existsSync(parent)).toBe(false);
  } finally {
    for (const close of closeHandles.toReversed()) {
      close();
    }
  }
});

it("keeps timers responsive while async allocation reclaims a legacy backlog", async () => {
  const { root, cache } = createFixture();
  setLoggerOverride({ level: "silent", file: path.join(root, "cleanup.log") });
  const payload = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < 429; index++) {
    const directory = path.join(
      cache,
      `openclaw-sqlite-readonly-12345-${index.toString(36).padStart(6, "0")}`,
    );
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "database.sqlite"), payload);
    ageSnapshotTree(directory);
  }

  let previous = performance.now();
  let longestGapMs = 0;
  const measure = () => {
    const now = performance.now();
    longestGapMs = Math.max(longestGapMs, now - previous);
    previous = now;
  };
  const timer = setInterval(measure, 1);
  try {
    await reclaimAbandonedSqliteSnapshotsAsync(cache);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        measure();
        resolve();
      }, 0);
    });
  } finally {
    clearInterval(timer);
  }
  console.log(JSON.stringify({ backlogDirectories: 429, longestGapMs }));
  expect(longestGapMs).toBeLessThan(100);
  expect(fs.readdirSync(cache)).toEqual([]);
});

it("reclaims released-worker cache layouts only after 24 hours", async () => {
  for (const fresh of [false, true]) {
    const { root, cache, source } = createFixture();
    const parent = path.join(cache, "openclaw-sqlite-readonly-12345-Parent");
    const inner = path.join(parent, "openclaw", "openclaw-sqlite-readonly-12345-Worker");
    const copy = path.join(inner, "database.sqlite");
    fs.mkdirSync(inner, { recursive: true });
    fs.copyFileSync(source, copy);
    ageSnapshotTree(parent);
    if (fresh) {
      const now = new Date();
      fs.utimesSync(copy, now, now);
    }
    const log = path.join(root, "cleanup.log");
    setLoggerOverride({ level: "warn", file: log });
    await reclaimAbandonedSqliteSnapshotsAsync(cache);
    expect(fs.existsSync(parent)).toBe(fresh);
    await testApi.flushFileLogQueueForTests();
    if (fresh) {
      assertReadable(copy);
      expect(fs.existsSync(path.join(parent, "owner.sqlite"))).toBe(false);
      expect(fs.existsSync(path.join(inner, "owner.sqlite"))).toBe(false);
      expect(fs.readFileSync(log, "utf8")).toContain("Skipped SQLite snapshot reclamation");
    } else {
      expect(fs.readFileSync(log, "utf8")).toContain(`Reclaimed ${fs.statSync(source).size} bytes`);
    }
  }
});

it.each(["sync", "async"] as const)(
  "revisits expired current snapshots in the same %s owner",
  async (mode) => {
    const { cache } = createFixture();
    const abandoned = createSqliteSnapshotStagingDirectorySync(cache);
    fs.writeFileSync(path.join(abandoned, "database.sqlite"), "recent private snapshot");
    releaseSnapshotTempDirectory(abandoned);

    const allocated = createSqliteSnapshotStagingDirectorySync(cache);
    try {
      const reclaim = async () => {
        if (mode === "async") {
          await reclaimAbandonedSqliteSnapshotsAsync(cache);
        } else {
          for (const _ of reclaimAbandonedSqliteSnapshots(cache)) {
            // Exercise cleanup independently of allocation.
          }
        }
      };
      await reclaim();
      expect(fs.existsSync(abandoned)).toBe(true);
      ageSnapshotTree(abandoned, 30 * 60 * 1000);
      await reclaim();
      expect(fs.existsSync(abandoned)).toBe(false);
      expect(fs.existsSync(allocated)).toBe(true);
    } finally {
      removeTempDirectory(allocated);
      removeTempDirectory(abandoned);
    }
  },
);

it("stops reclamation before exceeding its copied-byte budget", () => {
  const { cache } = createFixture();
  const abandoned = createSqliteSnapshotStagingDirectorySync(cache);
  const payload = path.join(abandoned, "database.sqlite");
  fs.closeSync(fs.openSync(payload, "w", 0o600));
  fs.truncateSync(payload, 512 * 1024 * 1024 + 1);
  releaseSnapshotTempDirectory(abandoned);
  ageSnapshotTree(abandoned);
  const reports: Array<{ error?: unknown; message: string }> = [];
  try {
    for (const _ of reclaimAbandonedSqliteSnapshots(cache, (message, error) => {
      reports.push({ message, error });
    })) {
      // Drain the bounded reclamation pass.
    }
    expect(fs.existsSync(payload)).toBe(true);
    expect(fs.statSync(payload).size).toBe(512 * 1024 * 1024 + 1);
    expect(reports).toEqual([
      {
        message: "Skipped SQLite snapshot reclamation: owner live, recent, or unverified.",
        error: expect.objectContaining({
          message: "Snapshot reclamation byte budget exhausted",
        }),
      },
    ]);
  } finally {
    removeTempDirectory(abandoned);
  }
});

it("preserves a live snapshot when its owner PID is invisible", () => {
  const { root, cache, source } = createFixture();
  const held = prepareSqliteReadOnlyLocationSyncInProcess(source, cache);
  try {
    runChild(`
      import { prepareSqliteReadOnlyLocationSyncInProcess } from ${JSON.stringify(snapshotModule)};
      import { reclaimAbandonedSqliteSnapshots } from ${JSON.stringify(stagingModule)};
      import { setLoggerOverride } from ${JSON.stringify(loggerModule)};
      setLoggerOverride({ level: 'silent', file: ${JSON.stringify(path.join(root, "child.log"))} });
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (signal === 0) throw Object.assign(new Error('owner is outside this PID namespace'), { code: 'ESRCH' });
        return kill(pid, signal);
      };
      for (const _ of reclaimAbandonedSqliteSnapshots(${JSON.stringify(cache)})) {}

    `);
    expect(fs.existsSync(held.location)).toBe(true);
    assertReadable(held.location);
  } finally {
    held.cleanup();
  }
});

it.skipIf(process.platform === "win32")(
  "arbitrates an orphan worker allocating after reclamation inspects its parent",
  () => {
    for (const { legacyParent, cacheContainer } of [
      { legacyParent: false, cacheContainer: false },
      { legacyParent: true, cacheContainer: false },
      { legacyParent: false, cacheContainer: true },
      { legacyParent: true, cacheContainer: true },
    ]) {
      for (const stage of ["inspection", "retirement"] as const) {
        const { root, cache, source } = createFixture();
        const resultFile = path.join(root, "worker-result.json");
        const childPrelude = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { prepareSqliteReadOnlyLocationSyncInProcess } from ${JSON.stringify(snapshotModule)};
      import { createSqliteSnapshotStagingDirectorySync, reclaimAbandonedSqliteSnapshots } from ${JSON.stringify(stagingModule)};
      import { setLoggerOverride } from ${JSON.stringify(loggerModule)};
      setLoggerOverride({ level: 'silent', file: ${JSON.stringify(path.join(root, "child.log"))} });
    `;
        const parentScript = `${childPrelude}
      let directory;
      if (${JSON.stringify(legacyParent)}) {
        directory = path.join(${JSON.stringify(cache)}, 'openclaw-sqlite-readonly-' + process.pid + '-Legacy');
        fs.mkdirSync(directory);
      } else {
        directory = createSqliteSnapshotStagingDirectorySync(${JSON.stringify(cache)});
      }
      if (${JSON.stringify(cacheContainer)}) fs.mkdirSync(path.join(directory, 'openclaw'));
      if (${JSON.stringify(legacyParent)}) {
        const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
        if (${JSON.stringify(cacheContainer)}) fs.utimesSync(path.join(directory, 'openclaw'), stale, stale);
        fs.utimesSync(directory, stale, stale);
      }
      process.send(directory);
      process.on('message', () => {});
    `;
        const workerScript = `${childPrelude}
      process.on('message', (parent) => {
        let prepared;
        let result;
        try {
          prepared = prepareSqliteReadOnlyLocationSyncInProcess(${JSON.stringify(source)}, parent);
          result = { location: prepared.location };
        } catch (error) {
          result = { error: error.message, code: error.code, causeCode: error.cause?.code };
        }
        fs.writeFileSync(${JSON.stringify(`${resultFile}.partial`)}, JSON.stringify(result));
        fs.renameSync(${JSON.stringify(`${resultFile}.partial`)}, ${JSON.stringify(resultFile)});
        process.removeAllListeners('message');
        process.once('message', () => { prepared?.cleanup(); process.disconnect(); });
      });
      process.send('ready');
    `;
        const output = runChild(`${childPrelude}
      import { spawn } from 'node:child_process';
      import { once } from 'node:events';
      const launch = (script) => spawn(process.execPath, [...${JSON.stringify(nodeArguments)}, script], {
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const parent = launch(${JSON.stringify(parentScript)});
      const [directory] = await once(parent, 'message');
      const worker = launch(${JSON.stringify(workerScript)});
      const workerClosed = once(worker, 'close');
      const parentClosed = once(parent, 'close');
      let inspected = false;
      let outcome;
      try {
        await once(worker, 'message');
        parent.kill('SIGKILL');
        await parentClosed;
        const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
        if (fs.existsSync(path.join(directory, 'openclaw'))) fs.utimesSync(path.join(directory, 'openclaw'), stale, stale);
        fs.utimesSync(directory, stale, stale);
        const readDirectory = fs.readdirSync;
        const rename = fs.renameSync;
        const startWorker = (pathname) => {
          if (String(pathname) === directory && !inspected) {
            inspected = true;
            worker.send(${JSON.stringify(cacheContainer)} ? path.join(directory, 'openclaw') : directory);
            const deadline = Date.now() + 10_000;
            const barrier = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(${JSON.stringify(resultFile)})) {
              if (Date.now() > deadline) throw new Error('worker did not reach allocation barrier');
              Atomics.wait(barrier, 0, 0, 10);
            }
            outcome = JSON.parse(fs.readFileSync(${JSON.stringify(resultFile)}, 'utf8'));
          }
        };
        fs.readdirSync = (...args) => {
          const entries = readDirectory(...args);
          if (${JSON.stringify(stage)} === 'inspection') startWorker(args[0]);
          return entries;
        };
        fs.renameSync = (...args) => {
          if (${JSON.stringify(stage)} === 'retirement') startWorker(args[0]);
          return rename(...args);
        };
        for (const _ of reclaimAbandonedSqliteSnapshots(${JSON.stringify(cache)})) {}
        fs.readdirSync = readDirectory;
        fs.renameSync = rename;

        process.stdout.write(JSON.stringify({
          inspected, outcome,
          workerAlive: worker.exitCode === null && worker.signalCode === null,
          copyExists: outcome?.location ? fs.existsSync(outcome.location) : false,
        }));
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
        if (worker.connected && outcome) worker.send('finish');
        else worker.kill('SIGKILL');
        await Promise.all([parentClosed, workerClosed]);
      }
    `);
        const result = JSON.parse(output) as {
          inspected: boolean;
          workerAlive: boolean;
          copyExists: boolean;
          outcome: { location?: string; error?: string; code?: string; causeCode?: string };
        };
        const context = `${stage}, legacy parent: ${legacyParent}, cache container: ${cacheContainer}`;
        expect(result.inspected, context).toBe(true);
        expect(result.workerAlive, context).toBe(true);
        expect(result.copyExists, context).toBe(result.outcome.location !== undefined);
        if (!result.outcome.location) {
          expect(result.outcome.error, context).toContain(
            stage === "inspection" ? "database is locked" : "parent retired",
          );
        }
      }
    }
  },
);

it("reclaims only legacy snapshots older than 24 hours", async () => {
  const { root, cache } = createFixture();
  const old = path.join(cache, "openclaw-sqlite-readonly-12345-Older1");
  const young = path.join(cache, "openclaw-sqlite-readonly-12345-Young1");
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const oldBytes = Buffer.from("legacy interrupted snapshot");
  for (const directory of [old, young]) {
    fs.mkdirSync(directory);
  }
  fs.writeFileSync(path.join(old, "database.sqlite"), oldBytes);
  fs.utimesSync(path.join(old, "database.sqlite"), stale, stale);
  fs.utimesSync(old, stale, stale);
  fs.writeFileSync(path.join(young, "first"), "recently active legacy copy");
  const recent = new Date(Date.now() - 23 * 60 * 60 * 1000);
  fs.utimesSync(path.join(young, "first"), recent, recent);
  // A stale root does not authorize removing or refreshing a recent descendant.
  fs.utimesSync(young, stale, stale);
  const youngDirectoryMtime = fs.statSync(young).mtimeMs;
  const log = path.join(root, "cleanup.log");
  setLoggerOverride({ level: "warn", file: log });
  const kill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === 0) {
      throw Object.assign(new Error("owner is outside this PID namespace"), { code: "ESRCH" });
    }
    return kill(pid, signal);
  });
  await reclaimAbandonedSqliteSnapshotsAsync(cache);
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.readFileSync(path.join(young, "first"), "utf8")).toBe("recently active legacy copy");
  expect(fs.statSync(young).mtimeMs).toBe(youngDirectoryMtime);
  expect(fs.existsSync(path.join(young, "owner.sqlite"))).toBe(false);
  await testApi.flushFileLogQueueForTests();
  expect(fs.readFileSync(log, "utf8")).toContain(`Reclaimed ${oldBytes.length} bytes`);
});

it.skipIf(process.platform === "win32")(
  "reclaims abandoned mixed-generation snapshots while preserving live or recent children",
  async () => {
    for (const fixture of [
      { legacyParent: true, childAgeHours: 25 },
      { legacyParent: false, childAgeHours: 25 },
      { legacyParent: false, childAgeHours: 0 },
      { legacyParent: false, childAgeHours: 1 },
      { legacyParent: false, childAgeHours: 23 },
    ]) {
      const { root, cache, source } = createFixture();
      const output = runChild(
        `
        import fs from 'node:fs';
        import path from 'node:path';
        import { prepareSqliteReadOnlyLocationSyncInProcess } from ${JSON.stringify(snapshotModule)};
        import { createSqliteSnapshotStagingDirectorySync } from ${JSON.stringify(stagingModule)};
        let outer;
        let location;
        if (${JSON.stringify(fixture.legacyParent)}) {
          outer = path.join(${JSON.stringify(cache)}, 'openclaw-sqlite-readonly-' + process.pid + '-Legacy');
          fs.mkdirSync(outer);
          location = prepareSqliteReadOnlyLocationSyncInProcess(${JSON.stringify(source)}, outer).location;
        } else {
          outer = createSqliteSnapshotStagingDirectorySync(${JSON.stringify(cache)});
          const child = path.join(outer, 'openclaw-sqlite-readonly-' + process.pid + '-Legacy');
          fs.mkdirSync(child);
          location = path.join(child, 'database.sqlite');
          fs.copyFileSync(${JSON.stringify(source)}, location);
        }
        process.stdout.write(JSON.stringify({ outer, location }));
        process.kill(process.pid, 'SIGKILL');
        `,
        "SIGKILL",
      );
      const { outer, location } = JSON.parse(output) as { outer: string; location: string };
      ageSnapshotTree(outer);
      const childTime = new Date(Date.now() - fixture.childAgeHours * 60 * 60 * 1000);
      fs.utimesSync(location, childTime, childTime);
      const recentChild = fixture.childAgeHours < 24;
      const log = path.join(root, "cleanup.log");
      setLoggerOverride({ level: "warn", file: log });
      await reclaimAbandonedSqliteSnapshotsAsync(cache);
      expect(fs.existsSync(outer), JSON.stringify(fixture)).toBe(recentChild);
      await testApi.flushFileLogQueueForTests();
      if (recentChild) {
        assertReadable(location);
        expect(fs.readFileSync(log, "utf8")).toContain("Skipped SQLite snapshot reclamation");
      } else {
        expect(fs.readFileSync(log, "utf8")).toContain(
          `Reclaimed ${fs.statSync(source).size} bytes`,
        );
      }
    }

    const { root, cache, source } = createFixture();
    const outer = path.join(cache, "openclaw-sqlite-readonly-12345-Legacy");
    fs.mkdirSync(outer);
    const held = prepareSqliteReadOnlyLocationSyncInProcess(source, outer);
    ageSnapshotTree(outer);
    try {
      runChild(`
        import { reclaimAbandonedSqliteSnapshots } from ${JSON.stringify(stagingModule)};

        import { setLoggerOverride } from ${JSON.stringify(loggerModule)};
        setLoggerOverride({ level: 'silent', file: ${JSON.stringify(path.join(root, "child.log"))} });
        for (const _ of reclaimAbandonedSqliteSnapshots(${JSON.stringify(cache)})) {}

      `);
      assertReadable(held.location);
    } finally {
      held.cleanup();
    }
  },
);
