import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { openOpenClawStateReadConnection } from "../state/openclaw-state-db-read-connection.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as nodeSqlite from "./node-sqlite.js";
import { SQLITE_READONLY_CHILD_ARG } from "./runtime-process-entrypoints.js";
import {
  releaseSnapshotTempDirectory,
  removeTempDirectory,
  removeTempDirectoryAsync,
} from "./sqlite-readonly-location-cleanup.js";
import {
  createSqliteSnapshotStagingDirectory,
  createSqliteSnapshotStagingDirectorySync,
  createSqliteSnapshotStagingTokenSync,
  reconcileSqliteSnapshotRetirement,
} from "./sqlite-snapshot-staging.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    cleanup();
  });
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
    using nativeOpen = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation(() => {
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
      // A rejected allocation must not discard successful siblings' cleanup custody.
      await Promise.allSettled(allocations);
      for (const directory of directories.toReversed()) {
        expect.soft(await removeTempDirectoryAsync(directory), directory).toBe(true);
      }
    }
    expect(fs.readdirSync(cache)).toEqual([]);
    expect(isPidAlive(tokenPid)).toBe(false);
    expect(nativeOpen).not.toHaveBeenCalled();
  });
});

function createFixture() {
  const root = tempDirs.make("sqlite-staging-ownership-");
  const cache = path.join(root, "cache");
  const source = path.join(root, "source.sqlite");
  fs.mkdirSync(cache);
  using database = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(source);
  database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');");
  return { root, cache, source };
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
  try {
    releaseSnapshotTempDirectory(directory);
    expect(() => reader.close()).toThrow("reader close did not finish");
    expect(() => reconcileSqliteSnapshotRetirement(directory)).toThrow();
    expect(fs.existsSync(location)).toBe(true);
    close.mockRestore();
    expect(reader.close()).toBe(true);
    reconcileSqliteSnapshotRetirement(directory);
    expect(removeTempDirectory(directory)).toBe(true);
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
