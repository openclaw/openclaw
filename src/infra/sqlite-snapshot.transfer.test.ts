import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { readCloneFileMetadata } from "@openclaw/fs-safe/copy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readMigrationArtifactIdentity,
  type MigrationArtifactVerification,
} from "./session-sqlite-migration-artifact.js";
import {
  prepareSqliteReadOnlyCopyInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
} from "./sqlite-readonly-location.js";
import { defer, deferAsync } from "./sqlite-shard-lifecycle.test-support.js";
import {
  resetSnapshotDurability,
  type SnapshotDurabilityState,
} from "./sqlite-snapshot-publication.test-support.js";
import {
  exclusiveCopyPublication,
  snapshotContent,
  useSnapshotFixture,
} from "./sqlite-snapshot.test-support.js";

const durabilityTestState = vi.hoisted<SnapshotDurabilityState>(() => ({ hashedBytes: 0 }));
vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  const { mockSnapshotDurability } = await import("./sqlite-snapshot-publication.test-support.js");
  return mockSnapshotDurability(actual, durabilityTestState);
});

import {
  prepareVerifiedSqliteFile,
  publishVerifiedSqliteFile,
  SqliteReplacementOutcomeUnknownError,
} from "./sqlite-snapshot.js";

let sourcePath: string;
let targetPath: string;
let tempDir: string;
const fixture = useSnapshotFixture({ preserveRowIds: true });
const {
  execSource,
  query,
  snapshot: snapshotWithRowIds,
  expectSnapshotFailureWithoutTarget: rejectRowIdSnapshot,
} = fixture;
beforeEach(() => {
  ({ tempDir, sourcePath, targetPath } = fixture);
});
afterEach(() => {
  resetSnapshotDurability(durabilityTestState);
  vi.restoreAllMocks();
});

function mockExclusiveCopyTransfer() {
  const transfer = exclusiveCopyPublication();
  durabilityTestState.transfer = transfer;
  return transfer;
}

function mockUnavailableBirthtime(
  mode: "zero" | "ctime",
  afterTransfer?: (stagedPath: string) => Promise<void>,
) {
  durabilityTestState.transfer = async (options, publish) => {
    const receipt = await publish(options);
    expect(receipt.method).toBe("hardlink");
    await afterTransfer?.(options.targetPath);
    return receipt;
  };
  const substituteBirthtime = (stat: Stats) => {
    // Model ctime advancing when the source link is retired, even on coarse clocks.
    stat.birthtimeMs = mode === "zero" ? 0 : stat.ctimeMs + (stat.nlink === 1 ? 1_000 : 0);
    return stat;
  };
  const fstat = fsSync.fstatSync.bind(fsSync);
  vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) =>
    args[1]?.bigint ? fstat(args[0], { bigint: true }) : substituteBirthtime(fstat(args[0])),
  );
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) =>
    args[1]?.bigint
      ? await lstat(args[0], { bigint: true })
      : substituteBirthtime(await lstat(args[0])),
  );
}

