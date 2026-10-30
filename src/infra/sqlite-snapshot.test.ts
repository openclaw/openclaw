import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import {
  exclusiveCopyPublication,
  useSnapshotFixture,
  type PublicationFixture,
} from "./sqlite-snapshot.test-support.js";

const durabilityTestState = vi.hoisted(() => ({
  publish: undefined as PublicationFixture | undefined,
  publicationSyncUnsupported: false,
  syncOutcome: undefined as
    | { status: "synced" }
    | { status: "unsupported"; code?: string }
    | undefined,
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    publishFileExclusive: async (...args: Parameters<typeof actual.publishFileExclusive>) => {
      if (path.basename(path.dirname(args[0].targetPath)).startsWith(".sqlite-publish-")) {
        return actual.publishFileExclusive(...args);
      }
      const published = durabilityTestState.publish
        ? await durabilityTestState.publish(args[0], actual.publishFileExclusive)
        : await actual.publishFileExclusive(...args);
      return durabilityTestState.publicationSyncUnsupported
        ? { ...published, directorySync: { status: "unsupported" as const, code: "ENOTSUP" } }
        : published;
    },
    syncDirectory: async (...args: Parameters<typeof actual.syncDirectory>) =>
      durabilityTestState.syncOutcome ?? (await actual.syncDirectory(...args)),
  };
});

import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";

function isDirectoryOpen(flags: string | number | undefined): boolean {
  return (
    flags === "r" || (typeof flags === "number" && (flags & fsSync.constants.O_DIRECTORY) !== 0)
  );
}

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  durabilityTestState.publish = undefined;
  durabilityTestState.publicationSyncUnsupported = false;
  durabilityTestState.syncOutcome = undefined;
  vi.restoreAllMocks();
});

function mockExclusiveCopyPublication(alterCopy?: (filePath: string) => Promise<void>) {
  const publish = exclusiveCopyPublication(alterCopy);
  durabilityTestState.publish = publish;
  return publish;
}

function corruptIndex(database: import("node:sqlite").DatabaseSync, column: string) {
  database.enableDefensive?.(false);
  database.exec(`PRAGMA writable_schema = ON;
    UPDATE sqlite_schema SET sql = 'CREATE INDEX records_value ON records(${column})' WHERE name = 'records_value';
    PRAGMA writable_schema = OFF;`);
  const version = Number(database.prepare("PRAGMA schema_version").get()?.schema_version);
  database.exec(`PRAGMA schema_version = ${version + 1};`);
}

function createUnsafeIndexDrift(): void {
  using database = new sqlite.DatabaseSync(sourcePath);
  database.exec(`
      CREATE TABLE records (id INTEGER PRIMARY KEY, indexed_value TEXT NOT NULL, alternate_value TEXT NOT NULL);
      CREATE INDEX records_value ON records(indexed_value);
      INSERT INTO records (indexed_value, alternate_value) VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
  `);
  corruptIndex(database, "alternate_value");
}

function createHotRollbackJournal(sqlitePath: string): void {
  {
    using database = new sqlite.DatabaseSync(sqlitePath);
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL, payload BLOB NOT NULL);
      WITH RECURSIVE rows(id) AS (
        SELECT 1
        UNION ALL
        SELECT id + 1 FROM rows WHERE id < 256
      )
      INSERT INTO records (id, value, payload)
      SELECT id, 'committed', zeroblob(8192) FROM rows;
    `);
  }
  const crashed = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(process.env.OPENCLAW_HOT_JOURNAL_PATH);
        database.exec(
          "PRAGMA journal_mode = DELETE; " +
          "PRAGMA synchronous = FULL; " +
          "PRAGMA cache_size = 2; " +
          "PRAGMA cache_spill = ON; " +
          "BEGIN IMMEDIATE; " +
          "UPDATE records SET value = 'uncommitted';"
        );
        process.kill(process.pid, "SIGKILL");
      `,
    ],
    {
      env: { ...process.env, OPENCLAW_HOT_JOURNAL_PATH: sqlitePath },
      encoding: "utf8",
    },
  );
  expect(crashed.signal, `hot rollback writer: ${crashed.status} ${crashed.stderr}`).toBe(
    "SIGKILL",
  );
  expect(fsSync.existsSync(`${sqlitePath}-journal`), "hot rollback writer left a journal").toBe(
    true,
  );
}

