import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "./node-sqlite.js";
import * as fileGeneration from "./sqlite-file-generation.js";
import {
  createSqliteFileGenerationReader,
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "./sqlite-file-generation.js";
import * as readOnlyLocation from "./sqlite-readonly-location.js";
import * as snapshotSource from "./sqlite-snapshot-source.js";
import { readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";
import { readUnchangedUpdateDatabaseGeneration } from "./update-database-generations.js";
import {
  readUpdatePhysicalDatabaseGenerations,
  readUpdatePhysicalDatabaseObservation,
} from "./update-physical-database-generations.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function transformBigintStats(transform: (stat: fs.BigIntStats) => fs.BigIntStats) {
  const fstat = fs.fstatSync;
  const stat = fs.statSync;
  vi.spyOn(fs, "fstatSync").mockImplementation((...args) =>
    args[1]?.bigint ? transform(fstat(args[0], { bigint: true })) : fstat(...args),
  );
  vi.spyOn(fs, "statSync").mockImplementation((...args) =>
    args[1]?.bigint ? transform(stat(args[0], { bigint: true })) : stat(...args),
  );
}

function replaceText(bytes: Buffer, from: string, to: string) {
  const changed = Buffer.from(bytes);
  const offset = changed.indexOf(from);
  expect(offset).toBeGreaterThan(0);
  changed.write(to, offset);
  return changed;
}

function withNativeCopying(mode: "auto" | "off", operation: () => Promise<void>) {
  const previous = getFsSafeNativeConfig();
  configureFsSafeNative({ mode });
  return operation().finally(() => configureFsSafeNative(previous));
}

function generationFixture(layout = "delete") {
  const directory = dirs.make("update-generation-content-");
  const file = path.join(directory, "state.sqlite");
  const staging = path.join(directory, "staging");
  fs.mkdirSync(staging);
  if (layout === "zero") {
    fs.writeFileSync(file, "");
  } else {
    const database = new DatabaseSync(file);
    database.exec("CREATE TABLE receipt(value TEXT); INSERT INTO receipt VALUES ('before');");
    if (layout.startsWith("wal")) {
      database.exec("PRAGMA journal_mode=WAL;");
    }
    database.close();
  }
  if (layout === "wal-empty") {
    fs.writeFileSync(`${file}-wal`, "");
  } else if (layout === "empty-journal") {
    fs.writeFileSync(`${file}-journal`, "");
  }
  const prepare = readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess;
  vi.spyOn(readOnlyLocation, "prepareSqliteReadOnlyLocationSyncInProcess").mockImplementation(
    (pathname, _staging, ...rest) => prepare(pathname, staging, ...rest),
  );
  return { file, staging, prepare };
}

function expectedClosedGeneration(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  return createHash("sha256")
    .update(
      JSON.stringify([
        stat.dev.toString(),
        stat.ino.toString(),
        readDatabaseIdentityBirthtime(stat),
        createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        null,
        null,
      ]),
    )
    .digest("hex");
}

it.for([
  "different path",
  "same bytes replacement",
  "symlink to original",
  "coarse-clock write",
  "missing main with journal",
  "torn SHM header",
  "changing SHM header",
  "linked empty WAL",
  "linked journal",
] as const)("does not reuse a successful SQLite receipt after %s", (change, { skip }) => {
  if (
    process.platform === "win32" &&
    (change === "symlink to original" || change.startsWith("linked "))
  ) {
    skip(); // File symlinks require privileges on Windows.
  }
  const { file, staging } = generationFixture();
  if (change === "coarse-clock write") {
    const identity = fs.statSync(file, { bigint: true });
    const timestamp = BigInt(Date.now() - 5_000) * 1_000_000n;
    transformBigintStats((stat) => {
      if (stat.dev === identity.dev && stat.ino === identity.ino) {
        stat.mtimeNs = timestamp;
        stat.ctimeNs = timestamp;
      }
      return stat;
    });
  }
  const observation = readUpdatePhysicalDatabaseObservation(file);
  expect(observation.generation.ok).toBe(true);
  const receipt = observation.sqliteReceipt;
  if (!receipt) {
    throw new Error("Expected a successful SQLite receipt before changing its source");
  }
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(readUnchangedUpdateDatabaseGeneration(file, receipt)).toBe(receipt.generation);
  let pathname = file;
  if (change === "different path") {
    pathname = `${file}.other`;
    fs.copyFileSync(file, pathname);
  } else if (change === "same bytes replacement" || change === "symlink to original") {
    fs.renameSync(file, `${file}.original`);
    if (change === "symlink to original") {
      fs.symlinkSync(`${file}.original`, file);
    } else {
      fs.copyFileSync(`${file}.original`, file);
    }
  } else if (change === "coarse-clock write") {
    fs.writeFileSync(file, replaceText(fs.readFileSync(file), "before", "after!"));
  } else if (change === "missing main with journal") {
    fs.unlinkSync(file);
    fs.writeFileSync(`${file}-journal`, "retained recovery bytes");
  } else if (change === "linked empty WAL" || change === "linked journal") {
    fs.writeFileSync(`${file}.sidecar`, "");
    fs.symlinkSync(`${file}.sidecar`, `${file}-${change === "linked journal" ? "journal" : "wal"}`);
  } else {
    const header = Buffer.alloc(96);
    if (change === "torn SHM header") {
      header[0] = 1;
    } else {
      const read = fileGeneration.readStableSqliteFileGeneration;
      vi.spyOn(fileGeneration, "readStableSqliteFileGeneration").mockImplementationOnce(
        (...args) => {
          const generation = read(...args);
          header[0] = header[48] = 1;
          fs.writeFileSync(`${file}-shm`, header);
          return generation;
        },
      );
    }
    fs.writeFileSync(`${file}-shm`, header);
  }
  if (["different path", "same bytes replacement", "coarse-clock write"].includes(change)) {
    expect(readUnchangedUpdateDatabaseGeneration(pathname, receipt)).toBeUndefined();
  } else {
    expect(() => readUnchangedUpdateDatabaseGeneration(pathname, receipt)).toThrow(
      change === "missing main with journal"
        ? /absent but retained journal/
        : change === "torn SHM header"
          ? /WAL commit header is unavailable or changing/
          : change === "changing SHM header"
            ? /WAL commit publication could not be verified/
            : /requires a regular file/,
    );
  }
  expect(readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess).toHaveBeenCalledTimes(1);
  expect(fs.readdirSync(staging)).toEqual([]);
});

it.skipIf(process.platform === "win32").each(["", "-wal", "-journal"] as const)(
  "rejects a linked family member %s installed during receipt verification",
  (suffix) => {
    const { file, staging } = generationFixture();
    if (suffix) {
      fs.writeFileSync(file + suffix, "");
    }
    const receipt = readUpdatePhysicalDatabaseObservation(file).sqliteReceipt;
    if (!receipt) {
      throw new Error("Expected a successful SQLite receipt before replacing its family");
    }
    const read = fileGeneration.readStableSqliteFileGeneration;
    vi.spyOn(fileGeneration, "readStableSqliteFileGeneration").mockImplementationOnce((...args) => {
      const generation = read(...args);
      fs.renameSync(file + suffix, `${file + suffix}.original`);
      fs.symlinkSync(`${file + suffix}.original`, file + suffix);
      return generation;
    });
    expect(() => readUnchangedUpdateDatabaseGeneration(file, receipt)).toThrow(
      /requires a regular file/,
    );
    expect(readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(staging)).toEqual([]);
  },
);

it.each(["appears", "disappears", "is replaced"] as const)(
  "reuses a receipt when only an empty WAL %s without a commit header change",
  (change) => {
    const { file, staging } = generationFixture(change === "appears" ? "wal-absent" : "wal-empty");
    const receipt = readUpdatePhysicalDatabaseObservation(file).sqliteReceipt;
    if (!receipt) {
      throw new Error("Expected a successful SQLite receipt before the empty WAL transition");
    }
    if (change !== "appears") {
      fs.renameSync(`${file}-wal`, `${file}.empty-wal`);
    }
    if (change !== "disappears") {
      fs.writeFileSync(`${file}-wal`, "");
    }
    expect(readUnchangedUpdateDatabaseGeneration(file, receipt)).toBe(receipt.generation);
    expect(readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(staging)).toEqual([]);
  },
);

it.each(["auto", "off"] as const)(
  "retains exact closed generations and source bytes with native copying %s",
  async (mode) => {
    await withNativeCopying(mode, async () => {
      for (const layout of ["delete", "wal-absent", "wal-empty", "empty-journal", "zero"]) {
        const { file, staging } = generationFixture(layout);
        const before = ["", "-wal", "-journal"].flatMap((suffix) =>
          fs.existsSync(file + suffix) ? [{ suffix, bytes: fs.readFileSync(file + suffix) }] : [],
        );
        const expected = expectedClosedGeneration(file);
        expect(await readUpdatePhysicalDatabaseGenerations([file]), layout).toEqual({
          [file]: expected,
        });
        for (const { suffix, bytes } of before) {
          expect(fs.readFileSync(file + suffix), `${layout}${suffix}`).toEqual(bytes);
        }
        expect(fs.existsSync(`${file}-shm`), layout).toBe(false);
        expect(fs.readdirSync(staging), layout).toEqual([]);
        vi.restoreAllMocks();
      }
    });
  },
);

it.each(["header", "catalog", "truncated"] as const)(
  "keeps native %s refusal and cleans up a digest-matched private image",
  async (damage) => {
    const { file, staging } = generationFixture();
    const bytes = fs.readFileSync(file);
    if (damage === "header") {
      bytes[0] = 0;
    } else if (damage === "catalog") {
      const offset = bytes.indexOf("CREATE TABLE receipt");
      expect(offset).toBeGreaterThan(0);
      bytes[offset + 3] = "X".charCodeAt(0);
    }
    fs.writeFileSync(file, damage === "truncated" ? bytes.subarray(0, 101) : bytes);
    const before = fs.readFileSync(file);
    await expect(readUpdatePhysicalDatabaseGenerations([file])).rejects.toThrow(
      damage === "catalog" ? /malformed database schema/ : /not a database|malformed/,
    );
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(staging)).toEqual([]);
  },
);

