import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  inspectSqliteSchemaHeaderInProcess,
  prepareSqliteReadOnlyCopyInProcess,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import { MAX_SNAPSHOT_ATTEMPTS } from "./sqlite-snapshot-policy.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

const MIB = 1024 * 1024;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
    vi.restoreAllMocks();
    cleanup();
  });
});

function createFixture(bytes: Buffer) {
  const sourceRoot = tempDirs.make("openclaw-readonly-copy-source-");
  const sourcePath = path.join(sourceRoot, "source.sqlite");
  const stagingRoot = tempDirs.make("openclaw-readonly-copy-staging-");
  fs.writeFileSync(sourcePath, bytes, { mode: 0o600 });
  return { sourcePath, sourceRoot, stagingRoot };
}

function patternedBytes(size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function expectSnapshot(
  fixture: ReturnType<typeof createFixture>,
  expected: Buffer,
  inspect?: (location: string) => void,
): void {
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSyncInProcess> | undefined;
  try {
    prepared = prepareSqliteReadOnlyLocationSyncInProcess(fixture.sourcePath, fixture.stagingRoot);
    expect(fs.readFileSync(prepared.location).equals(expected)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(prepared.location).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(prepared.location)).mode & 0o777).toBe(0o700);
    }
    inspect?.(prepared.location);
  } finally {
    if (prepared) {
      expect(prepared.cleanup()).toBe(true);
      expect(fs.readFileSync(fixture.sourcePath).equals(expected)).toBe(true);
    }
    expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
  }
}

function afterFirstCopy(operation: () => void): () => boolean {
  const fsync = fs.fsyncSync.bind(fs);
  let injected = false;
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    fsync(descriptor);
    if (!injected) {
      injected = true;
      operation();
    }
  });
  return () => injected;
}

function createWalActivationFixture() {
  const fixture = createFixture(Buffer.alloc(0));
  const sqlite = requireNodeSqlite();
  const seed = new sqlite.DatabaseSync(fixture.sourcePath);
  seed.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=7;");
  seed.close();
  const activatedPath = path.join(fixture.sourceRoot, "activated.sqlite");
  const activated = new sqlite.DatabaseSync(activatedPath);
  activated.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=8;");
  const family = ["", "-wal", "-shm"].map((suffix) => ({
    suffix,
    bytes: fs.readFileSync(activatedPath + suffix),
  }));
  activated.close();
  const injected = afterFirstCopy(() => {
    for (const { suffix, bytes } of family) {
      fs.writeFileSync(fixture.sourcePath + suffix, bytes);
    }
  });
  return { family, fixture, injected };
}

function afterPrivateCopy(stagingRoot: string, operation: (pathname: string) => void): void {
  const open = fs.openSync.bind(fs);
  const close = fs.closeSync.bind(fs);
  const fsync = fs.fsyncSync.bind(fs);
  const targets = new Map<number, string>();
  vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
    const descriptor = open(pathname, flags, mode);
    const resolved = path.resolve(String(pathname));
    if (resolved.startsWith(`${stagingRoot}${path.sep}`) && flags === "wx") {
      targets.set(descriptor, resolved);
    }
    return descriptor;
  });
  vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
    try {
      close(descriptor);
    } finally {
      targets.delete(descriptor);
    }
  });
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    fsync(descriptor);
    const target = targets.get(descriptor);
    if (target) {
      operation(target);
    }
  });
}

function snapshotSqliteFamily(pathname: string) {
  return ["", "-wal", "-shm", "-journal"].flatMap((suffix) => {
    const file = pathname + suffix;
    return fs.existsSync(file)
      ? [{ suffix, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }]
      : [];
  });
}

function interceptSourceReads(
  sourcePath: string,
  operation: (
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    options: fs.ReadOptions,
  ) => number,
): void {
  const source = fs.statSync(sourcePath, { bigint: true });
  const read = fs.readSync.bind(fs);
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
      const opened = fs.fstatSync(descriptor, { bigint: true });
      return opened.dev === source.dev && opened.ino === source.ino
        ? operation(descriptor, buffer, options)
        : read(descriptor, buffer, options);
    },
  );
}