function appendSuperJournalPointer(journalPath: string, superJournalPath: string): void {
  const name = Buffer.from(superJournalPath, "utf8");
  const trailer = Buffer.alloc(4 + name.length + 4 + 4 + 8);
  name.copy(trailer, 4);
  trailer.writeUInt32BE(name.length, 4 + name.length);
  let checksum = 0;
  for (const byte of name) {
    checksum = (checksum + byte) >>> 0;
  }
  trailer.writeUInt32BE(checksum, 8 + name.length);
  Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]).copy(trailer, 12 + name.length);
  fsSync.appendFileSync(journalPath, trailer);
}

let sqlite: ReturnType<typeof requireNodeSqlite>;
let sourcePath: string;
let targetPath: string;
let tempDir: string;
const fixture = useSnapshotFixture();
const { execSource, query, snapshot, expectSnapshotSuccess, expectSnapshotFailureWithoutTarget } =
  fixture;
beforeEach(() => {
  ({ tempDir, sourcePath, targetPath } = fixture);
  sqlite = requireNodeSqlite();
});

type SnapshotOptions = Parameters<typeof createVerifiedSqliteSnapshot>[0];

async function expectPreservedTarget(
  pattern: RegExp,
  options: Partial<SnapshotOptions> = {},
  content = "racer",
) {
  await expect(snapshot(options)).rejects.toThrow(pattern);
  await expect(fs.readFile(targetPath, "utf8")).resolves.toBe(content);
}

function interceptOpen(
  matches: (file: string, flags: Parameters<typeof fs.open>[1]) => boolean,
  effect: (file: string, open: () => Promise<FileHandle>) => Promise<FileHandle | void>,
) {
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = path.resolve(String(args[0]));
    const open = () => originalOpen(...args);
    return (matches(file, args[1]) ? await effect(file, open) : undefined) ?? open();
  });
}

function onPublishedDirectoryOpen(
  effect: (open: () => Promise<FileHandle>) => Promise<FileHandle>,
) {
  const state = { published: false, opened: false };
  durabilityTestState.publish = async (options, publish) => {
    const receipt = await publish(options);
    state.published = true;
    return receipt;
  };
  interceptOpen(
    (file, flags) => state.published && !state.opened && isDirectoryOpen(flags) && file === tempDir,
    async (_file, open) => {
      expect((await fs.lstat(targetPath)).isFile()).toBe(true);
      state.opened = true;
      return effect(open);
    },
  );
  return state;
}

