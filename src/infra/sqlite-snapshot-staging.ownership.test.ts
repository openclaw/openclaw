import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as nodeSqlite from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  releaseSnapshotTempDirectory,
  removeTempDirectory,
  removeTempDirectoryAsync,
} from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { sqliteSnapshotStagingEntrypoints } from "./sqlite-snapshot-staging-runtime.test-support.js";
import {
  createSqliteSnapshotStagingDirectory,
  createSqliteSnapshotStagingDirectorySync,
  createSqliteSnapshotStagingTokenSync,
  reconcileSqliteSnapshotRetirement,
  reclaimAbandonedSqliteSnapshots,
  reclaimAbandonedSqliteSnapshotsAsync,
} from "./sqlite-snapshot-staging.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

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
const snapshotUrl = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.snapshot);
const nodeArguments = [
  ...resolveRuntimeWorkerArgv(snapshotUrl).slice(0, -1),
  "--input-type=module",
  "-e",
];
const snapshotModule = snapshotUrl.href;
const stagingModule = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.staging).href;
const loggerModule = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.logger).href;

beforeAll(async () => {
  // Prepare worker artifacts before measuring the reclamation operation.
  const root = tempDirs.make("sqlite-staging-warm-");
  removeTempDirectory(await createSqliteSnapshotStagingDirectory(root));
});

it("shares one token process across concurrent and nested async snapshot lifetimes", async () => {
  const root = tempDirs.make("sqlite-staging-async-owner-");
  const cache = path.join(root, "cache");
  const processRecord = path.join(root, "token-processes");
  fs.mkdirSync(cache);
  // The token child now launches inside its native owner, beyond the host's spawn binding.
  const preloadPath = path.join(root, "token-preload.cjs");
  const preload = `
    const { appendFileSync } = require("node:fs");
    const { isMainThread } = require("node:worker_threads");
    if (isMainThread && process.argv[2] === ${JSON.stringify(SQLITE_READONLY_CHILD_ARG)} && process.argv[3] === "session") {
      appendFileSync(${JSON.stringify(processRecord)}, String(process.pid) + String.fromCharCode(10));
    }
  `;
  fs.writeFileSync(preloadPath, preload);
  await withEnvAsync(sqliteWorkerPreloadEnv(preloadPath), async () => {
    const nativeOpen = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation(() => {
      throw new Error("snapshot token opened on the host");
    });
    const directories: string[] = [];
    const allocations = Array.from({ length: 3 }, async () => {
      const directory = await createSqliteSnapshotStagingDirectory(cache, false, undefined, true);
      directories.push(directory);
      return directory;
    });
    let tokenPid: number;
    try {
      await Promise.all(allocations);
      await expect(
        createSqliteSnapshotStagingDirectory(path.join(cache, "missing"), false, undefined, true),
      ).rejects.toThrow("snapshot staging root");
      const nested = await createSqliteSnapshotStagingDirectory(
        directories[0],
        false,
        undefined,
        true,
      );
      directories.push(nested);
      expect(new Set(directories).size).toBe(4);
      expect(directories.every((directory) => fs.existsSync(directory))).toBe(true);
      const processes = fs.readFileSync(processRecord, "utf8").trim().split("\n");
      expect(processes).toHaveLength(1);
      tokenPid = Number(processes[0]);
      expect(tokenPid).toBeGreaterThan(0);
      expect(isPidAlive(tokenPid)).toBe(true);
    } finally {
      try {
        // A rejected allocation must not discard successful siblings' cleanup custody.
        await Promise.allSettled(allocations);
        for (const directory of directories.toReversed()) {
          expect.soft(await removeTempDirectoryAsync(directory), directory).toBe(true);
        }
      } finally {
        nativeOpen.mockRestore();
      }
    }
    expect(fs.readdirSync(cache)).toEqual([]);
    expect(isPidAlive(tokenPid)).toBe(false);
  });
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
    // Reconciliation owns payload cleanup after the staging worker has exited.
    expect(fs.existsSync(location)).toBe(false);
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
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('owner is outside this PID namespace'), { code: 'ESRCH' });
      return kill(pid, signal);
    };
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

it("reclaims one oversized abandoned snapshot per pass without starving the next pass", () => {
  const { cache } = createFixture();
  const abandoned = Array.from({ length: 2 }, () => {
    const directory = createSqliteSnapshotStagingDirectorySync(cache);
    const payload = path.join(directory, "database.sqlite");
    fs.closeSync(fs.openSync(payload, "w", 0o600));
    fs.truncateSync(payload, 512 * 1024 * 1024 + 1);
    releaseSnapshotTempDirectory(directory);
    ageSnapshotTree(directory);
    return directory;
  });
  const reports: string[] = [];
  try {
    for (const _ of reclaimAbandonedSqliteSnapshots(cache, (message) => {
      reports.push(message);
    })) {
      // Drain the bounded reclamation pass.
    }
    expect(abandoned.filter((directory) => fs.existsSync(directory))).toHaveLength(1);
    expect(reports).toContain(
      `Reclaimed ${512 * 1024 * 1024 + 1} bytes of interrupted SQLite snapshot data.`,
    );
    for (const _ of reclaimAbandonedSqliteSnapshots(cache, () => {})) {
      // A new pass must make progress on the remaining oversized directory.
    }
    expect(abandoned.some((directory) => fs.existsSync(directory))).toBe(false);
  } finally {
    for (const directory of abandoned) {
      removeTempDirectory(directory);
    }
  }
});

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