it.each(["auto", "off"] as const)(
  "rejects a valid transient copy of a malformed source with native copying %s",
  async (mode) => {
    const { file, staging, prepare } = generationFixture();
    const valid = fs.readFileSync(file);
    const malformed = replaceText(valid, "CREATE TABLE receipt", "CREX");
    fs.writeFileSync(file, malformed);
    let copied = false;
    vi.mocked(readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess).mockImplementation(
      (pathname, _staging, ...rest) => {
        fs.writeFileSync(file, valid);
        try {
          copied = true;
          return prepare(pathname, staging, ...rest);
        } finally {
          fs.writeFileSync(file, malformed);
        }
      },
    );
    await withNativeCopying(mode, () =>
      expect(readUpdatePhysicalDatabaseGenerations([file])).rejects.toThrow(
        /snapshot hash mismatch/,
      ),
    );
    expect(copied).toBe(true);
    expect(fs.readFileSync(file)).toEqual(malformed);
    expect(fs.readdirSync(staging)).toEqual([]);
  },
);

it("refuses a malformed engine anchor from the captured image and cleans up", async () => {
  const { file, staging } = generationFixture();
  const database = new DatabaseSync(file);
  database.exec(
    "CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT);" +
      "INSERT INTO openclaw_engine_anchor VALUES ('test-store', 'postgres', 'invalid-schema');",
  );
  database.close();
  const before = fs.readFileSync(file);
  await expect(readUpdatePhysicalDatabaseGenerations([file])).rejects.toThrow(
    /Invalid PostgreSQL anchor/,
  );
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.readdirSync(staging)).toEqual([]);
});

