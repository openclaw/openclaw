import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildBackupArchivePath } from "../commands/backup-shared.js";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateReadWorker from "../state/openclaw-state-read-worker.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  withBackupFixture,
  createVerifiedBackup,
  restoreBackup,
  expectAbsent,
  createOwnedSqliteDatabase,
  declarePluginSqliteResources,
  inspectDatabase,
  isolateBackupScratch,
  mkdirs,
} from "./backup-create-family.test-support.js";
import { createBackupArchive, type BackupCreateResult } from "./backup-create.js";
import { listArchiveEntryDetails } from "./backup-create.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";

const systemTempRoot = os.tmpdir();

afterEach(() => vi.restoreAllMocks());

it("preserves fixture inputs after a retained backup reader cannot close", async () => {
  // Keep the real snapshot outside the parent under test so even the broken
  // parent cleanup leaves its native owner available for supported retirement.
  const snapshots = createTempDirTracker();
  const cacheRoot = snapshots.make("backup-retained-reader-", systemTempRoot);
  const environment = { ...process.env };
  const restores: Array<() => void> = [];
  const failure = new Error("retained backup reader close incomplete");
  let fixture: OpenClawTestState | undefined;
  let input = "";
  let snapshotPath = "";
  let snapshotBytes: Buffer | undefined;
  let readSucceeded = false;
  let closeAttempts = 0;

  onTestFinished(async () => {
    try {
      expect(readSucceeded).toBe(true);
      expect(closeAttempts).toBeGreaterThan(1);
      expect(await fs.readFile(input, "utf8")).toBe("retained fixture input\n");
      expect(await fs.readFile(snapshotPath)).toEqual(snapshotBytes);
    } finally {
      for (const restore of restores.toReversed()) {
        restore();
      }
      if (fixture) {
        // The fixture caches its failed cleanup. Rejoin the real retained
        // owner before removing any bytes or restoring its selectors.
        await cleanupSessionStateForTest({ rootPath: fixture.root, stateDir: fixture.stateDir });
        if (snapshotPath) {
          await expect(fs.stat(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
      snapshots.cleanup();
      // Other keys already belong to the enclosing hooks' restoration.
      for (const key of Object.keys(fixture?.envVars ?? {})) {
        const value = environment[key];
        if (value === undefined) {
          deleteTestEnvValue(key);
        } else {
          setTestEnvValue(key, value);
        }
      }
    }
  });

  const captureSource = stateReadWorker.captureOpenClawStateReadSource;
  const capture = vi
    .spyOn(stateReadWorker, "captureOpenClawStateReadSource")
    .mockImplementation(() => {
      const source = captureSource();
      const createTransport = source.createTransport.bind(source);
      const create = vi
        .spyOn(source, "createTransport")
        .mockImplementation((command, onChunk, onChunkAsync, awaitedOnly) => {
          const transport = createTransport(command, onChunk, onChunkAsync, awaitedOnly);
          if (command.type === "worktrees.livePaths") {
            const startRead = transport.startRead.bind(transport);
            const read = vi
              .spyOn(transport, "startRead")
              .mockImplementation(async (...readArgs) => {
                snapshotPath = readArgs[0].location;
                const outcome = await startRead(...readArgs);
                readSucceeded = "value" in outcome && outcome.value.ok;
                return outcome;
              });
            const close = transport.startClose;
            // Keep the retained refusal active through the sibling mock-reset hook.
            transport.startClose = async () => {
              closeAttempts++;
              throw failure;
            };
            restores.push(
              () => read.mockRestore(),
              () => {
                transport.startClose = close;
              },
            );
          }
          return transport;
        });
      restores.push(() => create.mockRestore());
      return source;
    });
  restores.push(() => capture.mockRestore());

  await expect(
    withBackupFixture({ prefix: "backup-retained-fixture-" }, async (state) => {
      fixture = state;
      await isolateBackupScratch(state);
      state.envVars.XDG_CACHE_HOME = cacheRoot;
      state.applyEnv();
      input = await state.writeText("retained-input.txt", "retained fixture input\n");
      const owner = openOpenClawStateDatabase({ env: state.env });
      await closeOpenClawStateDatabaseByPathAsync(owner.path);
      const output = state.path("backup.tar.gz");
      await expect(createArchive(state)).rejects.toThrow();
      expect(snapshotPath).not.toBe(owner.path);
      snapshotBytes = await fs.readFile(snapshotPath);
      await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    }),
  ).rejects.toThrow();
});

function mutateAfterSnapshot(paths: string[], mutate: () => void | Promise<void>) {
  const capture = sqliteSnapshot.createVerifiedSqliteSnapshot;
  const changed = vi.fn(mutate);
  vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot").mockImplementation(async (options) => {
    const result = await capture(options);
    if (!changed.mock.calls.length && paths.includes(options.sourcePath)) {
      await changed();
    }
    return result;
  });
  return changed;
}

type HardlinkedDatabase = {
  state: OpenClawTestState;
  database: DatabaseSync;
  ownerPath: string;
  aliasPath: string;
};

function hardlinkCase<Args extends unknown[]>(
  run: (fixture: HardlinkedDatabase, ...args: Args) => Promise<void>,
  opaque = false,
  ownerName = "alpha.sqlite",
) {
  const aliasName = ownerName.replace("alpha", "zeta");
  return (...args: Args) =>
    withBackupFixture({ layout: "split", prefix: "backup-plugin-hardlinks-" }, async (state) => {
      await isolateBackupScratch(state);
      if (!opaque) {
        await declarePluginSqliteResources(state, "plugins/hardlinks");
      }
      const directory = state.statePath("plugins", "hardlinks");
      const ownerPath = path.join(directory, opaque ? aliasName : ownerName);
      const aliasPath = path.join(directory, opaque ? ownerName : aliasName);
      await fs.mkdir(directory, { recursive: true });
      using database = new (requireNodeSqlite().DatabaseSync)(ownerPath);
      database.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE hardlink_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO hardlink_records (id, value) VALUES (7, 'committed-in-wal');
        `);
      await fs.link(ownerPath, aliasPath);
      expect((await fs.stat(`${ownerPath}-wal`)).size).toBeGreaterThan(0);
      await expectAbsent(`${aliasPath}-wal`);
      await run({ state, database, ownerPath, aliasPath }, ...args);
    });
}

function createArchive(state: OpenClawTestState) {
  return createBackupArchive({ output: state.path("backup.tar.gz"), includeWorkspace: false });
}

async function expectArchivedRecords(state: OpenClawTestState, archive: BackupCreateResult) {
  const entries = (await listArchiveEntryDetails(archive.archivePath))
    .filter(
      (entry) => entry.path.includes("/state/plugins/hardlinks/") && entry.type !== "Directory",
    )
    .toSorted((left, right) => left.path.localeCompare(right.path));
  expect(entries.map((entry) => [path.basename(entry.path), entry.type, entry.linkpath])).toEqual([
    ["alpha.sqlite", "File", undefined],
    ["zeta.sqlite", "File", undefined],
  ]);
  const extractDir = state.path("extract");
  await fs.mkdir(extractDir);
  await tar.x({ file: archive.archivePath, gzip: true, cwd: extractDir });
  for (const entry of entries) {
    inspectDatabase(path.join(extractDir, entry.path), (database) => {
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.prepare("SELECT id, value FROM hardlink_records ORDER BY id").all()).toEqual([
        { id: 7, value: "committed-in-wal" },
      ]);
    });
  }
}

async function expectBackupRefused(state: OpenClawTestState, message: RegExp): Promise<void> {
  const output = state.path("rejected.tar.gz");
  await expect(createBackupArchive({ output, includeWorkspace: false })).rejects.toThrow(message);
  await expectAbsent(output);
}

describe.skipIf(process.platform === "win32")("backup SQLite hardlinks", () => {
  it(
    "copies undeclared hardlinks and sidecars as opaque bytes",
    hardlinkCase(async ({ state, ownerPath, aliasPath }) => {
      const scratchRoot = os.tmpdir();
      onTestFinished(async () => {
        for (const root of [state.root, scratchRoot]) {
          await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
      await fs.copyFile(`${ownerPath}-wal`, `${aliasPath}-wal`);
      await fs.link(ownerPath, state.path("outside.sqlite"));
      const directory = path.dirname(ownerPath);
      const names = await fs.readdir(directory);
      const originals = await Promise.all(
        names.map(async (name) => [name, await fs.readFile(path.join(directory, name))] as const),
      );
      const archive = await createVerifiedBackup(state);
      expect(archive.verified).toBe(true);
      expect(archive.warnings?.map((warning) => path.basename(warning)).toSorted()).toEqual(
        names.toSorted(),
      );
      expect(archive.warnings?.every((warning) => /opaque/iu.test(warning))).toBe(true);
      const restored = await restoreBackup(state, archive);
      const restoredDirectory = path.join(
        restored.targetPath,
        buildBackupArchivePath(archive.archiveRoot, directory),
      );
      expect((await fs.readdir(restoredDirectory)).toSorted()).toEqual(names.toSorted());
      for (const [name, bytes] of originals) {
        expect(await fs.readFile(path.join(restoredDirectory, name))).toEqual(bytes);
        expect(await fs.readFile(path.join(directory, name))).toEqual(bytes);
      }
    }, true),
  );

  it.runIf(process.platform === "linux").each([
    ["singleton", "alpha.sqlite"],
    ["hardlink pair", "alpha.sqlite"],
    ["singleton", "alpha.db"],
    ["hardlink pair", "alpha.db"],
  ])(
    "preserves a live writer's POSIX lock for a declared plugin %s named %s",
    async (layout, ownerName) => {
      await hardlinkCase(
        async ({ state, ownerPath, aliasPath }) => {
          if (layout === "singleton") {
            await fs.unlink(aliasPath);
          }
          const locksBefore = readMainDatabasePosixLocks(ownerPath);
          expect(locksBefore).toEqual([
            { length: 510, pid: process.pid, start: 1073741826, type: "read" },
          ]);

          const archive = await createArchive(state);

          // Closing an in-process header probe would drop the writer's POSIX locks.
          expect(readMainDatabasePosixLocks(ownerPath)).toEqual(locksBefore);
          // No opaque-copy warning: .db names were classified as SQLite too.
          expect(archive.warnings ?? []).toEqual([]);
          expect((await fs.stat(archive.archivePath)).size).toBeGreaterThan(0);
        },
        false,
        ownerName,
      )();
    },
  );

  it.each([
    ["canonical symlink", /Canonical SQLite path changed after discovery/iu],
    [
      "canonical hardlink",
      /SQLite hardlink journal owner may be outside the backup inventory:.*has 1 links, but 2 paths were admitted/iu,
    ],
    ["competing WAL", /ambiguous.*multiple non-empty WAL/iu],
    ["alias", /source identity changed|outside the backup inventory/iu],
    ["link count", /outside the backup inventory/iu],
    ["selected WAL", /journal ownership changed/iu],
    ["first WAL", /journal ownership changed/iu],
  ] as const)(
    "refuses a changed %s after capture",
    hardlinkCase(
      async ({ state, database, ownerPath, aliasPath }, change: string, error: RegExp) => {
        const canonical = change.startsWith("canonical");
        const firstWal = change === "first WAL";
        const canonicalPath = resolveOpenClawStateSqlitePath(state.env);
        const firstPath = state.statePath("state", "first-global.sqlite");
        const secondPath = state.statePath("state", "second-global.sqlite");
        const canonicalAlias = state.statePath("state", "zeta-global-alias.sqlite");
        if (canonical) {
          await mkdirs(path.dirname(canonicalPath));
          for (const sqlitePath of [firstPath, secondPath]) {
            createOwnedSqliteDatabase({ sqlitePath, role: "global" });
          }
          await fs.symlink(firstPath, canonicalPath);
          await fs.link(firstPath, canonicalAlias);
        }
        if (firstWal) {
          database.close();
          await expectAbsent(`${ownerPath}-wal`);
        }
        const movedWal = state.path("selected-wal.saved");
        let walMoved = false;
        let writer: DatabaseSync | undefined;
        const sources = firstWal ? [ownerPath, aliasPath] : [ownerPath];
        const changed = mutateAfterSnapshot(sources, async () => {
          if (change === "canonical symlink") {
            await fs.unlink(canonicalPath);
            await fs.symlink(secondPath, canonicalPath);
          } else if (change === "canonical hardlink" || change === "alias") {
            const target = canonical ? canonicalAlias : aliasPath;
            await fs.unlink(target);
            await fs.copyFile(canonical ? secondPath : ownerPath, target);
          } else if (change === "competing WAL") {
            await fs.copyFile(`${ownerPath}-wal`, `${aliasPath}-wal`);
          } else if (change === "link count") {
            await fs.link(ownerPath, state.path("outside.sqlite"));
          } else if (firstWal) {
            writer = new (requireNodeSqlite().DatabaseSync)(ownerPath);
            writer.exec(`
              PRAGMA journal_mode = WAL;
              PRAGMA wal_autocheckpoint = 0;
              INSERT INTO hardlink_records (id, value) VALUES (9, 'new-wal-owner');
            `);
          } else {
            await fs.rename(`${ownerPath}-wal`, movedWal);
            walMoved = true;
            await fs.copyFile(movedWal, `${ownerPath}-wal`);
          }
        });
        try {
          await expectBackupRefused(state, error);
          expect(changed).toHaveBeenCalledOnce();
        } finally {
          if (walMoved) {
            await fs.rename(movedWal, `${ownerPath}-wal`);
          }
          writer?.close();
        }
      },
    ),
  );

  it(
    "preserves closed checkpointed hardlinks with empty WAL sidecars",
    hardlinkCase(async ({ state, database, ownerPath, aliasPath }) => {
      database.close();
      await expectAbsent(`${ownerPath}-wal`);
      for (const file of [`${ownerPath}-wal`, `${aliasPath}-wal`, `${aliasPath}-journal`]) {
        await fs.writeFile(file, "");
      }
      await expectArchivedRecords(state, await createArchive(state));
    }),
  );

  it(
    "refuses a hardlink group with a live rollback journal",
    hardlinkCase(async ({ state, database, ownerPath }) => {
      database.exec(`
        PRAGMA wal_checkpoint(TRUNCATE);
        PRAGMA journal_mode = DELETE;
        BEGIN IMMEDIATE;
        UPDATE hardlink_records SET value = 'uncommitted' WHERE id = 7;
      `);
      try {
        expect((await fs.stat(`${ownerPath}-journal`)).size).toBeGreaterThan(0);
        await expectBackupRefused(state, /journal ownership.*rollback journal is present/iu);
      } finally {
        database.exec("ROLLBACK");
      }
    }),
  );

  it(
    "keeps one captured image for both aliases while the selected WAL grows",
    hardlinkCase(async ({ state, database, ownerPath }) => {
      const walBefore = await fs.stat(`${ownerPath}-wal`);
      const appended = mutateAfterSnapshot([ownerPath], () => {
        database.exec("INSERT INTO hardlink_records (id, value) VALUES (9, 'committed-later')");
      });
      const archive = await createArchive(state);
      expect(appended).toHaveBeenCalledOnce();
      expect((await fs.stat(`${ownerPath}-wal`)).size).toBeGreaterThan(walBefore.size);
      expect(database.prepare("SELECT id, value FROM hardlink_records ORDER BY id").all()).toEqual([
        { id: 7, value: "committed-in-wal" },
        { id: 9, value: "committed-later" },
      ]);
      await expect(verifyBackupArchive(archive.archivePath)).resolves.toMatchObject({ ok: true });
      await expectArchivedRecords(state, archive);
    }),
  );
});
