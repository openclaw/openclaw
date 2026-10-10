import "../test-utils/prepare-compiled-subprocesses.js";
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
