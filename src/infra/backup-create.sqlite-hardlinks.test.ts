import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createBackupArchive, type BackupCreateResult } from "./backup-create.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";

type HardlinkedDatabase = {
  state: OpenClawTestState;
  database: DatabaseSync;
  ownerPath: string;
  aliasPath: string;
};

async function withHardlinkedDatabase(
  ownerName: "alpha.sqlite" | "zeta.sqlite",
  run: (fixture: HardlinkedDatabase) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "split", prefix: "backup-generic-hardlinks-", scenario: "minimal" },
    async (state) => {
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
        await expect(fs.stat(`${aliasPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
        await run({ state, database, ownerPath, aliasPath });
      } finally {
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );
}

async function readArchivedRecords(state: OpenClawTestState, archive: BackupCreateResult) {
  const entries: Array<{ path: string; type: string | undefined; linkpath: string | undefined }> =
    [];
  await tar.t({
    file: archive.archivePath,
    gzip: true,
    onentry: (entry) => {
      if (entry.path.includes("/state/plugins/hardlinks/") && entry.type !== "Directory") {
        entries.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath });
      }
      entry.resume();
    },
  });
  entries.sort((left, right) => left.path.localeCompare(right.path));
  expect(
    entries.map((entry) => ({
      name: path.basename(entry.path),
      type: entry.type,
      linkpath: entry.linkpath,
    })),
  ).toEqual([
    { name: "alpha.sqlite", type: "File", linkpath: undefined },
    { name: "zeta.sqlite", type: "File", linkpath: undefined },
  ]);
  const extractDir = state.path("extract");
  await fs.mkdir(extractDir);
  await tar.x({ file: archive.archivePath, gzip: true, cwd: extractDir });
  const sqlite = requireNodeSqlite();
  return entries.map((entry) => {
    const database = new sqlite.DatabaseSync(path.join(extractDir, entry.path), { readOnly: true });
    try {
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      return {
        name: path.basename(entry.path),
        rows: database.prepare("SELECT id, value FROM hardlink_records ORDER BY id").all(),
      };
    } finally {
      database.close();
    }
  });
}

async function expectBackupRefused(state: OpenClawTestState, message: RegExp): Promise<void> {
  const output = state.path("rejected.tar.gz");
  await expect(createBackupArchive({ output, includeWorkspace: false })).rejects.toThrow(message);
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
}

describe.skipIf(process.platform === "win32")("backup generic SQLite hardlinks", () => {
  it.runIf(process.platform === "linux").each(["singleton", "hardlink pair"] as const)(
    "preserves a live writer's main-file POSIX lock when backing up a generic %s",
    async (layout) => {
      await withHardlinkedDatabase("alpha.sqlite", async ({ state, ownerPath, aliasPath }) => {
        if (layout === "singleton") {
          await fs.unlink(aliasPath);
        }
        const locksBefore = readMainDatabasePosixLocks(ownerPath);
        expect(locksBefore).toEqual([
          { length: 510, pid: process.pid, start: 1073741826, type: "read" },
        ]);

        const archive = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
        });

        expect(readMainDatabasePosixLocks(ownerPath)).toEqual(locksBefore);
        expect((await fs.stat(archive.archivePath)).size).toBeGreaterThan(0);
      });
    },
  );

  it.each(["alpha.sqlite", "zeta.sqlite"] as const)(
    "preserves WAL-only schema and rows in both regular entries when %s owns the WAL",
    async (ownerName) => {
      await withHardlinkedDatabase(ownerName, async ({ state }) => {
        const archive = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
        });
        await expect(verifyBackupArchive(archive.archivePath)).resolves.toMatchObject({ ok: true });
        expect(await readArchivedRecords(state, archive)).toEqual([
          { name: "alpha.sqlite", rows: [{ id: 7, value: "committed-in-wal" }] },
          { name: "zeta.sqlite", rows: [{ id: 7, value: "committed-in-wal" }] },
        ]);
      });
    },
  );

  it("refuses competing nonempty WAL names even when their contents are identical", async () => {
    await withHardlinkedDatabase("alpha.sqlite", async ({ state, ownerPath, aliasPath }) => {
      await fs.copyFile(`${ownerPath}-wal`, `${aliasPath}-wal`);
      await expectBackupRefused(state, /ambiguous.*multiple non-empty WAL/iu);
    });
  });

  it.each([
    {
      name: "refuses a canonical symlink retargeted after an earlier generic snapshot completes",
      change: "symlink retarget",
    },
    {
      name: "refuses a canonical-bound hardlink alias replaced after an earlier generic snapshot completes",
      change: "hardlink replacement",
    },
  ])("$name", async ({ change }) => {
    await withHardlinkedDatabase("alpha.sqlite", async ({ state, ownerPath }) => {
      const canonicalPath = resolveOpenClawStateSqlitePath(state.env);
      const firstPath = state.statePath("state", "first-global.sqlite");
      const secondPath = state.statePath("state", "second-global.sqlite");
      const canonicalAliasPath = state.statePath("state", "zeta-global-alias.sqlite");
      await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
      const sqlite = requireNodeSqlite();
      for (const databasePath of [firstPath, secondPath]) {
        const database = new sqlite.DatabaseSync(databasePath);
        try {
          database.exec(`
            CREATE TABLE schema_meta (
              meta_key TEXT NOT NULL PRIMARY KEY,
              role TEXT NOT NULL,
              schema_version INTEGER NOT NULL,
              agent_id TEXT,
              app_version TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            PRAGMA user_version = 1;
            INSERT INTO schema_meta
              (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
            VALUES ('primary', 'global', 1, NULL, NULL, 1, 1);
          `);
        } finally {
          database.close();
        }
      }
      await fs.symlink(firstPath, canonicalPath);
      await fs.link(firstPath, canonicalAliasPath);
      const originalIdentity = await fs.stat(firstPath);
      expect((await fs.stat(canonicalAliasPath)).ino).toBe(originalIdentity.ino);
      const originalSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
      let changed = false;
      const snapshot = vi
        .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
        .mockImplementation(async (options) => {
          const result = await originalSnapshot(options);
          if (!changed && options.sourcePath === ownerPath) {
            if (change === "symlink retarget") {
              await fs.unlink(canonicalPath);
              await fs.symlink(secondPath, canonicalPath);
            } else {
              await fs.unlink(canonicalAliasPath);
              await fs.copyFile(secondPath, canonicalAliasPath);
            }
            changed = true;
          }
          return result;
        });
      try {
        await expectBackupRefused(state, /Canonical SQLite path changed after discovery/iu);
        expect(changed).toBe(true);
        if (change === "symlink retarget") {
          expect(await fs.realpath(canonicalPath)).toBe(secondPath);
        } else {
          expect(await fs.realpath(canonicalPath)).toBe(firstPath);
          expect((await fs.stat(canonicalPath)).ino).toBe(originalIdentity.ino);
          expect((await fs.stat(canonicalAliasPath)).ino).not.toBe(originalIdentity.ino);
        }
      } finally {
        snapshot.mockRestore();
      }
    });
  });

  it.each([
    { admitted: 1, total: 2 },
    { admitted: 2, total: 3 },
  ])(
    "refuses $admitted admitted names for an inode with $total links",
    async ({ admitted, total }) => {
      await withHardlinkedDatabase("alpha.sqlite", async ({ state, ownerPath, aliasPath }) => {
        if (admitted === 1) {
          await fs.rename(aliasPath, state.path("outside.sqlite"));
        } else {
          await fs.link(ownerPath, state.path("outside.sqlite"));
        }
        expect((await fs.stat(ownerPath)).nlink).toBe(total);
        await expectBackupRefused(state, /journal owner may be outside the backup inventory/iu);
      });
    },
  );

  it.each(["absent", "empty"] as const)(
    "preserves closed checkpointed hardlinks with %s WAL sidecars",
    async (sidecars) => {
      await withHardlinkedDatabase(
        "alpha.sqlite",
        async ({ state, database, ownerPath, aliasPath }) => {
          database.close();
          await expect(fs.stat(`${ownerPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
          if (sidecars === "empty") {
            await fs.writeFile(`${ownerPath}-wal`, "");
            await fs.writeFile(`${aliasPath}-wal`, "");
            await fs.writeFile(`${aliasPath}-journal`, "");
          }
          const archive = await createBackupArchive({
            output: state.path("backup.tar.gz"),
            includeWorkspace: false,
          });
          expect(await readArchivedRecords(state, archive)).toEqual([
            { name: "alpha.sqlite", rows: [{ id: 7, value: "committed-in-wal" }] },
            { name: "zeta.sqlite", rows: [{ id: 7, value: "committed-in-wal" }] },
          ]);
        },
      );
    },
  );

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
      const originalSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
      const movedWal = state.path("selected-wal.saved");
      let changed = false;
      let walMoved = false;
      const snapshot = vi
        .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
        .mockImplementation(async (options) => {
          const result = await originalSnapshot(options);
          if (!changed && options.sourcePath === ownerPath) {
            changed = true;
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
          }
          return result;
        });
      try {
        await expectBackupRefused(state, error);
        expect(changed).toBe(true);
      } finally {
        snapshot.mockRestore();
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
        await expect(fs.stat(`${ownerPath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
        const sqlite = requireNodeSqlite();
        const originalSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
        let writer: DatabaseSync | undefined;
        const snapshot = vi
          .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
          .mockImplementation(async (options) => {
            const result = await originalSnapshot(options);
            if (!writer && (options.sourcePath === ownerPath || options.sourcePath === aliasPath)) {
              writer = new sqlite.DatabaseSync(ownerPath);
              writer.exec(`
              PRAGMA journal_mode = WAL;
              PRAGMA wal_autocheckpoint = 0;
              INSERT INTO hardlink_records (id, value) VALUES (9, 'new-wal-owner');
            `);
            }
            return result;
          });
        try {
          await expectBackupRefused(state, /journal ownership changed/iu);
          expect((await fs.stat(`${ownerPath}-wal`)).size).toBeGreaterThan(0);
        } finally {
          snapshot.mockRestore();
          writer?.close();
        }
      },
    );
  });

  it("keeps one captured image for both aliases while the selected WAL grows", async () => {
    await withHardlinkedDatabase("alpha.sqlite", async ({ state, database, ownerPath }) => {
      const originalSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
      const walBefore = await fs.stat(`${ownerPath}-wal`);
      let appended = false;
      const snapshot = vi
        .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
        .mockImplementation(async (options) => {
          const result = await originalSnapshot(options);
          if (!appended && options.sourcePath === ownerPath) {
            appended = true;
            database.exec("INSERT INTO hardlink_records (id, value) VALUES (9, 'committed-later')");
          }
          return result;
        });
      try {
        const archive = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
        });
        expect(appended).toBe(true);
        expect((await fs.stat(`${ownerPath}-wal`)).size).toBeGreaterThan(walBefore.size);
        expect(
          database.prepare("SELECT id, value FROM hardlink_records ORDER BY id").all(),
        ).toEqual([
          { id: 7, value: "committed-in-wal" },
          { id: 9, value: "committed-later" },
        ]);
        expect(await readArchivedRecords(state, archive)).toEqual([
          { name: "alpha.sqlite", rows: [{ id: 7, value: "committed-in-wal" }] },
          { name: "zeta.sqlite", rows: [{ id: 7, value: "committed-in-wal" }] },
        ]);
      } finally {
        snapshot.mockRestore();
      }
    });
  });
});