describe("createVerifiedSqliteSnapshot", () => {
  it.runIf(process.platform === "win32")(
    "creates private staging directories exclusively under races",
    async () => {
      const directoryPath = path.join(tempDir, "private");
      const results = await Promise.allSettled([
        createPrivateSqliteDirectory(directoryPath),
        createPrivateSqliteDirectory(directoryPath),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toBeDefined();
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "already-exists" });
      await expect(fs.lstat(directoryPath)).resolves.toMatchObject({});
    },
  );

  it.runIf(process.platform === "win32")(
    "snapshots when private staging exceeds MAX_PATH",
    async () => {
      let targetDirectory = tempDir;
      while (targetDirectory.length < 205) {
        targetDirectory = path.join(targetDirectory, `segment-${"x".repeat(24)}`);
      }
      await fs.mkdir(targetDirectory, { recursive: true });
      const longTargetPath = path.join(targetDirectory, "snapshot.sqlite");
      const longestStagingPath = path.join(
        targetDirectory,
        `.sqlite-publish-${"0".repeat(36)}-${"0".repeat(36)}`,
        "database.sqlite",
      );
      expect(longTargetPath.length).toBeLessThan(260);
      expect(longestStagingPath.length).toBeGreaterThan(260);
      execSource("CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');");

      await expectSnapshotSuccess({ sourcePath, targetPath: longTargetPath });
      expect(query("SELECT value FROM records", longTargetPath)).toEqual([{ value: "ok" }]);
    },
  );

  it.each([undefined, true])(
    "preserves implicit row IDs only when requested (%s), including committed WAL data",
    async (preserveRowIds) => {
      using source = new sqlite.DatabaseSync(sourcePath);
      source.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(value TEXT); INSERT INTO records(rowid,value) VALUES(71,'online turn')",
      );
      await createVerifiedSqliteSnapshot({ sourcePath, targetPath, preserveRowIds });
      expect(query("SELECT rowid,value FROM records")).toEqual([
        { rowid: preserveRowIds ? 71 : 1, value: "online turn" },
      ]);
      expect(query("PRAGMA journal_mode")).toEqual([{ journal_mode: "delete" }]);
      expect(query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      await expect(fs.access(`${targetPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(`${targetPath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("captures committed WAL state and removes deleted page contents", async () => {
    const deletedValue = `deleted-secret-${"x".repeat(256)}`;
    using source = new sqlite.DatabaseSync(sourcePath);
    source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        PRAGMA secure_delete = OFF;
        CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        PRAGMA wal_checkpoint(TRUNCATE);
      `);
    source.prepare("INSERT INTO records (value) VALUES (?)").run("survivor");
    source.prepare("INSERT INTO records (value) VALUES (?)").run(deletedValue);
    source.prepare("DELETE FROM records WHERE value = ?").run(deletedValue);

    const published = await expectSnapshotSuccess();
    expect(published.includes(deletedValue)).toBe(false);

    expect(query("SELECT value FROM records")).toEqual([{ value: "survivor" }]);
    expect(query("PRAGMA journal_mode;")).toEqual([{ journal_mode: "delete" }]);
    await expect(fs.access(`${targetPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(`${targetPath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32").each([false, true])(
    "recovers hot journals without modifying source (initially hidden: %s)",
    async (hideJournal) => {
      createHotRollbackJournal(sourcePath);
      const sourceBefore = await fs.readFile(sourcePath);
      const journalBefore = await fs.readFile(`${sourcePath}-journal`);
      const canonicalJournalPath = `${fsSync.realpathSync.native(sourcePath)}-journal`;
      const lstatSync = fsSync.lstatSync.bind(fsSync);
      let hidJournal = false;
      if (hideJournal) {
        vi.spyOn(fsSync, "lstatSync").mockImplementation(((pathname, options) => {
          if (!hidJournal && path.resolve(String(pathname)) === canonicalJournalPath) {
            hidJournal = true;
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          return lstatSync(pathname, options as never);
        }) as typeof fsSync.lstatSync);
      }

      await expectSnapshotSuccess({ sourcePath, targetPath });
      expect(hidJournal).toBe(hideJournal);
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
      await expect(fs.readFile(`${sourcePath}-journal`)).resolves.toEqual(journalBefore);
      expect(query("SELECT value, COUNT(*) AS count FROM records GROUP BY value")).toEqual([
        { value: "committed", count: 256 },
      ]);
      expect(query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      await expect(fs.access(`${targetPath}-journal`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses hot journal requiring a super-journal",
    async () => {
      const superJournalPath = path.join(tempDir, "source-mj000000900");
      createHotRollbackJournal(sourcePath);
      await fs.writeFile(superJournalPath, "super-journal");
      appendSuperJournalPointer(`${sourcePath}-journal`, superJournalPath);
      const sourceBefore = await fs.readFile(sourcePath);
      const journalBefore = await fs.readFile(`${sourcePath}-journal`);
      const superJournalBefore = await fs.readFile(superJournalPath);

      await expect(snapshot()).rejects.toThrow(/super-journal.*cannot be recovered privately/iu);

      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
      await expect(fs.readFile(`${sourcePath}-journal`)).resolves.toEqual(journalBefore);
      await expect(fs.readFile(superJournalPath)).resolves.toEqual(superJournalBefore);
      await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("ignores a stale rollback journal without changing the source family", async () => {
    execSource("CREATE TABLE records (value TEXT NOT NULL); INSERT INTO records VALUES ('ok');");
    const staleJournal = Buffer.alloc(4096, 0x5a);
    await fs.writeFile(`${sourcePath}-journal`, staleJournal);
    const sourceBefore = await fs.readFile(sourcePath);

    await expectSnapshotSuccess({ sourcePath, targetPath });

    await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
    await expect(fs.readFile(`${sourcePath}-journal`)).resolves.toEqual(staleJournal);
    expect(query("SELECT value FROM records")).toEqual([{ value: "ok" }]);
  });

  it("pins validation and backup to one WAL snapshot", async () => {
    using writer = new sqlite.DatabaseSync(sourcePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE records (value TEXT NOT NULL);
      INSERT INTO records VALUES ('before');
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    const backup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, "backup").mockImplementationOnce(async (...args) => {
      writer.prepare("INSERT INTO records VALUES (?)").run("during");
      return await backup(...args);
    });

    await snapshot();

    expect(writer.prepare("SELECT value FROM records ORDER BY rowid").all()).toEqual([
      { value: "before" },
      { value: "during" },
    ]);
    expect(query("SELECT value FROM records ORDER BY rowid")).toEqual([{ value: "before" }]);
  });

  it("rejects unsafe index drift", async () => {
    createUnsafeIndexDrift();

    await expectSnapshotFailureWithoutTarget(/integrity_check failed|malformed database schema/iu);
  });

  it.each(["index", "foreign-key", "caller"] as const)(
    "rejects a transformed snapshot that fails %s validation",
    async (failure) => {
      execSource(`
          CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL, alternate TEXT NOT NULL);
          CREATE INDEX records_value ON records(value);
          CREATE TABLE children (parent_id INTEGER REFERENCES records(id));
          INSERT INTO records VALUES (1, 'original', 'other');
      `);
      const original = await fs.readFile(sourcePath);
      await expectSnapshotFailureWithoutTarget(
        failure === "index"
          ? /integrity_check failed/iu
          : failure === "foreign-key"
            ? /foreign_key_check failed/iu
            : /Snapshot contains an invalid record/u,
        {
          preserveRowIds: true,
          sourceAcquisition: { mode: "isolated-process", stagingRoot: tempDir },
          transform: (database) => {
            if (failure === "index") {
              corruptIndex(database, "alternate");
            } else if (failure === "foreign-key") {
              database.exec("PRAGMA foreign_keys = OFF; INSERT INTO children VALUES (2);");
            } else {
              database.exec("UPDATE records SET value = 'invalid';");
            }
          },
          validate: (database) => {
            if (database.prepare("SELECT value FROM records").get()?.value === "invalid") {
              throw new Error("Snapshot contains an invalid record");
            }
          },
        },
      );
      expect(await fs.readFile(sourcePath)).toEqual(original);
    },
  );

  it("rejects a zero-byte source when nonempty input is required", async () => {
    await fs.writeFile(sourcePath, "");

    await expectSnapshotFailureWithoutTarget(/snapshot source must not be empty/u, {
      requireNonEmptySource: true,
    });
  });

  it.skipIf(process.platform === "win32")(
    "acquires isolated snapshots through a source symlink",
    async () => {
      execSource("CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('preserved');");
      const linkedSource = path.join(tempDir, "linked.sqlite");
      await fs.symlink(sourcePath, linkedSource);
      const before = await fs.readFile(sourcePath);

      await snapshot({
        sourcePath: linkedSource,
        sourceAcquisition: { mode: "isolated-process", stagingRoot: tempDir },
      });

      expect(await fs.readlink(linkedSource)).toBe(sourcePath);
      expect(await fs.readFile(sourcePath)).toEqual(before);
      expect(query("SELECT value FROM records")).toEqual([{ value: "preserved" }]);
    },
  );

  it("rejects an existing target without modifying it", async () => {
    await fs.writeFile(targetPath, "keep");
    await expectPreservedTarget(/target already exists/u, {}, "keep");
  });

  it.runIf(process.platform !== "win32")("preserves a dangling target link", async () => {
    await fs.symlink("missing.sqlite", targetPath);

    await expect(snapshot()).rejects.toThrow(
      `SQLite snapshot target already exists: ${targetPath}`,
    );
    await expect(fs.readlink(targetPath)).resolves.toBe("missing.sqlite");
  });

  it("preserves a target created while the snapshot is being prepared", async () => {
    await expectPreservedTarget(/EEXIST|already exists/iu, {
      transform: async () => {
        await fs.writeFile(targetPath, "racer");
      },
    });
  });

  it("rejects a same-size user_version change after validation", async () => {
    let stagedReadCount = 0;
    interceptOpen(
      (file, flags) =>
        flags === "r" &&
        path.basename(file) === "database.sqlite" &&
        path.basename(path.dirname(file)).startsWith(".sqlite-snapshot-"),
      async (file) => {
        if (++stagedReadCount === 2) {
          const bytes = await fs.readFile(file);
          bytes.writeUInt32BE(8, 60);
          await fs.writeFile(file, bytes);
        }
      },
    );

    await expectSnapshotFailureWithoutTarget(/size mismatch|hash mismatch/u);
  });

  it.each(["beforePublish", "afterPublish"] as const)(
    "cleans up when %s rejects publication",
    async (phase) => {
      const reject = vi.fn(() => {
        throw new Error("publication refused");
      });
      await expectSnapshotFailureWithoutTarget(/publication refused/, { [phase]: reject });
      expect(reject).toHaveBeenCalledOnce();
    },
  );

  it.each(["after-publication guard", "publication final check"])(
    "rejects an asynchronous %s",
    async (phase) => {
      const asynchronousFinalCheck = (async () => {}) as unknown as () => void;
      await expectSnapshotFailureWithoutTarget(new RegExp(`${phase} must be synchronous`, "u"), {
        afterPublish:
          phase === "after-publication guard"
            ? asynchronousFinalCheck
            : (guard) => guard.assertTargetUnchanged(asynchronousFinalCheck),
      });
    },
  );

  it("preserves a target replaced by the caller after publication", async () => {
    await expectPreservedTarget(/snapshot file changed|hash mismatch|size mismatch/u, {
      afterPublish: (guard) => {
        fsSync.unlinkSync(targetPath);
        fsSync.writeFileSync(targetPath, "racer");
        guard.assertTargetUnchanged();
      },
    });
  });

  it.each(["native", "numeric-collision", "windows-zero", "staging-transition"] as const)(
    "rejects a target replaced after atomic publication (%s)",
    async (identityObservation) => {
      let replaced = false;
      let stagingReplaced = false;
      let createdIdentity: { dev: number | bigint; ino: number | bigint } | undefined;
      const originalLstat = fs.lstat.bind(fs);
      const originalLstatSync = fsSync.lstatSync.bind(fsSync);
      function projectReplacementIdentity<
        T extends { dev: number | bigint; ino: number | bigint } | undefined,
      >(identity: T, filePath: fsSync.PathLike): T {
        if (
          identity &&
          replaced &&
          createdIdentity &&
          identityObservation !== "native" &&
          identityObservation !== "staging-transition" &&
          typeof identity.ino === "number" &&
          path.resolve(String(filePath)) === targetPath
        ) {
          // Keep bigint observations native so the dependency can preserve the
          // replacement even when the caller sees lossy or unknown numeric IDs.
          return Object.assign(identity, {
            dev: identityObservation === "windows-zero" ? 0 : Number(createdIdentity.dev),
            ino: identityObservation === "windows-zero" ? 0 : Number(createdIdentity.ino),
          });
        }
        return identity;
      }
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const identity = await originalLstat(...args);
        const filePath = String(args[0]);
        if (
          identityObservation === "staging-transition" &&
          replaced &&
          !stagingReplaced &&
          path.basename(filePath) === "database.sqlite" &&
          path.basename(path.dirname(filePath)).startsWith(".sqlite-publish-")
        ) {
          await fs.unlink(filePath);
          await fs.link(targetPath, filePath);
          stagingReplaced = true;
        }
        return projectReplacementIdentity(identity, args[0]);
      });
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) =>
        projectReplacementIdentity(originalLstatSync(...args), args[0]),
      );
      __setFsSafeTestHooksForTest({
        afterPublishTargetCreated: async (method, publishedPath, identity) => {
          if (method === "hardlink" && path.resolve(publishedPath) === targetPath) {
            createdIdentity = identity;
            await fs.unlink(targetPath);
            await fs.writeFile(targetPath, "racer");
            replaced = true;
            if (identityObservation === "windows-zero") {
              vi.spyOn(process, "platform", "get").mockReturnValue("win32");
            }
          }
        },
      });

      await expectPreservedTarget(
        /target changed during publication|staging path changed|snapshot file changed/u,
      );
      expect(replaced).toBe(true);
      expect(stagingReplaced).toBe(identityObservation === "staging-transition");
    },
  );

  it.runIf(process.platform !== "win32").each(["hardlink", "exclusive-copy"] as const)(
    "removes its %s target when publication durability is unsupported",
    async (method) => {
      durabilityTestState.publicationSyncUnsupported = true;
      const copy = method === "exclusive-copy" ? mockExclusiveCopyPublication() : undefined;
      await expectSnapshotFailureWithoutTarget(
        /File publication directory does not support crash-durable directory synchronization/u,
      );
      if (copy) {
        expect(copy).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.runIf(process.platform !== "win32").each(["before", "after"] as const)(
    "rejects a staging pathname replaced %s publication",
    async (phase) => {
      let replacementBytes: Buffer | undefined;
      durabilityTestState.publish = async (options, publish) => {
        const replaceStaging = async () => {
          await fs.unlink(options.sourcePath);
          const replacement = new sqlite.DatabaseSync(options.sourcePath);
          replacement.exec("CREATE TABLE replacement (value TEXT NOT NULL);");
          replacement.close();
          replacementBytes = await fs.readFile(options.sourcePath);
        };
        if (phase === "before") {
          // Keep the retired inode live so replacement guarantees a different identity.
          const originalSource = await fs.open(options.sourcePath, "r");
          try {
            await replaceStaging();
            return await publish(options);
          } finally {
            await originalSource.close();
          }
        }
        __setFsSafeTestHooksForTest({
          afterPublishTargetCreated: async () => {
            await replaceStaging();
            await fs.unlink(options.targetPath);
            await fs.link(options.sourcePath, options.targetPath);
          },
        });
        return await publish(options);
      };

      await expect(snapshot()).rejects.toThrow(
        /source identity did not match|staging file changed during publication/u,
      );
      expect(replacementBytes).toBeDefined();
      if (phase === "before") {
        await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(targetPath)).resolves.toEqual(replacementBytes);
      }
    },
  );

  it("removes its target when inspection fails after atomic publication", async () => {
    let failedInspection = false;
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated: (method, publishedPath) => {
        if (
          method === "hardlink" &&
          !failedInspection &&
          path.resolve(publishedPath) === targetPath
        ) {
          failedInspection = true;
          throw Object.assign(new Error("target inspection failed"), { code: "EIO" });
        }
      },
    });

    await expectSnapshotFailureWithoutTarget(/target inspection failed/u);
  });

  it("removes an exclusive-copy publication whose bytes fail verification", async () => {
    const publish = mockExclusiveCopyPublication(async (filePath) => {
      await fs.appendFile(filePath, "changed-copy");
    });

    await expectSnapshotFailureWithoutTarget(/size mismatch|hash mismatch/u);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("removes its hard link when opening the published target fails", async () => {
    let linked = false;
    durabilityTestState.publish = async (options, publish) => {
      const published = await publish(options);
      expect(published.method).toBe("hardlink");
      linked = true;
      return published;
    };
    interceptOpen(
      (file, flags) => linked && file === targetPath && flags === "r",
      async () => {
        throw Object.assign(new Error("target open failed"), { code: "EIO" });
      },
    );

    await expectSnapshotFailureWithoutTarget(/target open failed/u);
    expect(linked).toBe(true);
  });

  it("cleans publication staging when initialization fails", async () => {
    const originalChmod = fs.chmod.bind(fs);
    vi.spyOn(fs, "chmod").mockImplementation(async (filePath, mode) => {
      if (path.basename(String(filePath)).startsWith(".sqlite-publish-")) {
        throw Object.assign(new Error("chmod refused"), { code: "EACCES" });
      }
      await originalChmod(filePath, mode);
    });

    await expect(snapshot()).rejects.toThrow(/chmod refused/u);
    expect((await fs.readdir(tempDir)).every((name) => !name.startsWith(".sqlite-publish-"))).toBe(
      true,
    );
  });

  it("removes its published target when final directory sync fails", async () => {
    const state = onPublishedDirectoryOpen(async () => {
      throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
    });
    await expectSnapshotFailureWithoutTarget(/directory sync failed/u);
    expect(state).toEqual({ published: true, opened: true });
  });

  it.runIf(process.platform !== "win32")(
    "removes target when directory sync is unsupported",
    async () => {
      durabilityTestState.syncOutcome = { status: "unsupported", code: "ENOTSUP" };

      await expectSnapshotFailureWithoutTarget(
        /SQLite publication directory does not support crash-durable directory synchronization \(ENOTSUP\)/u,
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a replaced publication directory during sync",
    async () => {
      const displacedPath = `${tempDir}.displaced`;
      const replacementPath = `${tempDir}.replacement`;
      const state = onPublishedDirectoryOpen(async (open) => {
        await fs.rename(tempDir, displacedPath);
        await fs.mkdir(tempDir);
        const replacementHandle = await open();
        await fs.rename(tempDir, replacementPath);
        await fs.rename(displacedPath, tempDir);
        return replacementHandle;
      });

      try {
        await expect(snapshot()).rejects.toMatchObject({
          cause: { name: "FsSafeError", code: "path-mismatch" },
        });
        expect(state).toEqual({ published: true, opened: true });
        await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.rm(replacementPath, { recursive: true, force: true });
        await fs.rename(displacedPath, tempDir).catch(() => undefined);
      }
    },
  );

  it("validates source and transformed isolated snapshot", async () => {
    const removedValue = `removed-secret-${"x".repeat(256)}`;
    const source = new sqlite.DatabaseSync(sourcePath);
    source.exec("PRAGMA secure_delete = OFF; CREATE TABLE records (value TEXT NOT NULL);");
    source.prepare("INSERT INTO records VALUES (?)").run(removedValue);
    source.close();
    const validatedValues = new Map<string, unknown>();

    await snapshot({
      sourceAcquisition: { mode: "isolated-process", stagingRoot: tempDir },
      transform: (database) => {
        database.exec("DELETE FROM records;");
        database.prepare("INSERT INTO records VALUES (?)").run("new");
      },
      validate: (database, label) => {
        validatedValues.set(label, database.prepare("SELECT value FROM records").get()?.value);
      },
    });

    expect(validatedValues).toEqual(
      new Map([
        [sourcePath, removedValue],
        [targetPath, "new"],
      ]),
    );
    expect((await fs.readFile(targetPath)).includes(removedValue)).toBe(false);
    expect(query("SELECT value FROM records")).toEqual([{ value: "new" }]);
    expect(query("SELECT value FROM records", sourcePath)).toEqual([{ value: removedValue }]);
  });
});