describe("owned image transfer", () => {
  beforeEach(() => {
    durabilityTestState.measure = true;
  });
  it("publishes a snapshot in a deeply nested destination", async () => {
    let directory = tempDir;
    while (Buffer.byteLength(directory) < 431) {
      directory = path.join(
        directory,
        "nested".padEnd(Math.min(60, 430 - Buffer.byteLength(directory)), "x"),
      );
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, "snapshot.sqlite");
    execSource(
      "CREATE TABLE records(value TEXT); INSERT INTO records(rowid,value) VALUES(71,'retained');",
    );
    const original = await fs.readFile(sourcePath);
    await snapshotWithRowIds({ targetPath: destination });
    {
      using database = openNodeSqliteDatabase(destination, { readOnly: true });
      expect(database.prepare("SELECT rowid,value FROM records").all()).toEqual([
        { rowid: 71, value: "retained" },
      ]);
    }
    expect(await fs.readFile(sourcePath)).toEqual(original);
    expect(await fs.readdir(directory)).toEqual(["snapshot.sqlite"]);
  });

  it.each(["native", "isolated", "copy", "zero", "ctime"] as const)(
    "publishes one owned private image (%s)",
    async (mode) => {
      if (mode === "zero" || mode === "ctime") {
        mockUnavailableBirthtime(mode);
      }
      const copy = mode === "copy" ? mockExclusiveCopyTransfer() : undefined;
      execSource(
        "CREATE TABLE records(value TEXT, payload BLOB); INSERT INTO records(rowid,value,payload) VALUES(71,'retained',zeroblob(131072));",
      );
      const original = await fs.readFile(sourcePath);
      let preparedBytes: Buffer | undefined;
      const receipt = await snapshotWithRowIds({
        sourceAcquisition:
          mode === "isolated" ? { mode: "isolated-process", stagingRoot: tempDir } : undefined,
        beforePublish: async () => {
          const images: string[] = [];
          for (const entry of await fs.readdir(tempDir, { recursive: true, withFileTypes: true })) {
            const file = path.join(entry.parentPath, entry.name);
            if (
              entry.isFile() &&
              file !== sourcePath &&
              (await fs.stat(file)).size >= original.length
            ) {
              images.push(file);
            }
          }
          expect(images).toHaveLength(1);
          preparedBytes = await fs.readFile(images[0]!);
        },
      });
      const published = await fs.readFile(targetPath);
      expect(receipt).toEqual({
        path: targetPath,
        userVersion: 0,
        ...snapshotContent(published),
      });
      // Only a distinct staged copy adds a digest pass to capture and final publication.
      expect(durabilityTestState.hashedBytes).toBe((copy ? 3 : 2) * receipt.sizeBytes);
      if (copy) {
        expect(copy).toHaveBeenCalledOnce();
      }
      expect((await fs.readdir(tempDir)).toSorted()).toEqual(["snapshot.sqlite", "source.sqlite"]);
      expect(await fs.readFile(targetPath)).toEqual(preparedBytes);
      expect(await fs.readFile(sourcePath)).toEqual(original);
      expect(query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(query("SELECT rowid,value,length(payload) AS bytes FROM records")).toEqual([
        { rowid: 71, value: "retained", bytes: 131072 },
      ]);
    },
  );

  it("keeps a caller-owned source independent of its published image", async () => {
    execSource("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('before');");
    const original = await fs.readFile(sourcePath);
    await publishVerifiedSqliteFile({
      sourcePath,
      sourceIdentity: await fs.stat(sourcePath, { bigint: true }),
      targetPath,
      expectedContent: snapshotContent(original),
      beforePublish: () => execSource("UPDATE records SET value='after';"),
    });
    expect(await fs.readFile(targetPath)).toEqual(original);
    expect(query("SELECT value FROM records", sourcePath)).toEqual([{ value: "after" }]);
  });

  it("does not bind an earlier publication hash to metadata changed by its final callback", async () => {
    const original = await fs.readFile(sourcePath);
    const verification: MigrationArtifactVerification = new Map();
    await publishVerifiedSqliteFile({
      sourcePath,
      sourceIdentity: await fs.stat(sourcePath, { bigint: true }),
      targetPath,
      expectedContent: snapshotContent(original),
      afterPublish: (guard) => {
        const verified = guard.assertTargetUnchanged(() => {
          fsSync.utimesSync(targetPath, 1_700_000_000, 1_700_000_000);
        });
        verification.set(`${verified.stat.dev}:${verified.stat.ino}`, verified);
      },
    });
    let readBytes = 0;
    const read = fsSync.readSync;
    using _ = vi
      .spyOn(fsSync, "readSync")
      .mockImplementation((...args: Parameters<typeof read>) => {
        const count = read(...args);
        readBytes += count;
        return count;
      });
    const identity = readMigrationArtifactIdentity(targetPath, 1n, undefined, verification);
    expect(identity).toMatchObject({
      sha256: snapshotContent(original).sha256,
      size: original.length,
    });
    expect(readBytes).toBe(original.length);
  });

  it("rejects same-size byte changes during a ctime-fallback transfer", async () => {
    execSource("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('retained');");
    const original = await fs.readFile(sourcePath);
    mockUnavailableBirthtime("ctime", async (stagedPath) => {
      const bytes = await fs.readFile(stagedPath);
      const offset = bytes.indexOf("retained");
      expect(offset).toBeGreaterThanOrEqual(0);
      bytes.write("modified", offset, "utf8");
      await fs.writeFile(stagedPath, bytes);
    });
    await rejectRowIdSnapshot(/hash mismatch/);
    expect(await fs.readFile(sourcePath)).toEqual(original);
  });

  it.each(["allocation", "durability", "dev", "ino"] as const)(
    "refuses a failed private transfer (%s) without changing its source",
    async (failure) => {
      const original = await fs.readFile(sourcePath);
      const identityFailure = failure === "dev" || failure === "ino";
      let transferredSource: string | undefined;
      durabilityTestState.transfer = async (options, publish) => {
        if (failure === "allocation") {
          throw Object.assign(new Error("private image transfer out of space"), { code: "ENOSPC" });
        }
        const receipt = await publish(options);
        if (failure === "durability") {
          return { ...receipt, directorySync: { status: "unsupported", code: "ENOTSUP" } };
        }
        transferredSource = options.sourcePath;
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        return receipt;
      };
      if (identityFailure) {
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
          const stat = lstat(...args);
          if (stat && String(args[0]) === transferredSource && typeof stat.dev === "bigint") {
            Object.defineProperty(stat, failure, { value: 0n });
          }
          return stat;
        });
      }
      await rejectRowIdSnapshot(
        identityFailure
          ? /source changed during transfer/
          : failure === "allocation"
            ? /out of space/
            : /staging transfer directory/,
      );
      expect(await fs.readFile(sourcePath)).toEqual(original);
      if (identityFailure) {
        expect(transferredSource).toBeDefined();
      } else {
        expect(await fs.readdir(tempDir)).toEqual(["source.sqlite"]);
      }
    },
  );
});