describe("stable read-only snapshot copies", () => {
  it("rechecks journal state when an inactive WAL family gains sidecars during schema inspection", async () => {
    const { family, fixture, injected } = createWalActivationFixture();

    await expect(
      inspectSqliteSchemaHeaderInProcess(fixture.sourcePath, fixture.stagingRoot),
    ).resolves.toMatchObject({ userVersion: 8 });
    expect(injected()).toBe(true);
    expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
    for (const { suffix, bytes } of family.filter((file) => file.suffix !== "-shm")) {
      expect(fs.readFileSync(fixture.sourcePath + suffix)).toEqual(bytes);
    }
  });

  it.each(["raw-copy", "online-backup"] as const)(
    "does not retry %s when preparation and cleanup both fail",
    async (mode) => {
      const fixture =
        mode === "raw-copy" ? createWalActivationFixture().fixture : createFixture(Buffer.alloc(0));
      if (mode === "online-backup") {
        const seed = new (requireNodeSqlite().DatabaseSync)(fixture.sourcePath);
        seed.exec("CREATE TABLE probe (value TEXT);");
        seed.close();
        const open = fs.openSync.bind(fs);
        const fsync = fs.fsyncSync.bind(fs);
        const snapshotDescriptors = new Set<number>();
        vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, permissions) => {
          const descriptor = open(pathname, flags, permissions);
          if (
            flags === "r+" &&
            path.resolve(String(pathname)).startsWith(`${fixture.stagingRoot}${path.sep}`)
          ) {
            snapshotDescriptors.add(descriptor);
          }
          return descriptor;
        });
        vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
          if (snapshotDescriptors.has(descriptor)) {
            throw Object.assign(new Error("SQLite destination is read-only"), { errcode: 8 });
          }
          fsync(descriptor);
        });
      }
      const allocations = vi.spyOn(fs, "mkdtempSync");
      const cleanupError = Object.assign(new Error("snapshot cleanup denied"), { code: "EACCES" });
      vi.spyOn(fs.promises, "rm").mockImplementation(async () => {
        if (mode === "online-backup") {
          fs.renameSync(fixture.sourcePath, `${fixture.sourcePath}.replaced`);
        }
        throw cleanupError;
      });
      const prepare =
        mode === "raw-copy"
          ? inspectSqliteSchemaHeaderInProcess
          : prepareSqliteReadOnlyLocationInProcess;
      const error = await prepare(fixture.sourcePath, fixture.stagingRoot).catch(
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        message: expect.stringContaining(
          mode === "raw-copy"
            ? "SQLite journal state changed while copying"
            : "SQLite destination is read-only",
        ),
      });
      if (!(error instanceof AggregateError)) {
        throw new Error("Expected aggregated cleanup failure", { cause: error });
      }
      expect(error.errors).toContain(cleanupError);
      expect(allocations).toHaveBeenCalledTimes(1);
    },
  );

  it.each([512])("preserves a malformed catalog beside a cold %i-byte journal", (bytes) => {
    const fixture = createFixture(Buffer.alloc(0));
    const sqlite = requireNodeSqlite();
    const seed = new sqlite.DatabaseSync(fixture.sourcePath);
    const family = new Map<string, Buffer>();
    try {
      seed.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE probe (value TEXT);
        CREATE INDEX probe_index ON probe(value);
        INSERT INTO probe VALUES ('preserved');
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
      seed.enableDefensive?.(false);
      seed.exec(`
        PRAGMA writable_schema = ON;
        UPDATE sqlite_schema SET sql = 'CREATE INDEX probe_index ON probe(missing_column)'
          WHERE name = 'probe_index';
      `);
      for (const suffix of ["", "-wal"]) {
        family.set(suffix, fs.readFileSync(fixture.sourcePath + suffix));
      }
    } finally {
      seed.close();
    }
    family.set("-journal", Buffer.alloc(bytes));
    for (const [suffix, content] of family) {
      fs.writeFileSync(fixture.sourcePath + suffix, content);
    }
    const before = snapshotSqliteFamily(fixture.sourcePath);
    const prepared = prepareSqliteReadOnlyLocationSyncInProcess(
      fixture.sourcePath,
      fixture.stagingRoot,
    );
    try {
      // The consumer, not snapshot preparation, owns catalog diagnostics and repair.
      const snapshot = new sqlite.DatabaseSync(prepared.location);
      try {
        expect(() => snapshot.prepare("SELECT * FROM probe")).toThrow(/malformed database schema/u);
        snapshot.enableDefensive?.(false);
        snapshot.exec(`
          PRAGMA writable_schema = ON;
          UPDATE sqlite_schema SET sql = 'CREATE INDEX probe_index ON probe(value)'
            WHERE name = 'probe_index';
          PRAGMA writable_schema = RESET;
        `);
        expect(snapshot.prepare("SELECT value FROM probe").all()).toEqual([{ value: "preserved" }]);
      } finally {
        snapshot.close();
      }
      expect(snapshotSqliteFamily(fixture.sourcePath)).toEqual(before);
    } finally {
      expect(prepared.cleanup()).toBe(true);
      expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
    }
  });

  it("captures a bounded committed WAL prefix while later commits append", () => {
    const prepare = prepareSqliteReadOnlyLocationSyncInProcess;
    const fixture = createFixture(Buffer.alloc(0));
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(fixture.sourcePath);
    let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSyncInProcess> | undefined;
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE entries (value TEXT);
        CREATE TABLE payload (data BLOB);
        PRAGMA wal_checkpoint(TRUNCATE);
        INSERT INTO entries VALUES ('before-copy');
        INSERT INTO payload VALUES (zeroblob(${MIB + 37}));
      `);
      const walPath = `${fixture.sourcePath}-wal`;
      const capturedWalBytes = fs.statSync(walPath).size;
      const insert = writer.prepare("INSERT INTO entries VALUES (?)");
      const open = fs.openSync.bind(fs);
      const close = fs.closeSync.bind(fs);
      const read = fs.readSync.bind(fs);
      const fsync = fs.fsyncSync.bind(fs);
      const sourceWal = fs.statSync(walPath, { bigint: true });
      const copiedWalReaders = new Set<number>();
      const copiedWalWriters = new Set<number>();
      const shortReads = { source: 0, copy: 0 };
      let appendedDuringCopy = false;
      let appendedAfterCopy = 0;
      let sourceAfterWrites = snapshotSqliteFamily(fixture.sourcePath);
      vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
        const descriptor = open(pathname, flags, mode);
        const resolved = path.resolve(String(pathname));
        if (resolved.startsWith(`${fixture.stagingRoot}${path.sep}`) && resolved.endsWith("-wal")) {
          if (flags === "r") {
            copiedWalReaders.add(descriptor);
          } else if (flags === "wx") {
            copiedWalWriters.add(descriptor);
          }
        }
        return descriptor;
      });
      vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
        close(descriptor);
        copiedWalReaders.delete(descriptor);
        copiedWalWriters.delete(descriptor);
      });
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
          const opened = fs.fstatSync(descriptor, { bigint: true });
          const source = opened.dev === sourceWal.dev && opened.ino === sourceWal.ino;
          const compared = copiedWalReaders.has(descriptor)
            ? "copy"
            : source && copiedWalReaders.size > 0
              ? "source"
              : undefined;
          const requested = options.length ?? buffer.byteLength - (options.offset ?? 0);
          const maxBytes = compared === "source" ? 8191 : 4093;
          if (compared && requested > maxBytes) {
            shortReads[compared] += 1;
          }
          const bytesRead = read(descriptor, buffer, {
            ...options,
            length: compared ? Math.min(requested, maxBytes) : requested,
          });
          if (source && !appendedDuringCopy && requested > 32 && bytesRead > 0) {
            appendedDuringCopy = true;
            insert.run("during-copy");
            sourceAfterWrites = snapshotSqliteFamily(fixture.sourcePath);
          }
          return bytesRead;
        },
      );
      vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
        fsync(descriptor);
        if (copiedWalWriters.has(descriptor)) {
          insert.run(`after-copy-${++appendedAfterCopy}`);
          sourceAfterWrites = snapshotSqliteFamily(fixture.sourcePath);
        }
      });

      prepared = prepare(fixture.sourcePath, fixture.stagingRoot);
      expect(appendedDuringCopy).toBe(true);
      expect(appendedAfterCopy).toBeGreaterThan(0);
      expect(shortReads.source).toBeGreaterThan(0);
      expect(shortReads.copy).toBeGreaterThan(0);
      expect(copiedWalReaders.size).toBe(0);
      expect(copiedWalWriters.size).toBe(0);
      expect(fs.statSync(`${prepared.location}-wal`).size).toBe(capturedWalBytes);
      expect(fs.statSync(walPath).size).toBeGreaterThan(capturedWalBytes);
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      try {
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        expect(snapshot.prepare("SELECT value FROM entries").all()).toEqual([
          { value: "before-copy" },
        ]);
        expect(snapshot.prepare("SELECT length(data) AS bytes FROM payload").get()).toEqual({
          bytes: MIB + 37,
        });
      } finally {
        snapshot.close();
      }
      expect(snapshotSqliteFamily(fixture.sourcePath)).toEqual(sourceAfterWrites);
    } finally {
      if (prepared) {
        expect(prepared.cleanup()).toBe(true);
      }
      writer.close();
      expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
    }
  });

  it("rejects a reset WAL paired with checkpoint-restored main bytes during native copying", async () => {
    const prepare = prepareSqliteReadOnlyCopyInProcess;
    const fixture = createFixture(Buffer.alloc(0));
    const sqlite = requireNodeSqlite();
    const writer = new sqlite.DatabaseSync(fixture.sourcePath);
    let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSyncInProcess> | undefined;
    try {
      writer.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE left_value (value TEXT);
        CREATE TABLE right_value (value TEXT);
        INSERT INTO left_value VALUES ('A');
        INSERT INTO right_value VALUES ('A');
        PRAGMA wal_checkpoint(PASSIVE);
      `);
      const mainBefore = fs.readFileSync(fixture.sourcePath);
      let reset = false;
      let restored = false;
      let sourceAfterWrites = snapshotSqliteFamily(fixture.sourcePath);
      const afterCopy = (target: string) => {
        if (!reset && target.endsWith(".partial")) {
          reset = true;
          writer.exec(`
            UPDATE left_value SET value = 'B';
            PRAGMA wal_checkpoint(TRUNCATE);
            UPDATE right_value SET value = 'C';
          `);
        } else if (reset && !restored && target.endsWith("-wal")) {
          restored = true;
          const copiedWal = fs.readFileSync(target);
          // Restore both pages in one commit: A/C must never be a committed state.
          writer.exec(`
            BEGIN IMMEDIATE;
            UPDATE left_value SET value = 'A';
            UPDATE right_value SET value = 'A';
            COMMIT;
            PRAGMA wal_checkpoint(PASSIVE);
          `);
          expect(fs.readFileSync(fixture.sourcePath)).toEqual(mainBefore);
          expect(
            fs.readFileSync(`${fixture.sourcePath}-wal`).subarray(0, copiedWal.length),
          ).toEqual(copiedWal);
          sourceAfterWrites = snapshotSqliteFamily(fixture.sourcePath);
        }
      };
      afterPrivateCopy(fixture.stagingRoot, afterCopy);
      __setFsSafeTestHooksForTest({
        beforeRootStatObservation: (pathname) => {
          if (pathname === fixture.sourceRoot) {
            afterCopy("database.sqlite.partial");
          }
        },
      });

      prepared = await prepare(fixture.sourcePath, fixture.stagingRoot);
      expect(reset).toBe(true);
      expect(restored).toBe(true);
      const snapshot = new sqlite.DatabaseSync(prepared.location, { readOnly: true });
      try {
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        expect(
          snapshot
            .prepare(
              "SELECT left_value.value AS left_value, right_value.value AS right_value FROM left_value CROSS JOIN right_value",
            )
            .get(),
        ).toEqual({ left_value: "A", right_value: "A" });
      } finally {
        snapshot.close();
      }
      expect(snapshotSqliteFamily(fixture.sourcePath)).toEqual(sourceAfterWrites);
    } finally {
      if (prepared) {
        expect(prepared.cleanup()).toBe(true);
      }
      writer.close();
      expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
    }
  });

  it.each(["source replacement", "cancel", "io-error"])(
    "cleans incomplete snapshots and bounds retries after %s",
    async (failure) => {
      const fixture = createFixture(Buffer.alloc(0));
      const controller = new AbortController();
      const error = Object.assign(new Error("inspection terminated"), { code: "EIO" });
      let copies = 0;
      __setFsSafeTestHooksForTest({
        beforeRootStatObservation: (pathname) => {
          if (pathname !== fixture.sourceRoot) {
            return;
          }
          copies += 1;
          if (failure === "io-error") {
            throw error;
          }
          if (failure === "cancel") {
            controller.abort(error);
          }
          fs.renameSync(fixture.sourcePath, `${fixture.sourcePath}.displaced-${copies}`);
          fs.writeFileSync(fixture.sourcePath, "");
        },
      });
      const result = prepareSqliteReadOnlyLocationInProcess(
        fixture.sourcePath,
        fixture.stagingRoot,
        controller.signal,
      );
      if (failure === "cancel") {
        await expect(result).rejects.toBe(error);
      } else {
        await expect(result).rejects.toThrow(
          failure === "io-error" ? /EIO/u : "SQLite source changed while copying",
        );
      }
      expect(copies).toBe(failure === "source replacement" ? MAX_SNAPSHOT_ATTEMPTS : 1);
      expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
    },
  );

  it.each(["overwrite", "transient missing pathname"] as const)(
    "retries a source after %s until it stabilizes",
    (change) => {
      const bytes = patternedBytes(change === "overwrite" ? MIB : 4099);
      const fixture = createFixture(bytes);
      if (change === "overwrite") {
        const after = Buffer.from(bytes);
        after.writeUInt8(after.readUInt8(after.length - 1) ^ 0xff, after.length - 1);
        const injected = afterFirstCopy(() => fs.writeFileSync(fixture.sourcePath, after));
        expectSnapshot(fixture, after);
        expect(injected()).toBe(true);
      } else {
        const open = fs.openSync.bind(fs);
        const canonicalPath = fs.realpathSync.native(fixture.sourcePath);
        let elapsedMs = 0;
        let changes = 0;
        vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
          elapsedMs += timeout ?? 0;
          return "timed-out";
        });
        vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
          if (String(pathname) === canonicalPath && elapsedMs < 30) {
            changes += 1;
            throw Object.assign(new Error("source replacement in progress"), { code: "ENOENT" });
          }
          return open(pathname, flags, mode);
        });
        expectSnapshot(fixture, bytes);
        expect(changes).toBeGreaterThan(0);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "retries pathname replacement while the second pass still reads the original inode",
    () => {
      const before = patternedBytes(MIB + 37);
      const after = Buffer.from(before);
      after.writeUInt8(after.readUInt8(0) ^ 0xff, 0);
      const fixture = createFixture(before);
      const replacementPath = path.join(fixture.sourceRoot, "replacement.sqlite");
      const displacedPath = path.join(fixture.sourceRoot, "displaced.sqlite");
      fs.writeFileSync(replacementPath, after, { mode: 0o600 });
      const firstCopied = afterFirstCopy(() => {});
      const read = fs.readSync.bind(fs);
      let replaced = false;
      interceptSourceReads(fixture.sourcePath, (descriptor, buffer, options) => {
        const bytesRead = read(descriptor, buffer, options);
        const requested = options.length ?? buffer.byteLength - (options.offset ?? 0);
        // A later header probe cannot substitute for the complete second pass.
        if (firstCopied() && !replaced && bytesRead > 0 && requested > 20) {
          replaced = true;
          fs.renameSync(fixture.sourcePath, displacedPath);
          fs.renameSync(replacementPath, fixture.sourcePath);
        }
        return bytesRead;
      });

      expectSnapshot(fixture, after);
      expect(replaced).toBe(true);
      expect(fs.readFileSync(displacedPath).equals(before)).toBe(true);
      expect(fs.readdirSync(fixture.sourceRoot).toSorted()).toEqual([
        "displaced.sqlite",
        "source.sqlite",
      ]);
    },
  );

  it("releases pinned source handles when closing the private comparison handle fails", () => {
    const bytes = patternedBytes(4099);
    const fixture = createFixture(bytes);
    const closeError = Object.assign(new Error("private comparison close failed"), { code: "EIO" });
    const owned = new Map<number, { source: boolean; privateRead: boolean }>();
    const open = fs.openSync.bind(fs);
    const close = fs.closeSync.bind(fs);
    let injected = false;
    let sourcesAtFailure: number[] = [];
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
      const descriptor = open(pathname, flags, mode);
      const resolved = path.resolve(String(pathname));
      const source = resolved === fixture.sourcePath;
      const staged = resolved.startsWith(`${fixture.stagingRoot}${path.sep}`);
      if (source || staged) {
        owned.set(descriptor, { source, privateRead: staged && flags === "r" });
      }
      return descriptor;
    });
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      const privateRead = owned.get(descriptor)?.privateRead;
      if (privateRead && !injected) {
        sourcesAtFailure = [...owned].filter(([, owner]) => owner.source).map(([fd]) => fd);
        injected = true;
        // A native close can release its descriptor before reporting an I/O error.
        close(descriptor);
        owned.delete(descriptor);
        throw closeError;
      }
      close(descriptor);
      owned.delete(descriptor);
    });

    try {
      expect(() =>
        prepareSqliteReadOnlyLocationSyncInProcess(fixture.sourcePath, fixture.stagingRoot),
      ).toThrow(closeError);
      expect(injected).toBe(true);
      for (const descriptor of sourcesAtFailure) {
        expect(() => fs.fstatSync(descriptor)).toThrowError(
          expect.objectContaining({ code: "EBADF" }),
        );
      }
    } finally {
      openSpy.mockRestore();
      closeSpy.mockRestore();
      for (const descriptor of owned.keys()) {
        close(descriptor);
      }
      expect(fs.readFileSync(fixture.sourcePath).equals(bytes)).toBe(true);
      expect(fs.readdirSync(fixture.sourceRoot)).toEqual(["source.sqlite"]);
      expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
    }
  });

  it("snapshots a fixed 16 MiB database when staging can write one complete copy", () => {
    const fixture = createFixture(Buffer.alloc(0));
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(fixture.sourcePath);
    try {
      database.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE probe (payload BLOB NOT NULL);
        INSERT INTO probe VALUES (zeroblob(${16 * MIB}));
      `);
    } finally {
      database.close();
    }
    const bytes = fs.readFileSync(fixture.sourcePath);
    const descriptors = new Set<number>();
    const open = fs.openSync.bind(fs);
    const close = fs.closeSync.bind(fs);
    const write = fs.writeSync.bind(fs);
    let written = 0;
    vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
      const descriptor = open(pathname, flags, mode);
      if (path.resolve(String(pathname)).startsWith(`${fixture.stagingRoot}${path.sep}`)) {
        descriptors.add(descriptor);
      }
      return descriptor;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      close(descriptor);
      descriptors.delete(descriptor);
    });
    vi.spyOn(fs, "writeSync").mockImplementation(
      (
        descriptor: number,
        content: string | NodeJS.ArrayBufferView,
        offset?: number | null,
        lengthOrEncoding?: number | BufferEncoding | null,
        position?: number | null,
      ) => {
        const encoding = typeof lengthOrEncoding === "string" ? lengthOrEncoding : undefined;
        const length =
          typeof content === "string"
            ? Buffer.byteLength(content, encoding)
            : typeof lengthOrEncoding === "number"
              ? lengthOrEncoding
              : content.byteLength - (offset ?? 0);
        const staged = descriptors.has(descriptor);
        if (staged && written + length > bytes.length) {
          throw Object.assign(new Error("synthetic staging capacity exhausted"), {
            code: "ENOSPC",
          });
        }
        const count =
          typeof content === "string"
            ? write(descriptor, content, offset, encoding)
            : write(descriptor, content, offset, length, position);
        if (staged) {
          written += count;
        }
        return count;
      },
    );

    expectSnapshot(fixture, bytes, (location) => {
      const snapshot = new sqlite.DatabaseSync(location, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT length(payload) AS bytes FROM probe").get()).toEqual({
          bytes: 16 * MIB,
        });
      } finally {
        snapshot.close();
      }
    });
    expect(written).toBeLessThanOrEqual(bytes.length);
    expect(descriptors.size).toBe(0);
    expect(fs.readdirSync(fixture.sourceRoot)).toEqual(["source.sqlite"]);
  });
});

it("copies the admitted source and rejects an identical successor at every observed main open", () => {
  const bytes = Buffer.alloc(4099, 42);
  const { sourcePath: source, sourceRoot, stagingRoot: staging } = createFixture(bytes);
  const replacement = path.join(sourceRoot, "replacement.sqlite");
  const archived = path.join(sourceRoot, "original.sqlite");
  fs.writeFileSync(replacement, bytes);
  const files = { source, replacement, archived, staging, bytes };
  const identity = readDatabasePathIdentitySync(files.source);
  expect(readDatabasePathIdentitySync(files.replacement).key).not.toBe(identity.key);
  const canonicalSource = fs.realpathSync.native(files.source);
  const open = fs.openSync.bind(fs);
  const close = fs.closeSync.bind(fs);
  let observedOpens = 0;
  const census = vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
    const descriptor = open(pathname, flags, mode);
    if (String(pathname) === canonicalSource) {
      observedOpens += 1;
    }
    return descriptor;
  });
  let baseline: ReturnType<typeof prepareSqliteReadOnlyLocationSyncInProcess>;
  try {
    baseline = prepareSqliteReadOnlyLocationSyncInProcess(files.source, files.staging, identity);
  } finally {
    census.mockRestore();
  }
  try {
    expect(fs.readFileSync(baseline.location)).toEqual(files.bytes);
    expect(fs.readFileSync(files.source)).toEqual(files.bytes);
    expect(readDatabasePathIdentitySync(files.source)).toEqual(identity);
  } finally {
    expect(baseline.cleanup()).toBe(true);
  }
  expect(observedOpens).toBeGreaterThanOrEqual(1);
  expect(fs.readdirSync(files.staging)).toEqual([]);

  for (let targetOpen = 1; targetOpen <= observedOpens; targetOpen += 1) {
    const label = `main descriptor ${targetOpen} of ${observedOpens}`;
    let sourceOpens = 0;
    let replacementDescriptor: number | undefined;
    let injected = false;
    // Keep the successor installed for the real descriptor's entire lifetime;
    // the original pathname identity is restored before overall acceptance.
    const opening = vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
      if (String(pathname) === canonicalSource && ++sourceOpens === targetOpen) {
        fs.renameSync(files.source, files.archived);
        fs.renameSync(files.replacement, files.source);
        injected = true;
        replacementDescriptor = open(pathname, flags, mode);
        return replacementDescriptor;
      }
      return open(pathname, flags, mode);
    });
    const closing = vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      close(descriptor);
      if (descriptor === replacementDescriptor) {
        replacementDescriptor = undefined;
        fs.renameSync(files.source, files.replacement);
        fs.renameSync(files.archived, files.source);
      }
    });
    const wait = vi.spyOn(Atomics, "wait");
    let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSyncInProcess> | undefined;
    let failure: unknown;
    try {
      try {
        prepared = prepareSqliteReadOnlyLocationSyncInProcess(
          files.source,
          files.staging,
          identity,
        );
      } catch (error) {
        failure = error;
      } finally {
        if (prepared) {
          expect(prepared.cleanup(), label).toBe(true);
        }
      }
      expect(injected, label).toBe(true);
      expect(failure, label).toBeInstanceOf(Error);
      expect(failure, label).toHaveProperty(
        "message",
        expect.stringMatching(/file identity changed/),
      );
      expect(wait, label).not.toHaveBeenCalled();
      expect(replacementDescriptor, label).toBeUndefined();
      expect(readDatabasePathIdentitySync(files.source), label).toEqual(identity);
      expect(fs.readFileSync(files.source), label).toEqual(files.bytes);
      expect(fs.readFileSync(files.replacement), label).toEqual(files.bytes);
      expect(fs.readdirSync(files.staging), label).toEqual([]);
    } finally {
      opening.mockRestore();
      closing.mockRestore();
      wait.mockRestore();
    }
  }
});
