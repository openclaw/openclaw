import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createSqliteFileGenerationReader,
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "./sqlite-file-generation.js";
import { readUpdateDatabaseGenerations } from "./update-database-generations.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("preserves update custody when database timestamps drift during hashing", () => {
  const file = path.join(dirs.make("update-generation-drift-"), "state.sqlite");
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE receipt(value TEXT); INSERT INTO receipt VALUES ('retained');");
  database.close();
  const before = readUpdateDatabaseGenerations([file]);
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
  expect(readUpdateDatabaseGenerations([file])).toEqual(before);
  expect(observations).toBeGreaterThan(1);
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
    const fstat = fs.fstatSync;
    const stat = fs.statSync;
    vi.spyOn(fs, "fstatSync").mockImplementation((...args) =>
      args[1]?.bigint ? withoutNanoseconds(fstat(args[0], { bigint: true })) : fstat(...args),
    );
    vi.spyOn(fs, "statSync").mockImplementation((...args) =>
      args[1]?.bigint ? withoutNanoseconds(stat(args[0], { bigint: true })) : stat(...args),
    );
    const read = createSqliteFileGenerationReader();
    read(file);
    fs.writeFileSync(file, "after!");
    expect(read(file).database.sha256).toBe(createHash("sha256").update("after!").digest("hex"));
  },
);

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
  const fstat = fs.fstatSync;
  const stat = fs.statSync;
  const preserveMtime = (current: fs.BigIntStats) => {
    if (current.dev === before.database.dev && current.ino === before.database.ino) {
      current.mtimeNs = before.database.mtimeNs;
      current.ctimeNs = before.database.ctimeNs + 1n;
    }
    return current;
  };
  vi.spyOn(fs, "fstatSync").mockImplementation((...args) =>
    args[1]?.bigint ? preserveMtime(fstat(args[0], { bigint: true })) : fstat(...args),
  );
  vi.spyOn(fs, "statSync").mockImplementation((...args) =>
    args[1]?.bigint ? preserveMtime(stat(args[0], { bigint: true })) : stat(...args),
  );
  expect(read(first).database.sha256).toBe(createHash("sha256").update("after!").digest("hex"));
  expect(read(second)).toEqual(other);
});

it.each(["recent", "older"] as const)("bounds digest reuse to one %s observation", (age) => {
  const file = path.join(dirs.make("update-generation-local-"), "state.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE payload(value); INSERT INTO payload VALUES (zeroblob(65536));");
  db.close();
  const expected = readUpdateDatabaseGenerations([file]);
  const identity = fs.statSync(file, { bigint: true });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + (age === "older" ? 3000 : 0));
  const readSync = fs.readSync.bind(fs);
  let sourceBytes = 0;
  vi.spyOn(fs, "readSync").mockImplementation((descriptor, buffer, ...args) => {
    const count = Reflect.apply(readSync, fs, [descriptor, buffer, ...args]);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (stat.dev === identity.dev && stat.ino === identity.ino) {
      sourceBytes += count;
    }
    return count;
  });
  expect(readUpdateDatabaseGenerations([file])).toEqual(expected);
  const firstBytes = sourceBytes;
  expect(firstBytes).toBeGreaterThanOrEqual(Number(identity.size) * (age === "older" ? 1 : 4));
  sourceBytes = 0;
  expect(readUpdateDatabaseGenerations([file])).toEqual(expected);
  expect(sourceBytes).toBe(firstBytes);
});

it("invalidates removed and rewritten sidecars within the same observation", () => {
  const file = path.join(dirs.make("update-generation-sidecars-"), "state.sqlite");
  fs.writeFileSync(file, "database");
  fs.writeFileSync(file + "-wal", "before");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3000);
  const read = createSqliteFileGenerationReader();
  const before = read(file);
  fs.unlinkSync(file + "-wal");
  expect(read(file).wal).toBeUndefined();
  fs.writeFileSync(file + "-wal", "after!");
  expect(read(file).wal?.sha256).not.toBe(before.wal?.sha256);
});
