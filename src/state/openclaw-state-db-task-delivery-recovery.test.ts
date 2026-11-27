import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as privateDirectory from "../infra/sqlite-private-directory.js";
import * as snapshotStaging from "../infra/sqlite-snapshot-staging.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { withStateDatabaseSchemaMaintenanceAsync } from "../infra/state-database-maintenance.js";
import { prepareOrphanTaskDeliveryRecovery } from "./openclaw-state-db-task-delivery-recovery.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["unchanged", "payload changed", "shape changed", "preservation failed"] as const)(
  "preserves exact orphan evidence before the write transaction (%s)",
  async (change) => {
    const directory = directories.make("task-delivery-preparation-");
    const pathname = path.join(directory, "state.sqlite");
    const cache = path.join(directory, "cache");
    vi.stubEnv("XDG_CACHE_HOME", cache);
    const snapshotDirectories: string[] = [];
    const createSnapshot = snapshotStaging.createSqliteSnapshotStagingDirectory;
    vi.spyOn(snapshotStaging, "createSqliteSnapshotStagingDirectory").mockImplementation(
      async (...args) => {
        const allocated = await createSnapshot(...args);
        snapshotDirectories.push(allocated);
        return allocated;
      },
    );
    const expectSnapshotsReleased = () => {
      for (const allocated of snapshotDirectories) {
        expect(fs.existsSync(allocated)).toBe(false);
      }
    };
    using database = new DatabaseSync(pathname);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER) STRICT;
      INSERT INTO schema_meta VALUES ('primary', 'global', 1);
      CREATE TABLE task_runs (task_id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY REFERENCES task_runs(task_id) ON DELETE CASCADE,
        requester_origin_json TEXT, last_notified_event_at INTEGER
      ) STRICT;
      INSERT INTO task_runs VALUES ('healthy');
      INSERT INTO task_delivery_state VALUES ('healthy', 'retained', 1);
    `);
    const payload = '  {"channel":"synthetic"}\n\u0000';
    const timestamp = 9007199254740993n;
    database
      .prepare("INSERT INTO task_delivery_state VALUES ('orphan', ?, ?)")
      .run(payload, timestamp);
    const row = () => {
      const statement = database.prepare(
        "SELECT * FROM task_delivery_state WHERE task_id = 'orphan'",
      );
      statement.setReadBigInts(true);
      return statement.get();
    };
    const before = row();

    await withStateDatabaseSchemaMaintenanceAsync({ databasePath: pathname }, async () => {
      if (change === "preservation failed") {
        const create = privateDirectory.createPrivateSqliteTempDirectory;
        vi.spyOn(privateDirectory, "createPrivateSqliteTempDirectory").mockImplementation(
          async (...args) => {
            const recovery = await create(...args);
            // An exclusive backup creation must fail without leaving incomplete owned output.
            if (args[1].startsWith("openclaw-task-delivery-recovery-")) {
              fs.writeFileSync(path.join(recovery, "database.sqlite"), "incomplete fixture output");
            }
            return recovery;
          },
        );
        await expect(prepareOrphanTaskDeliveryRecovery(database, pathname)).rejects.toThrow(
          /EEXIST/,
        );
        expect(row()).toEqual(before);
        expect(database.isTransaction).toBe(false);
        expect(
          fs
            .readdirSync(directory)
            .filter((name) => name.startsWith("openclaw-task-delivery-recovery-")),
        ).toEqual([]);
        expectSnapshotsReleased();
        return;
      }
      const apply = await prepareOrphanTaskDeliveryRecovery(database, pathname);
      expect(database.isTransaction).toBe(false);
      expect(row()).toEqual(before);
      const recoveries = fs
        .readdirSync(directory)
        .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
      expect(recoveries).toHaveLength(1);
      const recovery = path.join(directory, recoveries[0]!);
      expect(
        JSON.parse(fs.readFileSync(path.join(recovery, "orphan-rows.jsonl"), "utf8")),
      ).toMatchObject({
        task_id: "orphan",
        requester_origin_json: payload,
        last_notified_event_at: timestamp.toString(),
      });
      using backup = new DatabaseSync(path.join(recovery, "database.sqlite"), { readOnly: true });
      expect(
        backup
          .prepare("SELECT requester_origin_json FROM task_delivery_state WHERE task_id = 'orphan'")
          .get(),
      ).toEqual({ requester_origin_json: payload });
      expectSnapshotsReleased();

      if (change === "payload changed") {
        database
          .prepare(
            "UPDATE task_delivery_state SET requester_origin_json = ? WHERE task_id = 'orphan'",
          )
          .run("changed payload");
      } else if (change === "shape changed") {
        database.exec(
          "CREATE TRIGGER unknown_delivery_cleanup AFTER DELETE ON task_delivery_state BEGIN SELECT 1; END",
        );
      }
      const current = row();
      const repair = () =>
        runSqliteImmediateTransactionSync(database, apply, {
          databaseLabel: pathname,
          operationLabel: "fixture.orphan-repair",
        });
      if (change === "unchanged") {
        expect(repair()).toEqual([
          expect.stringContaining("Preserved and recovered 1 orphan task delivery rows"),
        ]);
        expect(row()).toBeUndefined();
        expect(database.prepare("SELECT task_id FROM task_delivery_state").all()).toEqual([
          { task_id: "healthy" },
        ]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } else {
        expect(repair).toThrow(change === "payload changed" ? /current payload/ : /unrecognized/);
        expect(row()).toEqual(current);
      }
    });
  },
);
