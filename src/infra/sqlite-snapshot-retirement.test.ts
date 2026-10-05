import "../test-utils/prepare-compiled-subprocesses.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
import { beginSqliteSnapshotRetirement } from "./sqlite-snapshot-retirement.js";
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
  const database = nodeSqlite.openNodeSqliteDatabase(location, { readOnly: true });
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

it.skipIf(process.platform === "win32").each(["", "openclaw"])(
  "cleans an interrupted allocation beneath an exclusively owned parent (%s)",
  async (layout) => {
    const { cache, source } = createFixture();
    const parent = createSqliteSnapshotStagingDirectorySync(cache);
    const payload = path.join(parent, "database.sqlite");
    fs.copyFileSync(source, payload);
    const root = layout ? path.join(parent, layout) : parent;
    if (layout) {
      fs.mkdirSync(root);
    }
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `import fs from 'node:fs'; import path from 'node:path';
         import { prepareSqliteReadOnlyLocationSyncInProcess } from ${JSON.stringify(new URL("./sqlite-readonly-location.ts", import.meta.url).href)};
         const make = fs.mkdtempSync;
         fs.mkdtempSync = (...args) => {
           const directory = make(...args);
           if (path.dirname(directory) === ${JSON.stringify(root)}) {
             fs.writeSync(1, 'allocated');
             process.kill(process.pid, 'SIGSTOP');
           }
           return directory;
         };
         prepareSqliteReadOnlyLocationSyncInProcess(${JSON.stringify(source)}, ${JSON.stringify(root)});`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const closed = once(child, "close");
    let allocated: string | undefined;
    try {
      await Promise.race([
        once(child.stdout, "data"),
        closed.then(() => {
          throw new Error(`Snapshot child closed before allocation: ${stderr}`);
        }),
      ]);
      const directories = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory());
      expect(directories).toHaveLength(1);
      allocated = path.join(root, directories[0]!.name);
      expect(fs.readdirSync(allocated)).toEqual([]);
      expect(await removeTempDirectoryAsync(parent)).toBe(false);
      assertReadable(payload);
      child.kill("SIGKILL");
      expect(await closed).toEqual([null, "SIGKILL"]);
      expect(await removeTempDirectoryAsync(parent)).toBe(true);
      expect(fs.existsSync(parent)).toBe(false);
      assertReadable(source);
    } finally {
      child.kill("SIGKILL");
      await closed;
      if (allocated && fs.existsSync(allocated) && fs.readdirSync(allocated).length === 0) {
        fs.rmdirSync(allocated);
      }
      await removeTempDirectoryAsync(parent);
    }
  },
);

it.each([
  {
    parentName: "openclaw-sqlite-readonly-v2-Parent",
    layout: "",
    artifact: "owner.sqlite-journal",
    nested: true,
  },
  { parentName: "openclaw-sqlite-readonly-v2-Parent", layout: "other", nested: true },
  { parentName: "generic", layout: "", nested: true },
  { parentName: "openclaw-sqlite-readonly-v2-Orphan", layout: "", nested: false },
])(
  "refuses retirement without ownership ($parentName/$layout, $artifact)",
  ({ parentName, layout, artifact, nested }) => {
    const { cache, source } = createFixture();
    const parent = path.join(cache, parentName);
    const orphan = nested
      ? path.join(parent, layout, "openclaw-sqlite-readonly-v2-Orphan")
      : parent;
    fs.mkdirSync(orphan, { recursive: true });
    const payload = path.join(parent, "database.sqlite");
    if (nested) {
      fs.copyFileSync(source, payload);
    }
    if (artifact) {
      fs.writeFileSync(path.join(orphan, artifact), "retain");
    }
    const token = nested ? acquireSqliteStagingToken(parent, "create") : undefined;
    try {
      expect(() => beginSqliteSnapshotRetirement(parent, { token })).toThrow(
        "SQLite snapshot token ownership is unknown",
      );
      if (nested) {
        assertReadable(payload);
      }
      expect(fs.existsSync(orphan)).toBe(true);
    } finally {
      token?.();
    }
  },
);

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

it.each(["competing retirement", "commit rollback", "native close"] as const)(
  "retains cleanup custody and retries after %s",
  (failure) => {
    const { cache, source } = createFixture();
    const open = nodeSqlite.openNodeSqliteDatabase;
    let failed = false;
    let markerWrites = 0;
    vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
      const db = open(...args);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((statement) => {
        if (statement === "PRAGMA user_version=1") {
          markerWrites++;
        }
        const query = prepare(statement);
        if (failure === "competing retirement" && statement === "ROLLBACK" && !failed) {
          const run = query.run.bind(query);
          vi.spyOn(query, "run").mockImplementation((...parameters) => {
            const result = run(...parameters);
            failed = true;
            acquireSqliteStagingToken(directory, "reclaim")(true);
            return result;
          });
        } else if (failure === "commit rollback" && statement === "COMMIT" && !failed) {
          vi.spyOn(query, "run").mockImplementationOnce(() => {
            failed = true;
            db.exec("ROLLBACK");
            throw Object.assign(new Error("database or disk is full"), { errcode: 13 });
          });
        }
        return query;
      });
      if (failure === "native close") {
        vi.spyOn(db, "close").mockImplementationOnce(() => {
          failed = true;
          throw new Error("native close did not finish");
        });
      }
      return db;
    });
    const directory = createSqliteSnapshotStagingDirectorySync(cache);
    const location = path.join(
      directory,
      failure === "commit rollback" ? "first" : "database.sqlite",
    );
    fs.copyFileSync(source, location);
    let child: string | undefined;
    try {
      expect(removeTempDirectory(directory)).toBe(false);
      expect(failed).toBe(true);
      if (failure === "competing retirement") {
        assertReadable(location);
      } else {
        expect(fs.existsSync(location)).toBe(false);
        expect(fs.existsSync(path.join(directory, "owner.sqlite"))).toBe(true);
      }
      if (failure === "commit rollback") {
        child = createSqliteSnapshotStagingDirectorySync(directory);
        const childLocation = path.join(child, "database.sqlite");
        fs.copyFileSync(source, childLocation);
        expect(removeTempDirectory(directory)).toBe(false);
        assertReadable(childLocation);
        expect(removeTempDirectory(child)).toBe(true);
      }
      expect(removeTempDirectory(directory)).toBe(true);
      if (failure === "native close") {
        expect(markerWrites).toBe(1);
      }
    } finally {
      vi.restoreAllMocks();
      if (child) {
        removeTempDirectory(child);
      }
      releaseSnapshotTempDirectory(directory);
      removeTempDirectory(directory);
    }
  },
);

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

it.each([
  "directory",
  "token",
  ...(process.platform === "win32" ? (["unknown"] as const) : []),
] as const)("preserves payload when the %s identity changes before retirement", (kind) => {
  const { cache, source } = createFixture();
  const directory = createSqliteSnapshotStagingDirectorySync(cache);
  const location = path.join(directory, "database.sqlite");
  fs.copyFileSync(source, location);
  const target = kind === "token" ? path.join(directory, "owner.sqlite") : directory;
  const lstat = fs.lstatSync;
  const changed = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (stat && String(args[0]) === target && typeof stat.ino === "bigint") {
      Object.defineProperty(stat, "ino", { value: kind === "unknown" ? 0n : stat.ino + 1n });
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
});