it.each(["same-size write", "truncation", "identity replacement"] as const)(
  "refuses a captured source's %s before native admission",
  async (change) => {
    const { file, staging, prepare } = generationFixture();
    const original = fs.readFileSync(file);
    const changed = replaceText(original, "before", "after!");
    vi.mocked(readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess).mockImplementation(
      (pathname, _staging, ...rest) => {
        if (change === "identity replacement") {
          fs.renameSync(file, `${file}.original`);
          fs.writeFileSync(file, original);
        } else {
          fs.writeFileSync(file, change === "truncation" ? changed.subarray(0, 101) : changed);
        }
        return prepare(pathname, staging, ...rest);
      },
    );
    await expect(readUpdatePhysicalDatabaseGenerations([file])).rejects.toThrow(
      change === "identity replacement" ? /file identity changed/ : /snapshot (hash|size) mismatch/,
    );
    expect(fs.readdirSync(staging)).toEqual([]);
    expect(fs.readFileSync(file)).toEqual(
      change === "identity replacement"
        ? original
        : change === "truncation"
          ? changed.subarray(0, 101)
          : changed,
    );
  },
);

it.each([
  ["journal", "before acquisition"],
  ["journal", "during copying"],
  ["wal", "before acquisition"],
] as const)("refuses captured-digest acquisition when %s appears %s", async (sidecar, timing) => {
  const { file, staging, prepare } = generationFixture();
  const before = fs.readFileSync(file);
  const sidecarPath = `${file}-${sidecar}`;
  const sidecarBytes = sidecar === "journal" ? Buffer.alloc(0) : Buffer.from("truncated WAL");
  const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  const fsync = fs.fsyncSync.bind(fs);
  let appeared = false;
  if (timing === "during copying") {
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      fsync(descriptor);
      if (!appeared) {
        fs.writeFileSync(sidecarPath, sidecarBytes);
        appeared = true;
      }
    });
  }
  let acquired = false;
  vi.mocked(readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess).mockImplementation(
    (pathname, _staging, identity, content) => {
      expect(content).toBeDefined();
      if (timing === "before acquisition") {
        fs.writeFileSync(sidecarPath, sidecarBytes);
        appeared = true;
      }
      const prepared = prepare(pathname, staging, identity, content);
      acquired = true;
      return prepared;
    },
  );
  await expect(readUpdatePhysicalDatabaseGenerations([file])).rejects.toThrow(
    /SQLite source did not stabilize/,
  );
  expect(appeared).toBe(true);
  expect(acquired).toBe(false);
  // Staging leases own a separate SQLite token; neither source nor private
  // payload may reach native recovery/admission after eligibility changes.
  for (const [location] of open.mock.calls) {
    const opened = location.startsWith("file:") ? fileURLToPath(location) : location;
    expect(path.basename(opened)).toBe("owner.sqlite");
  }
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.readFileSync(sidecarPath)).toEqual(sidecarBytes);
  expect(fs.readdirSync(staging)).toEqual([]);
});

