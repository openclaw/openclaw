import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "./node-sqlite.js";
import {
  releaseSnapshotTempDirectory,
  removeTempDirectory,
  removeTempDirectoryAsync,
} from "./sqlite-readonly-location-cleanup.js";
import {
  createSqliteSnapshotStagingDirectory,
  createSqliteSnapshotStagingDirectorySync,
} from "./sqlite-snapshot-staging.js";
import { acquireSqliteStagingToken } from "./sqlite-staging-token.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
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

it("preserves a live nested snapshot when its parent starts cleanup first", async () => {
  const { cache, source } = createFixture();
  const parent = await createSqliteSnapshotStagingDirectory(cache, false, undefined, true);
  const child = await createSqliteSnapshotStagingDirectory(parent, false, undefined, true);
  const location = path.join(child, "database.sqlite");
  fs.copyFileSync(source, location);
  try {
    expect(await removeTempDirectoryAsync(parent)).toBe(false);
    assertReadable(location);
    expect(await removeTempDirectoryAsync(child)).toBe(true);
    expect(await removeTempDirectoryAsync(parent)).toBe(true);
  } finally {
    await removeTempDirectoryAsync(child);
    await removeTempDirectoryAsync(parent);
  }
});

it.each([false, true])(
  "cleans a fresh owned legacy staging directory (async: %s)",
  async (asynchronous) => {
    const { cache, source } = createFixture();
    const directory = await createSqliteSnapshotStagingDirectory(
      cache,
      true,
      undefined,
      asynchronous,
    );
    fs.copyFileSync(source, path.join(directory, "database.sqlite"));
    expect(
      asynchronous ? await removeTempDirectoryAsync(directory) : removeTempDirectory(directory),
    ).toBe(true);
    expect(fs.existsSync(directory)).toBe(false);
  },
);

it("rechecks retirement after a competing owner wins the exclusive-upgrade gap", () => {
  const { cache, source } = createFixture();
  const open = nodeSqlite.openNodeSqliteDatabase;
  let raced = false;
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = open(...args);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((statement) => {
      const query = prepare(statement);
      if (statement === "ROLLBACK" && !raced) {
        const run = query.run.bind(query);
        vi.spyOn(query, "run").mockImplementation((...parameters) => {
          const result = run(...parameters);
          raced = true;
          acquireSqliteStagingToken(directory, "reclaim")(true);
          return result;
        });
      }
      return query;
    });
    return db;
  });
  const directory = createSqliteSnapshotStagingDirectorySync(cache);
  const location = path.join(directory, "database.sqlite");
  fs.copyFileSync(source, location);
  try {
    expect(removeTempDirectory(directory)).toBe(false);
    expect(raced).toBe(true);
    assertReadable(location);
    expect(removeTempDirectory(directory)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    releaseSnapshotTempDirectory(directory);
    removeTempDirectory(directory);
  }
});

it("reacquires every child fence after SQLite rolls back a failed retirement", () => {
  const { cache, source } = createFixture();
  const open = nodeSqlite.openNodeSqliteDatabase;
  let failed = false;
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = open(...args);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((statement) => {
      const query = prepare(statement);
      if (statement === "COMMIT" && !failed) {
        vi.spyOn(query, "run").mockImplementationOnce(() => {
          failed = true;
          db.exec("ROLLBACK");
          throw Object.assign(new Error("database or disk is full"), { errcode: 13 });
        });
      }
      return query;
    });
    return db;
  });
  const parent = createSqliteSnapshotStagingDirectorySync(cache);
  fs.copyFileSync(source, path.join(parent, "first"));
  let child: string | undefined;
  try {
    expect(removeTempDirectory(parent)).toBe(false);
    expect(failed).toBe(true);
    expect(fs.existsSync(path.join(parent, "first"))).toBe(false);
    expect(fs.existsSync(path.join(parent, "owner.sqlite"))).toBe(true);
    child = createSqliteSnapshotStagingDirectorySync(parent);
    const location = path.join(child, "database.sqlite");
    fs.copyFileSync(source, location);
    expect(removeTempDirectory(parent)).toBe(false);
    assertReadable(location);
    expect(removeTempDirectory(child)).toBe(true);
    expect(removeTempDirectory(parent)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    if (child) {
      removeTempDirectory(child);
    }
    removeTempDirectory(parent);
  }
});