describe("copy-on-write independence", () => {
  async function expectIndependent(paths: string[], mode: "auto" | "off") {
    const stats = await Promise.all(paths.map((file) => fs.stat(file)));
    expect(new Set(stats.map((stat) => stat.ino)).size).toBe(paths.length);
    expect(stats.map((stat) => stat.nlink)).toEqual(paths.map(() => 1));
    const metadata = await readCloneFileMetadata(paths);
    // APFS exposes extent sharing; other filesystems still prove inode independence.
    if (metadata[0]) {
      const ids = metadata.map((entry) => entry?.cloneId);
      const required = paths.length === 2 ? ids.slice(1) : ids;
      expect(required.every((id) => id !== undefined && id !== 0n)).toBe(true);
      expect(new Set(ids).size).toBe(mode === "auto" ? 1 : paths.length);
    }
  }

  let bytes: Buffer;
  beforeEach(async () => {
    execSource("CREATE TABLE payload(value BLOB); PRAGMA user_version=7;");
    {
      using database = new DatabaseSync(sourcePath);
      database
        .prepare("INSERT INTO payload(rowid,value) VALUES(71,?)")
        .run(Buffer.alloc(131071, 42));
    }
    bytes = await fs.readFile(sourcePath);
  });

  it.each(["auto", "off"] as const)(
    "keeps synchronous snapshots independent (%s)",
    async (mode) => {
      const previous = getFsSafeNativeConfig();
      using restore = defer(() => configureFsSafeNative(previous));
      configureFsSafeNative({ mode });
      const prepared = prepareSqliteReadOnlyLocationSyncInProcess(sourcePath, tempDir);
      restore[Symbol.dispose]();
      {
        using _ = defer(() => {
          expect(prepared.cleanup()).toBe(true);
        });
        expect(await fs.readFile(prepared.location)).toEqual(bytes);
        await expectIndependent([sourcePath, prepared.location], mode);
        execSource("DELETE FROM payload", prepared.location);
        expect(query("PRAGMA integrity_check", prepared.location)).toEqual([
          { integrity_check: "ok" },
        ]);
        expect(await fs.readFile(sourcePath)).toEqual(bytes);
      }
      expect(await fs.readdir(tempDir)).toEqual(["source.sqlite"]);
    },
  );

  it.each(["auto", "off"] as const)(
    "preserves independent recovery generations (%s)",
    async (mode) => {
      const content = snapshotContent(bytes);
      const paths = ["source", "original", "transaction"].map((name) =>
        path.join(tempDir, `${name}.sqlite`),
      );
      {
        const previous = getFsSafeNativeConfig();
        using _ = defer(() => configureFsSafeNative(previous));
        configureFsSafeNative({ mode });
        for (const destination of paths.slice(1)) {
          const receipt = await snapshotWithRowIds({
            targetPath: destination,
            sourceAcquisition: {
              mode: "isolated-process",
              stagingRoot: tempDir,
              preserveSourceArtifacts: true,
            },
          });
          expect(receipt).toMatchObject({ ...content, userVersion: 7 });
        }
        const restored = path.join(tempDir, "restored.sqlite");
        await publishVerifiedSqliteFile({
          sourcePath: paths[1]!,
          sourceIdentity: await fs.stat(paths[1]!, { bigint: true }),
          targetPath: restored,
          expectedContent: content,
          requireAtomicPublication: true,
        });
        paths.push(restored);
      }
      await expectIndependent(paths, mode);
      expect(query("SELECT rowid, length(value) AS bytes FROM payload", paths[3]!)).toEqual([
        { rowid: 71, bytes: 131071 },
      ]);
      execSource("UPDATE payload SET value='restored-write' WHERE rowid=71;", paths[3]!);
      execSource("DELETE FROM payload;");
      for (const retained of paths.slice(1, 3)) {
        expect(await fs.readFile(retained)).toEqual(bytes);
      }
      await fs.unlink(paths[2]!);
      expect(await fs.readFile(paths[1]!)).toEqual(bytes);
      expect(query("SELECT value FROM payload", paths[3]!)).toEqual([{ value: "restored-write" }]);
      expect(query("PRAGMA integrity_check", paths[3]!)).toEqual([{ integrity_check: "ok" }]);
      expect((await fs.readdir(tempDir)).toSorted()).toEqual(
        ["original", "restored", "source"].map((name) => `${name}.sqlite`),
      );
    },
  );

  it.each(["empty WAL", "source alias"])(
    "keeps an independent raw copy with %s",
    async (layout) => {
      const alias = path.join(tempDir, "source-alias.sqlite");
      if (layout === "empty WAL") {
        execSource("PRAGMA journal_mode=WAL");
        await fs.writeFile(`${sourcePath}-wal`, "");
      } else {
        await fs.link(sourcePath, alias);
      }
      const sourceBytes = await fs.readFile(sourcePath);
      const prepared = await prepareSqliteReadOnlyCopyInProcess(sourcePath, tempDir);
      {
        await using _ = deferAsync(async () => {
          expect(await prepared.cleanupAsync()).toBe(true);
        });
        expect(await fs.readFile(prepared.location)).toEqual(sourceBytes);
        const output = await fs.stat(prepared.location);
        expect(output.nlink).toBe(1);
        expect(output.ino).not.toBe((await fs.stat(sourcePath)).ino);
        if (layout === "empty WAL") {
          expect((await fs.stat(`${prepared.location}-wal`)).size).toBe(0);
          const metadata = await readCloneFileMetadata([sourcePath, prepared.location]);
          if (metadata[0]) {
            expect(metadata[1]?.cloneId).toBe(metadata[0].cloneId);
          }
        } else {
          execSource("DELETE FROM payload", prepared.location);
          expect(query("SELECT count(*) count FROM payload", prepared.location)).toEqual([
            { count: 0 },
          ]);
          expect(await fs.readFile(alias)).toEqual(sourceBytes);
        }
        expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
      }
      expect(await fs.readFile(sourcePath)).toEqual(sourceBytes);
      if (layout === "empty WAL") {
        expect((await fs.stat(`${sourcePath}-wal`)).size).toBe(0);
      }
      expect((await fs.readdir(tempDir)).toSorted()).toEqual(
        layout === "empty WAL"
          ? ["source.sqlite", "source.sqlite-wal"]
          : ["source-alias.sqlite", "source.sqlite"],
      );
    },
  );
});

