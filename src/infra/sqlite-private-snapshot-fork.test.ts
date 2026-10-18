import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureSqlitePrivateSnapshotFamily,
  forkSqlitePrivateSnapshotInProcess,
} from "./sqlite-private-snapshot-fork.js";
import { removeTempDirectoryAsync } from "./sqlite-readonly-location-cleanup.js";
import { createSqliteSnapshotStagingDirectorySync } from "./sqlite-snapshot-staging.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const root = directories.make("private-sqlite-fork-");
  const owned = createSqliteSnapshotStagingDirectorySync(root);
  const source = path.join(owned, "database.sqlite");
  const destination = path.join(root, "forks");
  fs.mkdirSync(destination);
  fs.writeFileSync(source, Buffer.alloc(65573, 19));
  fs.writeFileSync(`${source}-wal`, Buffer.alloc(113, 37));
  fs.writeFileSync(`${source}-shm`, Buffer.alloc(32768, 41));
  const family = captureSqlitePrivateSnapshotFamily(source, owned);
  assert(family);
  return { source, owned, destination, family };
}

it.each(["auto", "off"] as const)(
  "forks independent main/WAL bytes without comparison reads (native %s)",
  async (mode) => {
    const source = fixture();
    const before = ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(source.source + suffix));
    const native = getFsSafeNativeConfig();
    const read = fs.readSync.bind(fs);
    let payloadBytes = 0;
    const reads = vi
      .spyOn(fs, "readSync")
      .mockImplementation(
        (
          descriptor: number,
          buffer: NodeJS.ArrayBufferView,
          offsetOrOptions: number | fs.ReadOptions = {},
          length?: number,
          position?: fs.ReadPosition | null,
        ) => {
          const options =
            typeof offsetOrOptions === "number"
              ? { offset: offsetOrOptions, length, position }
              : offsetOrOptions;
          const bytes = read(descriptor, buffer, options);
          // Unique fixture lengths identify both source and destination payload descriptors.
          if ([65573, 113].includes(fs.fstatSync(descriptor).size)) {
            payloadBytes += bytes;
          }
          return bytes;
        },
      );
    let fork: Awaited<ReturnType<typeof forkSqlitePrivateSnapshotInProcess>> | undefined;
    try {
      configureFsSafeNative({ mode });
      fork = await forkSqlitePrivateSnapshotInProcess(
        source.source,
        source.family,
        source.destination,
      );
      reads.mockRestore();
      // Full-copy fallback reads each payload once; cloning needs no JS payload reads.
      expect(payloadBytes).toBeLessThanOrEqual(65573 + 113);
      if (mode === "off") {
        expect(payloadBytes).toBe(65573 + 113);
      }
      for (const [index, suffix] of ["", "-wal"].entries()) {
        expect(fs.readFileSync(fork.location + suffix)).toEqual(before[index]);
        expect(fs.statSync(fork.location + suffix).ino).not.toBe(
          fs.statSync(source.source + suffix).ino,
        );
        fs.writeFileSync(fork.location + suffix, "private write");
      }
      expect(fs.existsSync(`${fork.location}-shm`)).toBe(false);
      expect(["", "-wal", "-shm"].map((suffix) => fs.readFileSync(source.source + suffix))).toEqual(
        before,
      );
    } finally {
      reads.mockRestore();
      configureFsSafeNative(native);
      if (fork) {
        expect(await fork.cleanupAsync()).toBe(true);
      }
      expect(await removeTempDirectoryAsync(source.owned)).toBe(true);
    }
    expect(fs.readdirSync(source.destination)).toEqual([]);
  },
);

it("preserves committed WAL rows in a separately writable image", async () => {
  const source = fixture();
  const seedPath = path.join(directories.make("private-sqlite-wal-seed-"), "seed.sqlite");
  const seed = new DatabaseSync(seedPath);
  try {
    seed.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries(value TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO entries VALUES('committed in WAL');",
    );
    // No native connection owns the copied source; its retained family is the fork input.
    for (const suffix of ["", "-wal"]) {
      fs.copyFileSync(seedPath + suffix, source.source + suffix);
    }
  } finally {
    seed.close();
  }
  const family = captureSqlitePrivateSnapshotFamily(source.source, source.owned);
  assert(family);
  const before = ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(source.source + suffix));
  const fork = await forkSqlitePrivateSnapshotInProcess(source.source, family, source.destination);
  try {
    using writable = new DatabaseSync(fork.location);
    expect(writable.prepare("SELECT value FROM entries").all()).toEqual([
      { value: "committed in WAL" },
    ]);
    writable.exec("INSERT INTO entries VALUES('private only'); PRAGMA wal_checkpoint(TRUNCATE)");
    expect(["", "-wal", "-shm"].map((suffix) => fs.readFileSync(source.source + suffix))).toEqual(
      before,
    );
  } finally {
    expect(await fork.cleanupAsync()).toBe(true);
    expect(await removeTempDirectoryAsync(source.owned)).toBe(true);
  }
});

