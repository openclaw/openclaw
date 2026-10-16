import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  withBackupFixture,
  createVerifiedBackup,
  restoreBackup,
  expectAbsent,
  createOwnedSqliteDatabase,
  declarePluginSqliteResources,
  inspectDatabase,
} from "./backup-create-family.test-support.js";
import { createBackupArchive, type BackupCreateResult } from "./backup-create.js";
import { listArchiveEntryDetails } from "./backup-create.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";

afterEach(() => vi.restoreAllMocks());

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

async function withHardlinkedDatabase(
  ownerName: "alpha.sqlite" | "zeta.sqlite",
  run: (fixture: HardlinkedDatabase) => Promise<void>,
  ownership: "declared" | "opaque" = "declared",
): Promise<void> {
  await withBackupFixture(
    { layout: "split", prefix: "backup-plugin-hardlinks-" },
    async (state) => {
      if (ownership === "declared") {
        await declarePluginSqliteResources(state, "plugins/hardlinks");
      }
      const ownerPath = state.statePath("plugins", "hardlinks", ownerName);
      const aliasPath = state.statePath(
        "plugins",
        "hardlinks",
        ownerName === "alpha.sqlite" ? "zeta.sqlite" : "alpha.sqlite",
      );
      await fs.mkdir(path.dirname(ownerPath), { recursive: true });
      const sqlite = requireNodeSqlite();
      const database = new sqlite.DatabaseSync(ownerPath);
      try {
        database.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE hardlink_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO hardlink_records (id, value) VALUES (7, 'committed-in-wal');
        `);
        await fs.link(ownerPath, aliasPath);
        const owner = await fs.stat(ownerPath);
        const alias = await fs.stat(aliasPath);
        expect({ dev: alias.dev, ino: alias.ino, nlink: alias.nlink }).toEqual({
          dev: owner.dev,
          ino: owner.ino,
          nlink: 2,
        });
        expect(owner.nlink).toBe(2);
        expect((await fs.stat(`${ownerPath}-wal`)).size).toBeGreaterThan(0);
        await expectAbsent(`${aliasPath}-wal`);
        await run({ state, database, ownerPath, aliasPath });
      } finally {
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );
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
  it("copies undeclared hardlinks and sidecars as opaque bytes", async () => {
    await withHardlinkedDatabase(
      "zeta.sqlite",
      async ({ state, ownerPath, aliasPath }) => {
        await fs.copyFile(`${ownerPath}-wal`, `${aliasPath}-wal`);
        await fs.link(ownerPath, state.path("outside.sqlite"));
        const names = await fs.readdir(path.dirname(ownerPath));
        const originals = new Map(
          await Promise.all(
            names.map(
              async (name) =>
                [name, await fs.readFile(path.join(path.dirname(ownerPath), name))] as const,
            ),
          ),
        );
        const runtime = createTestRuntime();
        const archive = await createVerifiedBackup(state, {}, runtime);
        expect(archive.verified).toBe(true);
        for (const name of ["alpha.sqlite", "zeta.sqlite"]) {
          expect(archive.warnings?.find((warning) => warning.includes(name))).toMatch(/opaque/iu);
        }
        const restored = await restoreBackup(state, archive, runtime);
        const asset = expectDefined(
          archive.assets.find((candidate) => candidate.kind === "state"),
          "state asset",
        );
        const restoredDirectory = path.join(
          restored.targetPath,
          asset.archivePath,
          "plugins",
          "hardlinks",
        );
        expect((await fs.readdir(restoredDirectory)).toSorted()).toEqual(names.toSorted());
        for (const [name, bytes] of originals) {
          expect(await fs.readFile(path.join(restoredDirectory, name))).toEqual(bytes);
          expect(await fs.readFile(path.join(path.dirname(ownerPath), name))).toEqual(bytes);
        }
      },
      "opaque",
    );
  });

  it.runIf(process.platform === "linux").each(["singleton", "hardlink pair"] as const)(
    "preserves a live writer's main-file POSIX lock when backing up a declared plugin %s",
    async (layout) => {
      await withHardlinkedDatabase("alpha.sqlite", async ({ state, ownerPath, aliasPath }) => {
        if (layout === "singleton") {
          await fs.unlink(aliasPath);
        }
        const locksBefore = readMainDatabasePosixLocks(ownerPath);
        expect(locksBefore).toEqual([
          { length: 510, pid: process.pid, start: 1073741826, type: "read" },
        ]);

        const archive = await createArchive(state);

        expect(readMainDatabasePosixLocks(ownerPath)).toEqual(locksBefore);
        expect((await fs.stat(archive.archivePath)).size).toBeGreaterThan(0);
      });
    },
  );

  it.each([
    {
      name: "refuses a canonical symlink retargeted after an earlier declared plugin snapshot completes",
      change: "symlink retarget",
      error: /Canonical SQLite path changed after discovery/iu,
    },
    {
      name: "refuses a canonical-bound hardlink alias replaced after an earlier declared plugin snapshot completes",
      change: "hardlink replacement",
      error:
        /SQLite hardlink journal owner may be outside the backup inventory:.*has 1 links, but 2 paths were admitted/iu,
    },
  ])("$name", async ({ change, error }) => {
    await withHardlinkedDatabase("alpha.sqlite", async ({ state, ownerPath }) => {
      const canonicalPath = resolveOpenClawStateSqlitePath(state.env);
      const firstPath = state.statePath("state", "first-global.sqlite");
      const secondPath = state.statePath("state", "second-global.sqlite");
      const canonicalAliasPath = state.statePath("state", "zeta-global-alias.sqlite");
      await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
      for (const databasePath of [firstPath, secondPath]) {
        createOwnedSqliteDatabase({ sqlitePath: databasePath, role: "global" });
      }
      await fs.symlink(firstPath, canonicalPath);
      await fs.link(firstPath, canonicalAliasPath);
      const originalIdentity = await fs.stat(firstPath);
      expect((await fs.stat(canonicalAliasPath)).ino).toBe(originalIdentity.ino);
      const changed = mutateAfterSnapshot([ownerPath], async () => {
        if (change === "symlink retarget") {
          await fs.unlink(canonicalPath);
          await fs.symlink(secondPath, canonicalPath);
        } else {
          await fs.unlink(canonicalAliasPath);
          await fs.copyFile(secondPath, canonicalAliasPath);
        }
      });
      await expectBackupRefused(state, error);
      expect(changed).toHaveBeenCalledOnce();
      if (change === "symlink retarget") {
        expect(await fs.realpath(canonicalPath)).toBe(secondPath);
      } else {
        expect(await fs.realpath(canonicalPath)).toBe(firstPath);
        expect((await fs.stat(canonicalPath)).ino).toBe(originalIdentity.ino);
        expect((await fs.stat(canonicalAliasPath)).ino).not.toBe(originalIdentity.ino);
      }
    });
  });

  it("preserves closed checkpointed hardlinks with empty WAL sidecars", async () => {
    await withHardlinkedDatabase(
      "alpha.sqlite",
      async ({ state, database, ownerPath, aliasPath }) => {
        database.close();
        await expectAbsent(`${ownerPath}-wal`);
        for (const file of [`${ownerPath}-wal`, `${aliasPath}-wal`, `${aliasPath}-journal`]) {
          await fs.writeFile(file, "");
        }
        await expectArchivedRecords(state, await createArchive(state));
      },
    );
  });

  it("refuses a hardlink group with a live rollback journal", async () => {
    await withHardlinkedDatabase("alpha.sqlite", async ({ state, database, ownerPath }) => {
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
    });
  });

  it.each([
    { change: "a competing WAL appears", error: /ambiguous.*multiple non-empty WAL/iu },
    {
      change: "an alias is replaced",
      error: /source identity changed|outside the backup inventory/iu,
    },
    { change: "an outside link is added", error: /outside the backup inventory/iu },
    { change: "the selected WAL is replaced", error: /journal ownership changed/iu },
  ])("publishes no archive when $change during capture", async ({ change, error }) => {
    await withHardlinkedDatabase("alpha.sqlite", async ({ state, ownerPath, aliasPath }) => {
      const movedWal = state.path("selected-wal.saved");
      let walMoved = false;
      const changed = mutateAfterSnapshot([ownerPath], async () => {
        if (change === "a competing WAL appears") {
          await fs.copyFile(`${ownerPath}-wal`, `${aliasPath}-wal`);
        } else if (change === "an alias is replaced") {
          await fs.unlink(aliasPath);
          await fs.copyFile(ownerPath, aliasPath);
        } else if (change === "an outside link is added") {
          await fs.link(ownerPath, state.path("outside.sqlite"));
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
      }
    });
  });

  it("refuses a closed hardlink group that acquires its first WAL during capture", async () => {
    await withHardlinkedDatabase(
      "alpha.sqlite",
      async ({ state, database, ownerPath, aliasPath }) => {
        database.close();
        await expectAbsent(`${ownerPath}-wal`);
        const sqlite = requireNodeSqlite();
        let writer: DatabaseSync | undefined;
        mutateAfterSnapshot([ownerPath, aliasPath], () => {
          writer = new sqlite.DatabaseSync(ownerPath);
          writer.exec(`
              PRAGMA journal_mode = WAL;
              PRAGMA wal_autocheckpoint = 0;
              INSERT INTO hardlink_records (id, value) VALUES (9, 'new-wal-owner');
            `);
        });
        try {
          await expectBackupRefused(state, /journal ownership changed/iu);
          expect((await fs.stat(`${ownerPath}-wal`)).size).toBeGreaterThan(0);
        } finally {
          writer?.close();
        }
      },
    );
  });

  it("keeps one captured image for both aliases while the selected WAL grows", async () => {
    await withHardlinkedDatabase("alpha.sqlite", async ({ state, database, ownerPath }) => {
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
    });
  });
});