it.each([
  "before acquisition",
  "after acquisition",
  "after acquisition within a timestamp quantum",
] as const)("refuses a same-size write after a source digest %s", async (timing) => {
  const { file, staging, prepare } = generationFixture();
  const changed = replaceText(fs.readFileSync(file), "before", "after!");
  const source = fs.statSync(file, { bigint: true });
  const coarse = timing === "after acquisition within a timestamp quantum";
  const now = Date.now();
  const timestamp = BigInt(Math.floor(now / 2_000) * 2_000) * 1_000_000n;
  const sourceStat = (stat: fs.BigIntStats) => {
    if (coarse && stat.dev === source.dev && stat.ino === source.ino) {
      // A real write may collide in a filesystem clock quantum.
      Object.defineProperties(stat, {
        mtimeNs: { value: timestamp },
        ctimeNs: { value: timestamp },
      });
    }
    return stat;
  };
  if (coarse) {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fstatSync = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) =>
      args[1]?.bigint ? sourceStat(fstatSync(args[0], { bigint: true })) : fstatSync(...args),
    );
  }
  let acquired = false;
  let mutated = false;
  vi.mocked(readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess).mockImplementation(
    (pathname, _staging, ...rest) => {
      const prepared = prepare(pathname, staging, ...rest);
      acquired = true;
      return prepared;
    },
  );
  const statSync = fs.statSync;
  vi.spyOn(fs, "statSync").mockImplementation((...args) => {
    const stat = args[1]?.bigint
      ? sourceStat(statSync(args[0], { bigint: true }))
      : statSync(...args);
    if (!mutated && String(args[0]) === file && acquired === (timing !== "before acquisition")) {
      // The digest is already computed; the outer identity check sees the
      // same inode and size. Subsequent content verification must catch it.
      fs.writeFileSync(file, changed);
      mutated = true;
    }
    return stat;
  });
  await expect(readUpdatePhysicalDatabaseGenerations([file])).rejects.toThrow(
    timing === "before acquisition" ? /snapshot hash mismatch/ : /generation changed/,
  );
  expect(mutated).toBe(true);
  expect(acquired).toBe(timing !== "before acquisition");
  expect(fs.readFileSync(file)).toEqual(changed);
  expect(fs.readdirSync(staging)).toEqual([]);
});