describe("atomic replacement", () => {
  async function replacementFixture() {
    for (const [file, value] of [
      [sourcePath, "new"],
      [targetPath, "old"],
    ]) {
      using database = new DatabaseSync(file!);
      database.exec(`CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('${value}');`);
    }
    const original = await fs.readFile(targetPath);
    const source = await fs.readFile(sourcePath);
    const options = {
      sourcePath,
      sourceIdentity: await fs.lstat(sourcePath, { bigint: true }),
      targetPath,
      expectedContent: snapshotContent(source),
      replaceExisting: {
        expectedIdentity: await fs.lstat(targetPath, { bigint: true }),
        expectedContent: snapshotContent(original),
        assertCustody: () => {},
      },
    };
    return { original, source, options };
  }

  it.skipIf(process.platform === "win32").each(["prepared", "direct"] as const)(
    "replaces SQLite atomically with verified %s bytes and receipt",
    async (mode) => {
      const { original, source, options } = await replacementFixture();
      let receipt;
      if (mode === "prepared") {
        const prepared = await prepareVerifiedSqliteFile(options);
        expect(await fs.readFile(options.targetPath)).toEqual(original);
        expect((await fs.stat(prepared.path)).dev).toBe((await fs.stat(options.targetPath)).dev);
        receipt = await prepared.publish();
        await prepared.cleanup();
      } else {
        receipt = await publishVerifiedSqliteFile(options);
      }
      expect(receipt).toMatchObject({ targetPath: options.targetPath, ...snapshotContent(source) });
      expect(await fs.readFile(options.targetPath)).toEqual(source);
      expect(await fs.readFile(options.sourcePath)).toEqual(source);
      using database = new DatabaseSync(options.targetPath, { readOnly: true });
      expect(database.prepare("SELECT value FROM records").all()).toEqual([{ value: "new" }]);
    },
  );

  it
    .skipIf(process.platform === "win32")
    .each([
      "custody",
      "identity",
      "content",
      "rename-before",
      "rename-after",
      "unsupported",
      "sync-after",
    ] as const)("retains recovery evidence after %s failure", async (kind) => {
    const { original, source, options } = await replacementFixture();
    const prepared = await prepareVerifiedSqliteFile(options);
    await using _ = deferAsync(() => prepared.cleanup());
    if (kind === "custody") {
      options.replaceExisting.assertCustody = () => {
        throw new Error("custody lost");
      };
    } else if (kind === "identity") {
      await fs.rename(options.targetPath, `${options.targetPath}.original`);
      await fs.writeFile(options.targetPath, original);
    } else if (kind === "content") {
      await fs.writeFile(options.targetPath, Buffer.alloc(original.length, 42));
    } else if (kind.startsWith("rename-")) {
      const rename = fsSync.renameSync;
      vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
        if (String(to) !== options.targetPath) {
          return rename(from, to);
        }
        if (kind === "rename-after") {
          rename(from, to);
        }
        throw new Error("injected rename failure");
      });
    } else {
      const sync = vi.fn(durabilityTestState.originalSync);
      durabilityTestState.sync = sync;
      if (kind === "unsupported") {
        sync.mockResolvedValueOnce({ status: "unsupported", code: "ENOTSUP" });
      } else {
        sync
          .mockResolvedValueOnce({ status: "synced" })
          .mockRejectedValueOnce(new Error("fsync failed"));
      }
    }
    const retained = await fs.readFile(options.targetPath);
    const attempt = prepared.publish();
    const uncertain = kind.startsWith("rename-") || kind === "sync-after";
    await expect(attempt).rejects.toThrow(
      uncertain
        ? SqliteReplacementOutcomeUnknownError
        : kind === "unsupported"
          ? "requires directory synchronization"
          : undefined,
    );
    if (kind.startsWith("rename-")) {
      await expect(attempt).rejects.toMatchObject({
        receipt: { targetPath: options.targetPath, ...snapshotContent(source) },
      });
    }
    expect(await fs.readFile(options.targetPath)).toEqual(
      kind === "rename-after" || kind === "sync-after" ? source : retained,
    );
    if (["custody", "identity", "content"].includes(kind)) {
      expect(await fs.readFile(prepared.path)).toEqual(await fs.readFile(options.sourcePath));
    }
  });

  it.skipIf(process.platform === "win32")(
    "retains new bytes after uncertain verification",
    async () => {
      const { source, options } = await replacementFixture();
      await expect(
        publishVerifiedSqliteFile({
          ...options,
          afterPublish: () => {
            throw new Error("late verification failure");
          },
        }),
      ).rejects.toBeInstanceOf(SqliteReplacementOutcomeUnknownError);
      expect(await fs.readFile(options.targetPath)).toEqual(source);
    },
  );

  it("leaves the absent-target mode exclusive", async () => {
    const { original, options } = await replacementFixture();
    await expect(
      publishVerifiedSqliteFile({ ...options, replaceExisting: undefined }),
    ).rejects.toThrow("already exists");
    expect(await fs.readFile(options.targetPath)).toEqual(original);
    await fs.unlink(options.targetPath);
    expect(
      await publishVerifiedSqliteFile({ ...options, replaceExisting: undefined }),
    ).toBeUndefined();
  });
});
