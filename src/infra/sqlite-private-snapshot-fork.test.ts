import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureSqlitePrivateSnapshotFamily as captureFamily,
  forkSqlitePrivateSnapshotInProcess as forkSnapshot,
} from "./sqlite-private-snapshot-fork.js";
import { removeTempDirectoryAsync } from "./sqlite-readonly-location-cleanup.js";
import { createSqliteSnapshotStagingDirectorySync } from "./sqlite-snapshot-staging.js";

let image: ReturnType<typeof fixture>;
let native: ReturnType<typeof getFsSafeNativeConfig>;
const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      vi.restoreAllMocks();
      configureFsSafeNative(native);
      for (const fork of image.forks) {
        expect(await fork.cleanupAsync()).toBe(true);
      }
      expect(await removeTempDirectoryAsync(image.owned)).toBe(true);
      image.empty();
    } finally {
      cleanup();
    }
  }),
);
beforeEach(() => {
  image = fixture();
  native = getFsSafeNativeConfig();
});

function fixture() {
  const root = directories.make("private-sqlite-fork-");
  const owned = createSqliteSnapshotStagingDirectorySync(root);
  const source = path.join(owned, "database.sqlite");
  const destination = path.join(root, "forks");
  fs.mkdirSync(destination);
  fs.writeFileSync(source, Buffer.alloc(65573, 19));
  fs.writeFileSync(`${source}-wal`, Buffer.alloc(113, 37));
  fs.writeFileSync(`${source}-shm`, Buffer.alloc(32768, 41));
  const capture = () => expectDefined(captureFamily(source, owned), "snapshot family");
  const family = capture();
  const forks: Awaited<ReturnType<typeof forkSnapshot>>[] = [];
  return {
    source,
    owned,
    forks,
    capture,
    bytes: () => ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(source + suffix)),
    empty: () => expect(fs.readdirSync(destination)).toEqual([]),
    wal(bytes: number | null) {
      fs.rmSync(`${source}-wal`, { force: true });
      if (bytes !== null) {
        fs.writeFileSync(`${source}-wal`, Buffer.alloc(bytes, 29));
      }
    },
    async fork(captured = family) {
      const fork = await forkSnapshot(source, captured, destination);
      forks.push(fork);
      return fork.location;
    },
  };
}

it.each(["auto", "off"] as const)("forks independent main/WAL bytes (native %s)", async (mode) => {
  const before = image.bytes();
  configureFsSafeNative({ mode });
  const location = await image.fork();
  for (const [index, suffix] of ["", "-wal"].entries()) {
    expect(fs.readFileSync(location + suffix)).toEqual(before[index]);
    expect(fs.statSync(location + suffix).ino).not.toBe(fs.statSync(image.source + suffix).ino);
    fs.writeFileSync(location + suffix, "private write");
  }
  expect(fs.existsSync(`${location}-shm`)).toBe(false);
  expect(image.bytes()).toEqual(before);
});

it("preserves committed WAL rows in a separately writable image", async () => {
  const seedPath = path.join(directories.make("private-sqlite-wal-seed-"), "seed.sqlite");
  {
    using seed = new DatabaseSync(seedPath);
    seed.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE entries(value TEXT); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO entries VALUES('committed in WAL');",
    );
    // No native connection owns the copied source; only its captured family is lent.
    for (const suffix of ["", "-wal"]) {
      fs.copyFileSync(seedPath + suffix, image.source + suffix);
    }
  }
  const family = image.capture();
  const before = image.bytes();
  using writable = new DatabaseSync(await image.fork(family));
  expect(writable.prepare("SELECT value FROM entries").all()).toEqual([
    { value: "committed in WAL" },
  ]);
  writable.exec("INSERT INTO entries VALUES('private only'); PRAGMA wal_checkpoint(TRUNCATE)");
  expect(image.bytes()).toEqual(before);
});

it.each([
  [null, 0, true],
  [0, 32, true],
  [32, null, true],
  [113, null, false],
  [113, 32, false],
  [0, 33, false],
] as const)(
  "handles WAL churn from %s to %s bytes (frame-free: %s)",
  async (before, after, frameFree) => {
    image.wal(before);
    const family = image.capture();
    if (frameFree) {
      expect(family.wal).toBeNull();
    }
    image.wal(after);
    if (frameFree) {
      const location = await image.fork(family);
      expect(fs.existsSync(`${location}-wal`)).toBe(false);
      expect(fs.readFileSync(location)).toEqual(Buffer.alloc(65573, 19));
    } else {
      await expect(image.fork(family)).rejects.toThrow("Retained SQLite snapshot changed");
    }
  },
);

it("refuses retained WAL removal during copy without retrying live capture", async () => {
  let changed = false;
  const removeWal = () => {
    fs.unlinkSync(`${image.source}-wal`);
    changed = true;
  };
  const fsync = fs.fsyncSync.bind(fs);
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    fsync(descriptor);
    if (!changed && fs.fstatSync(descriptor).size === 65573) {
      removeWal();
    }
  });
  await expect(image.fork()).rejects.toThrow();
  expect(changed).toBe(true);
  expect(fs.readFileSync(image.source)).toEqual(Buffer.alloc(65573, 19));
});

it.each(["same-size edit", "replacement", "journal"] as const)(
  "rejects %s after the producer publishes its family",
  async (change) => {
    const before = fs.statSync(image.source);
    if (change === "same-size edit") {
      fs.writeFileSync(image.source, Buffer.alloc(65573, 23));
      fs.utimesSync(image.source, before.atime, before.mtime);
    } else if (change === "replacement") {
      fs.renameSync(image.source, image.source + ".old");
      fs.writeFileSync(image.source, Buffer.alloc(65573, 19));
    } else {
      fs.writeFileSync(`${image.source}-journal`, "pending rollback");
      expect(captureFamily(image.source, image.owned)).toBeUndefined();
    }
    await expect(image.fork()).rejects.toThrow("Retained SQLite snapshot changed");
  },
);

it("cleans failed destination work and releases source custody", async () => {
  const failure = Object.assign(new Error("private destination fsync failed"), { code: "EIO" });
  const fsync = fs.fsyncSync.bind(fs);
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    if (fs.fstatSync(descriptor).size === 65573) {
      throw failure;
    }
    fsync(descriptor);
  });
  await expect(image.fork()).rejects.toBe(failure);
  expect(fs.readFileSync(image.source)).toEqual(Buffer.alloc(65573, 19));
});
