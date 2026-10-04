import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
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
      if (process.platform === "linux") {
        stat.birthtimeNs = stat.ctimeNs;
      }
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