it.each([
  [null, 0],
  [0, 32],
  [32, null],
  [32, 7],
] as const)(
  "accepts frame-free WAL churn from %s to %s bytes without copying it",
  async (before, after) => {
    const source = fixture();
    const changeWal = (bytes: number | null) => {
      fs.rmSync(`${source.source}-wal`, { force: true });
      if (bytes !== null) {
        fs.writeFileSync(`${source.source}-wal`, Buffer.alloc(bytes, 29));
      }
    };
    changeWal(before);
    const family = captureSqlitePrivateSnapshotFamily(source.source, source.owned);
    assert(family);
    expect(family.wal).toBeNull();
    changeWal(after);
    const fork = await forkSqlitePrivateSnapshotInProcess(
      source.source,
      family,
      source.destination,
    );
    try {
      expect(fs.existsSync(`${fork.location}-wal`)).toBe(false);
      expect(fs.readFileSync(fork.location)).toEqual(Buffer.alloc(65573, 19));
    } finally {
      expect(await fork.cleanupAsync()).toBe(true);
      expect(await removeTempDirectoryAsync(source.owned)).toBe(true);
    }
  },
);

it.each([
  [113, 0],
  [113, 32],
  [0, 33],
] as const)("refuses WAL frame-class drift from %s to %s bytes", async (before, after) => {
  const source = fixture();
  fs.writeFileSync(`${source.source}-wal`, Buffer.alloc(before, 29));
  const family = captureSqlitePrivateSnapshotFamily(source.source, source.owned);
  assert(family);
  fs.writeFileSync(`${source.source}-wal`, Buffer.alloc(after, 29));
  try {
    await expect(
      forkSqlitePrivateSnapshotInProcess(source.source, family, source.destination),
    ).rejects.toThrow("Retained SQLite snapshot changed");
    expect(fs.readdirSync(source.destination)).toEqual([]);
  } finally {
    expect(await removeTempDirectoryAsync(source.owned)).toBe(true);
  }
});

it.each(["before admission", "during copy"] as const)(
  "refuses retained family drift %s without retrying live capture",
  async (timing) => {
    const source = fixture();
    let changed = false;
    const removeWal = () => {
      fs.unlinkSync(`${source.source}-wal`);
      changed = true;
    };
    if (timing === "before admission") {
      removeWal();
    } else {
      const fsync = fs.fsyncSync.bind(fs);
      vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
        fsync(descriptor);
        if (!changed && fs.fstatSync(descriptor).size === 65573) {
          removeWal();
        }
      });
    }
    try {
      await expect(
        forkSqlitePrivateSnapshotInProcess(source.source, source.family, source.destination),
      ).rejects.toThrow();
      expect(changed).toBe(true);
      expect(fs.readdirSync(source.destination)).toEqual([]);
      expect(fs.readFileSync(source.source)).toEqual(Buffer.alloc(65573, 19));
    } finally {
      expect(await removeTempDirectoryAsync(source.owned)).toBe(true);
    }
  },
);

it.each(["same-size edit", "replacement", "journal"] as const)(
  "rejects %s after the producer publishes its family",
  async (change) => {
    const source = fixture();
    const before = fs.statSync(source.source);
    if (change === "same-size edit") {
      fs.writeFileSync(source.source, Buffer.alloc(65573, 23));
      fs.utimesSync(source.source, before.atime, before.mtime);
    } else if (change === "replacement") {
      fs.renameSync(source.source, source.source + ".old");
      fs.writeFileSync(source.source, Buffer.alloc(65573, 19));
    } else {
      fs.writeFileSync(`${source.source}-journal`, "pending rollback");
      expect(captureSqlitePrivateSnapshotFamily(source.source, source.owned)).toBeUndefined();
    }
    try {
      await expect(
        forkSqlitePrivateSnapshotInProcess(source.source, source.family, source.destination),
      ).rejects.toThrow("Retained SQLite snapshot changed");
      expect(fs.readdirSync(source.destination)).toEqual([]);
    } finally {
      expect(await removeTempDirectoryAsync(source.owned)).toBe(true);
    }
  },
);

it("cleans failed destination work and releases source custody", async () => {
  const source = fixture();
  const failure = Object.assign(new Error("private destination fsync failed"), { code: "EIO" });
  const fsync = fs.fsyncSync.bind(fs);
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    if (fs.fstatSync(descriptor).size === 65573) {
      throw failure;
    }
    fsync(descriptor);
  });
  await expect(
    forkSqlitePrivateSnapshotInProcess(source.source, source.family, source.destination),
  ).rejects.toBe(failure);
  expect(fs.readdirSync(source.destination)).toEqual([]);
  expect(fs.readFileSync(source.source)).toEqual(Buffer.alloc(65573, 19));
  expect(await removeTempDirectoryAsync(source.owned)).toBe(true);
});
