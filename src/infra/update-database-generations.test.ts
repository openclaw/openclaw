import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "./node-sqlite.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "./sqlite-file-generation.js";
import * as readOnlyLocation from "./sqlite-readonly-location.js";
import { readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";
import { readUpdatePhysicalDatabaseGenerations } from "./update-physical-database-generations.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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

it.each(["auto", "off"] as const)(
  "retains exact closed generations and source bytes with native copying %s",
  async (mode) => {
    const previous = getFsSafeNativeConfig();
    try {
      configureFsSafeNative({ mode });
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
    } finally {
      configureFsSafeNative(previous);
    }
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
    const malformed = Buffer.from(valid);
    const offset = malformed.indexOf("CREATE TABLE receipt");
    expect(offset).toBeGreaterThan(0);
    malformed[offset + 3] = "X".charCodeAt(0);
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
    const previous = getFsSafeNativeConfig();
    try {
      configureFsSafeNative({ mode });
      await expect(readUpdatePhysicalDatabaseGenerations([file])).rejects.toThrow(
        /snapshot hash mismatch/,
      );
    } finally {
      configureFsSafeNative(previous);
    }
    expect(copied).toBe(true);
    expect(fs.readFileSync(file)).toEqual(malformed);
    expect(fs.readdirSync(staging)).toEqual([]);
  },
);

it.each(["same-size write", "truncation", "identity replacement"] as const)(
  "refuses a captured source's %s before native admission",
  async (change) => {
    const { file, staging, prepare } = generationFixture();
    const original = fs.readFileSync(file);
    const changed = Buffer.from(original);
    const offset = changed.indexOf("before");
    expect(offset).toBeGreaterThan(0);
    changed.write("after!", offset);
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

it("reads a sidecar-free private payload once while retaining four source-family passes", async () => {
  const { file, staging } = generationFixture();
  const database = new DatabaseSync(file);
  database.exec(
    "CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(2097152));",
  );
  database.close();
  const source = fs.statSync(file, { bigint: true });
  const read = fs.readSync.bind(fs);
  let sourceBytes = 0;
  let privateBytes = 0;
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
      } else if (opened.isFile() && opened.size === source.size) {
        privateBytes += count;
      }
      return count;
    },
  );
  expect((await readUpdatePhysicalDatabaseGenerations([file]))[file]).toEqual(expect.any(String));
  const size = Number(source.size);
  expect(sourceBytes).toBeGreaterThanOrEqual(4 * size);
  // A byte-copy fallback can add one source pass. Headers are bounded overhead.
  expect(sourceBytes).toBeLessThanOrEqual(5 * size + 256);
  expect(privateBytes).toBe(size);
  expect(fs.readdirSync(staging)).toEqual([]);
});

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