it.each(["bigint", "number"] as const)(
  "rehashes when only %s millisecond stats are available",
  (milliseconds) => {
    const file = path.join(dirs.make("update-generation-milliseconds-"), "state.sqlite");
    fs.writeFileSync(file, "before");
    const withoutNanoseconds = (stat: fs.BigIntStats) => {
      Object.defineProperties(stat, {
        mtimeNs: { value: undefined },
        ctimeNs: { value: undefined },
        birthtimeNs: { value: undefined },
        ...(milliseconds === "number"
          ? {
              mtimeMs: { value: Number(stat.mtimeMs) },
              ctimeMs: { value: Number(stat.ctimeMs) },
              birthtimeMs: { value: Number(stat.birthtimeMs) },
            }
          : {}),
      });
      return stat;
    };
    transformBigintStats(withoutNanoseconds);
    const read = createSqliteFileGenerationReader();
    read(file);
    fs.writeFileSync(file, "after!");
    expect(read(file).database.sha256).toBe(createHash("sha256").update("after!").digest("hex"));
  },
);

it.each([
  ["recent", 0, 3],
  ["older", 3_000, 1],
] as const)(
  "verifies %s source digests and one private payload",
  async (_age, elapsedMs, passes) => {
    const { file, staging, prepare } = generationFixture();
    const database = new DatabaseSync(file);
    database.exec(
      "CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(2097152));",
    );
    database.close();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + elapsedMs);
    const expected = expectedClosedGeneration(file);
    const source = fs.statSync(file, { bigint: true });
    const isolatedCapture = vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocationSync");
    const read = fs.readSync.bind(fs);
    let sourceBytes = 0;
    let generationBytes = 0;
    let privateBytes = 0;
    let acquiring = false;
    vi.mocked(readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess).mockImplementation(
      (pathname, _staging, ...rest) => {
        acquiring = true;
        try {
          return prepare(pathname, staging, ...rest);
        } finally {
          acquiring = false;
        }
      },
    );
    vi.spyOn(fs, "readSync").mockImplementation(
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
        const count = read(descriptor, buffer, options);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (opened.dev === source.dev && opened.ino === source.ino) {
          sourceBytes += count;
          if (!acquiring) {
            generationBytes += count;
          }
        } else if (opened.isFile() && opened.size === source.size) {
          privateBytes += count;
        }
        return count;
      },
    );
    expect(await readUpdatePhysicalDatabaseGenerations([file])).toEqual({ [file]: expected });
    expect(readOnlyLocation.prepareSqliteReadOnlyLocationSyncInProcess).toHaveBeenCalledTimes(1);
    expect(isolatedCapture).not.toHaveBeenCalled();
    const size = Number(source.size);
    expect(generationBytes).toBe(passes * size);
    expect(sourceBytes).toBeGreaterThanOrEqual(passes * size);
    // A byte-copy fallback can add one source pass. Headers are bounded overhead.
    expect(sourceBytes).toBeLessThanOrEqual((passes + 1) * size + 256);
    expect(privateBytes).toBe(size);
    expect(fs.readdirSync(staging)).toEqual([]);
  },
);

