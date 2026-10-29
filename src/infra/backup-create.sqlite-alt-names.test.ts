import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import { requireNodeSqlite } from "./node-sqlite.js";

// Regression home for alternative SQLite filename discovery (#148796): these
// cases live in a focused sibling module because backup-create.test.ts has
// exceeded its line cap and must not grow further.

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

async function declarePluginSqliteResources(state: OpenClawTestState): Promise<void> {
  const rootDir = state.path("synthetic-backup-plugin");
  await fs.mkdir(rootDir, { recursive: true });
  const fixture = createColdPluginFixture({
    rootDir,
    pluginId: "backup-owner",
    manifest: {
      backupResources: [
        { disposition: "include", scope: "state", relativePath: "plugins/dedicated" },
      ],
    },
  });
  await state.writeConfig(createColdPluginConfig(rootDir, fixture.pluginId));
}

describe("createBackupArchive SQLite alternative filenames", () => {
  it.each(["cron-log.db", "cache.sqlite3", "extensionless-cache"])(
    "snapshots plugin SQLite databases named %s instead of raw WAL families",
    async (databaseName) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-alt-sqlite-name-",
          scenario: "minimal",
        },
        async (state) => {
          await declarePluginSqliteResources(state);
          const outputDir = state.path("backups");
          const extractDir = state.path("extract");
          const dbPath = state.statePath("plugins", "dedicated", databaseName);
          await fs.mkdir(path.dirname(dbPath), { recursive: true });
          await fs.mkdir(outputDir, { recursive: true });
          await fs.mkdir(extractDir, { recursive: true });
          const sqlite = requireNodeSqlite();
          const db = new sqlite.DatabaseSync(dbPath);
          db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE plugin_witness_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA wal_checkpoint(TRUNCATE);
            BEGIN IMMEDIATE;
            INSERT INTO plugin_witness_rows (id, value) VALUES (1, 'committed-in-wal');
            COMMIT;
          `);

          try {
            await fs.access(`${dbPath}-wal`);
            await fs.access(`${dbPath}-shm`);
            const result = await createBackupArchive({
              output: outputDir,
              includeWorkspace: false,
              nowMs: Date.UTC(2026, 8, 15, 4, 0, 0),
            });
            expect(result.warnings ?? []).toEqual([]);
            const entries = await listArchiveEntries(result.archivePath);
            const archivedDbEntries = entries.filter((entry) =>
              entry.endsWith(`/state/plugins/dedicated/${databaseName}`),
            );
            expect(archivedDbEntries).toHaveLength(1);
            for (const suffix of ["-wal", "-shm", "-journal"]) {
              expect(
                entries.some((entry) =>
                  entry.endsWith(`/state/plugins/dedicated/${databaseName}${suffix}`),
                ),
                suffix,
              ).toBe(false);
            }

            await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
            const archivedDb = new sqlite.DatabaseSync(
              path.join(
                extractDir,
                expectDefined(archivedDbEntries[0], "archivedDbEntries[0] test invariant"),
              ),
              { readOnly: true },
            );
            try {
              expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
                integrity_check: "ok",
              });
              expect(
                archivedDb.prepare("SELECT value FROM plugin_witness_rows WHERE id = 1").get(),
              ).toEqual({ value: "committed-in-wal" });
            } finally {
              archivedDb.close();
            }
          } finally {
            db.close();
          }
        },
      );
    },
  );

  it("warns when an unmanaged SQLite database named .db is archived as opaque bytes", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-unmanaged-db-",
        scenario: "minimal",
      },
      async (state) => {
        const dbPath = state.statePath("browser", "foreign-cron-log.db");
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        const sqlite = requireNodeSqlite();
        const db = new sqlite.DatabaseSync(dbPath);
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE foreign_rows (id INTEGER PRIMARY KEY);
          PRAGMA wal_checkpoint(TRUNCATE);
          BEGIN IMMEDIATE;
          INSERT INTO foreign_rows (id) VALUES (7);
          COMMIT;
        `);
        try {
          const runtime = createTestRuntime();
          const archive = await backupCreateCommand(runtime, {
            output: state.path("foreign.tar.gz"),
            includeWorkspace: false,
          });
          expect(
            archive.warnings?.filter(
              (warning) => warning.endsWith("foreign-cron-log.db") && warning.includes("opaque"),
            ),
          ).toHaveLength(1);
        } finally {
          db.close();
        }
      },
    );
  });

  it("keeps ordinary non-SQLite .db files as plain archive entries without warnings", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-ordinary-db-",
        scenario: "minimal",
      },
      async (state) => {
        const plainPath = state.statePath("notes", "ordinary.db");
        const plainBytes = Buffer.from("definitely not a sqlite database\n", "utf8");
        await fs.mkdir(path.dirname(plainPath), { recursive: true });
        await fs.writeFile(plainPath, plainBytes);

        const archive = await createBackupArchive({
          output: state.path("ordinary.tar.gz"),
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 8, 15, 4, 0, 0),
        });
        expect(archive.warnings ?? []).toEqual([]);
        const entries = await listArchiveEntries(archive.archivePath);
        const plainEntry = expectDefined(
          entries.find((entry) => entry.endsWith("/state/notes/ordinary.db")),
          "ordinary.db archive entry",
        );
        const restored = await backupRestoreCommand(createTestRuntime(), {
          archive: archive.archivePath,
          target: state.path("restored"),
        });
        expect(await fs.readFile(path.join(restored.targetPath, plainEntry))).toEqual(plainBytes);
      },
    );
  });

  it.each(["custom.sqlite", "custom.db"])(
    "fails closed when a plugin SQLite schema named %s cannot be compacted safely",
    async (filename) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-plugin-capability-",
          scenario: "minimal",
        },
        async (state) => {
          await declarePluginSqliteResources(state);
          const outputDir = state.path("backups");
          const dbPath = state.statePath("plugins", "dedicated", filename);
          await fs.mkdir(path.dirname(dbPath), { recursive: true });
          await fs.mkdir(outputDir, { recursive: true });
          const sqlite = requireNodeSqlite();
          const db = new sqlite.DatabaseSync(dbPath);
          db.function("plugin_double", { deterministic: true }, (value) => Number(value) * 2);
          db.exec(`
            CREATE TABLE records (value INTEGER NOT NULL);
            INSERT INTO records (value) VALUES (1), (2);
            CREATE INDEX records_double ON records(plugin_double(value));
          `);
          db.close();

          await expect(
            createBackupArchive({
              output: outputDir,
              includeWorkspace: false,
              nowMs: Date.UTC(2026, 4, 9, 8, 33, 0),
            }),
          ).rejects.toThrow(new RegExp(`cannot be compacted safely.*${filename}`, "iu"));
        },
      );
    },
  );
});
