import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";
import {
  captureSqliteDatabaseAdmissions,
  hasSqliteDatabaseSchemaAdmissionForPath,
} from "./sqlite-database-admission.js";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  removeTempDirectoryAsync,
  retainSnapshotTempDirectory,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import {
  prepareSqliteReadOnlyLocation,
  startSqliteReadOnlyLocationAsync,
} from "./sqlite-snapshot-source.js";

function createDatabase(location: string, sql: string): Buffer {
  const database = new (requireNodeSqlite().DatabaseSync)(location);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
  return fs.readFileSync(location);
}

function createSnapshot(name: string) {
  const ownedRoot = path.join(root, name);
  const location = path.join(ownedRoot, "database.sqlite");
  fs.mkdirSync(ownedRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(location, "snapshot bytes");
  return { ownedRoot, location };
}

it("keeps synchronous and asynchronous token cleanup in separate snapshot flights", async () => {
  const source = path.join(root, "mixed-source.sqlite");
  const original = createDatabase(
    source,
    "CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');",
  );
  vi.stubEnv("XDG_CACHE_HOME", root);
  const synchronous = prepareSqliteReadOnlyLocation(source, { preserveSourceArtifacts: true });
  const asynchronous = startSqliteReadOnlyLocationAsync(source, {
    preserveSourceArtifacts: true,
  });
  try {
    const [syncSnapshot, asyncSnapshot] = await Promise.all([synchronous, asynchronous.result]);
    expect(syncSnapshot.cleanupRoot).toBeDefined();
    expect(asyncSnapshot.cleanupRoot).toBeDefined();
    expect(syncSnapshot.cleanupRoot).not.toBe(asyncSnapshot.cleanupRoot);
    const nestedLocation = path.join(
      asyncSnapshot.cleanupRoot!,
      "openclaw-state/state/openclaw.sqlite",
    );
    fs.mkdirSync(path.dirname(nestedLocation), { recursive: true });
    createDatabase(nestedLocation, "CREATE TABLE probe(value TEXT)");
    {
      using nested = openNodeSqliteDatabase(nestedLocation, { readOnly: true });
      admitSqliteSchema(nested);
    }
    for (const snapshot of [syncSnapshot, asyncSnapshot]) {
      const reader = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
      try {
        admitSqliteSchema(reader);
        expect(reader.prepare("SELECT value FROM probe").get()).toEqual({ value: "preserved" });
      } finally {
        reader.close();
      }
    }
    for (const location of [syncSnapshot.location, asyncSnapshot.location, nestedLocation]) {
      expect(hasSqliteDatabaseSchemaAdmissionForPath(location)).toBe(true);
    }
    const admittedPaths = () => captureSqliteDatabaseAdmissions().map((entry) => entry.location);
    expect(admittedPaths()).toEqual(
      expect.arrayContaining([syncSnapshot.location, asyncSnapshot.location, nestedLocation]),
    );
    expect(syncSnapshot.cleanup()).toBe(true);
    expect(fs.existsSync(syncSnapshot.location)).toBe(false);
    expect(admittedPaths()).not.toContain(syncSnapshot.location);
    expect(admittedPaths()).toContain(asyncSnapshot.location);
    expect(fs.existsSync(asyncSnapshot.location)).toBe(true);
    const failures: unknown[] = [];
    expect(removeTempDirectory(asyncSnapshot.cleanupRoot!, (error) => failures.push(error))).toBe(
      false,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(SqliteSnapshotCleanupError);
    expect(fs.existsSync(asyncSnapshot.location)).toBe(true);
    const releaseReader = retainSnapshotTempDirectory(path.dirname(asyncSnapshot.location));
    try {
      expect(await removeTempDirectoryAsync(asyncSnapshot.cleanupRoot!)).toBe(false);
      expect(admittedPaths()).toContain(asyncSnapshot.location);
      expect(admittedPaths()).toContain(nestedLocation);
    } finally {
      releaseReader();
    }
    expect(await asyncSnapshot.cleanupAsync()).toBe(true);
    expect(fs.existsSync(asyncSnapshot.cleanupRoot!)).toBe(false);
    expect(admittedPaths()).not.toContain(asyncSnapshot.location);
    expect(admittedPaths()).not.toContain(nestedLocation);
    expect(fs.readFileSync(source)).toEqual(original);
  } finally {
    try {
      for (const result of await Promise.allSettled([synchronous, asynchronous.result])) {
        if (result.status === "fulfilled") {
          expect(await result.value.cleanupAsync()).toBe(true);
        }
      }
    } finally {
      await asynchronous.startClose().result;
    }
  }
});

let root: string;

beforeEach(async () => {
  root = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), "snapshot-cleanup-owner-")),
  );
  await fs.promises.writeFile(path.join(root, "cleanup.log"), "");
  setLoggerOverride({ level: "warn", file: path.join(root, "cleanup.log") });
});

afterEach(async () => {
  await testApi.flushFileLogQueueForTests();
  setLoggerOverride(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(root, { recursive: true, force: true });
});

async function readCleanupLog(): Promise<unknown[]> {
  await testApi.flushFileLogQueueForTests();
  return (await fs.promises.readFile(path.join(root, "cleanup.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
}

it("does not throw when the onCleanupFailure callback itself throws", async () => {
  const processWarning = vi.spyOn(process, "emitWarning");
  const consoleWarning = vi.spyOn(console, "warn");
  const { ownedRoot, location } = createSnapshot("throwing-callback");

  // Force removal failure via fs.rmSync mock so the callback is exercised on
  // every platform, including root POSIX and Windows (where chmod can't deny).
  vi.spyOn(fs, "rmSync").mockImplementation(() => {
    throw Object.assign(new Error("mock removal failure"), { code: "EBUSY" });
  });

  const prepared = adoptPreparedLocation(location, ownedRoot, false, () => {
    throw new Error("callback exploded");
  });

  try {
    // cleanup() must not throw even though the callback throws — the
    // non-throwing contract (requireCleanup=false) must hold.
    expect(prepared.cleanup()).toBe(false);
    expect(processWarning).not.toHaveBeenCalled();
    expect(consoleWarning).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }

  const records = await readCleanupLog();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    "1": { path: ownedRoot, operation: "rm", errorCode: "EBUSY" },
    message: expect.stringContaining("SQLite read-only snapshot cleanup failed"),
  });
  expect(JSON.stringify(records)).not.toContain("callback exploded");
});