it("preserves update custody when database timestamps drift during hashing", async () => {
  const file = path.join(dirs.make("update-generation-drift-"), "state.sqlite");
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE receipt(value TEXT); INSERT INTO receipt VALUES ('retained');");
  database.close();
  const before = await readUpdatePhysicalDatabaseGenerations([file]);
  const identity = fs.statSync(file, { bigint: true });
  const fstat = fs.fstatSync;
  let observations = 0;
  vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
    if (!args[1]?.bigint) {
      return fstat(...args);
    }
    const stat = fstat(args[0], { bigint: true });
    if (stat.dev === identity.dev && stat.ino === identity.ino) {
      // Model delayed filesystem metadata publication on the pinned source.
      stat.ctimeNs += BigInt(++observations) * 1_000_000_000n;
      stat.birthtimeNs = stat.ctimeNs;
    }
    return stat;
  });
  const timestamp = fs.statSync(file);
  fs.utimesSync(file, timestamp.atime, new Date(timestamp.mtimeMs + 1_000));
  expect(await readUpdatePhysicalDatabaseGenerations([file])).toEqual(before);
  expect(observations).toBeGreaterThan(1);
});

it("invalidates ctime-only source changes across interleaved files", () => {
  const directory = dirs.make("update-generation-reuse-");
  const first = path.join(directory, "first.sqlite");
  const second = path.join(directory, "second.sqlite");
  fs.writeFileSync(first, "before");
  fs.writeFileSync(second, "second");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_000);
  const read = createSqliteFileGenerationReader();
  const before = read(first);
  const other = read(second);
  fs.writeFileSync(first, "after!");
  const preserveMtime = (current: fs.BigIntStats) => {
    if (current.dev === before.database.dev && current.ino === before.database.ino) {
      current.mtimeNs = before.database.mtimeNs;
      current.ctimeNs = before.database.ctimeNs + 1n;
    }
    return current;
  };
  transformBigintStats(preserveMtime);
  expect(read(first).database.sha256).toBe(createHash("sha256").update("after!").digest("hex"));
  expect(read(second)).toEqual(other);
});

it.each(["dev", "ino"] as const)(
  "refuses unknown %s in a captured generation on Windows",
  (field) => {
    const file = path.join(dirs.make("update-generation-identity-"), "state.sqlite");
    fs.writeFileSync(file, "same bytes");
    const generation = readStableSqliteFileGeneration(file);
    const changed = { ...generation, database: { ...generation.database, [field]: 0n } };
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(sameSqliteFileGeneration(generation, changed)).toBe(false);
  },
);

it("captures opened file identity when Windows pathname stats report unknown IDs", () => {
  const file = path.join(dirs.make("update-generation-open-identity-"), "state.sqlite");
  fs.writeFileSync(file, "same bytes");
  const fd = fs.openSync(file, "r");
  let expected: fs.BigIntStats;
  try {
    expected = fs.fstatSync(fd, { bigint: true });
  } finally {
    fs.closeSync(fd);
  }
  const statSync = fs.statSync;
  vi.spyOn(fs, "statSync").mockImplementation((...args) => {
    const stat = statSync(...args);
    if (stat && String(args[0]) === file) {
      const zero = typeof stat.ino === "bigint" ? 0n : 0;
      Object.defineProperties(stat, { dev: { value: zero }, ino: { value: zero } });
    }
    return stat;
  });
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  expect(readStableSqliteFileGeneration(file).database).toMatchObject({
    dev: expected.dev,
    ino: expected.ino,
  });
});