it("retries native close without rewriting a committed retirement marker", () => {
  const { cache, source } = createFixture();
  const open = nodeSqlite.openNodeSqliteDatabase;
  let markerWrites = 0;
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const db = open(...args);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((statement) => {
      if (statement === "PRAGMA user_version=1") {
        markerWrites++;
      }
      return prepare(statement);
    });
    vi.spyOn(db, "close").mockImplementationOnce(() => {
      throw new Error("native close did not finish");
    });
    return db;
  });
  const directory = createSqliteSnapshotStagingDirectorySync(cache);
  fs.copyFileSync(source, path.join(directory, "database.sqlite"));
  try {
    expect(removeTempDirectory(directory)).toBe(false);
    expect(fs.existsSync(path.join(directory, "database.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "owner.sqlite"))).toBe(true);
    expect(removeTempDirectory(directory)).toBe(true);
    expect(markerWrites).toBe(1);
  } finally {
    vi.restoreAllMocks();
    removeTempDirectory(directory);
  }
});

it.each(process.platform === "win32" ? [false] : [false, true])(
  "retains a descendant's failed native close until ordinary retry (root removed: %s)",
  (removed) => {
    const { cache, source } = createFixture();
    const parent = createSqliteSnapshotStagingDirectorySync(cache);
    const child = createSqliteSnapshotStagingDirectorySync(parent);
    fs.copyFileSync(source, path.join(child, "database.sqlite"));
    releaseSnapshotTempDirectory(child);
    const open = nodeSqlite.openNodeSqliteDatabase;
    let retained: ReturnType<typeof open> | undefined;
    const opened = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = open(...args);
      retained ??= db;
      vi.spyOn(db, "close")
        .mockImplementationOnce(() => {
          throw new Error("native close did not finish");
        })
        .mockImplementationOnce(() => {
          throw new Error("native close still pending");
        });
      return db;
    });
    try {
      expect(removeTempDirectory(parent)).toBe(false);
      expect(retained?.isOpen).toBe(true);
      expect(fs.existsSync(path.join(child, "database.sqlite"))).toBe(false);
      opened.mockRestore();
      if (removed) {
        // POSIX permits unlinking an open database; the process still owns its native handle.
        fs.rmSync(parent, { recursive: true });
      }
      expect(removeTempDirectory(parent)).toBe(true);
      expect(retained?.isOpen).toBe(false);
    } finally {
      vi.restoreAllMocks();
      removeTempDirectory(parent);
    }
  },
);

it.each(["directory", "token"] as const)(
  "preserves payload when the %s identity changes before retirement",
  (kind) => {
    const { cache, source } = createFixture();
    const directory = createSqliteSnapshotStagingDirectorySync(cache);
    const location = path.join(directory, "database.sqlite");
    fs.copyFileSync(source, location);
    const target = kind === "directory" ? directory : path.join(directory, "owner.sqlite");
    const lstat = fs.lstatSync;
    const changed = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (stat && String(args[0]) === target && typeof stat.ino === "bigint") {
        Object.defineProperty(stat, "ino", { value: stat.ino + 1n });
      }
      return stat;
    });
    try {
      expect(removeTempDirectory(directory)).toBe(false);
      assertReadable(location);
    } finally {
      changed.mockRestore();
      expect(removeTempDirectory(directory)).toBe(true);
    }
  },
);

it.runIf(process.platform === "win32")(
  "rejects unknown Windows identities before selecting snapshot payload",
  () => {
    const { cache, source } = createFixture();
    const directory = createSqliteSnapshotStagingDirectorySync(cache);
    const location = path.join(directory, "database.sqlite");
    fs.copyFileSync(source, location);
    const lstat = fs.lstatSync;
    const unknown = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      if (stat && String(args[0]) === directory && typeof stat.ino === "bigint") {
        Object.defineProperty(stat, "ino", { value: 0n });
      }
      return stat;
    });
    try {
      expect(removeTempDirectory(directory)).toBe(false);
      assertReadable(location);
    } finally {
      unknown.mockRestore();
      expect(removeTempDirectory(directory)).toBe(true);
    }
  },
);
