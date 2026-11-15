import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "refuses a PostgreSQL anchor before SQLite-only capture exports rows (stopped=%s)",
  async (stopped) => {
    const root = await fs.realpath(dirs.make("migration-sqlite-source-"));
    const stateDir = path.join(root, "state");
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    const backupRoot = path.join(root, "retained");
    const directory = `${backupRoot}.databases`;
    const stagingRoot = path.join(root, "scratch");
    for (const parent of [path.dirname(shared), directory, stagingRoot]) {
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    }
    using source = new DatabaseSync(shared);
    source.exec(
      "PRAGMA user_version=17; CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES ('retained'); CREATE TABLE agent_databases(path TEXT);",
    );
    const input = { backupRoot, stateDir, config: {}, env: {}, stagingRoot };
    const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(input);
    source.exec(
      "CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT); INSERT INTO openclaw_engine_anchor VALUES ('11111111-1111-4111-8111-111111111111','postgres','retained_namespace');",
    );
    await expect(
      createUpdateDatabaseBackupInProcess({
        ...input,
        inspectionPlan,
        sourceEngine: "sqlite",
        stopped,
      }),
    ).rejects.toThrow("physical SQLite sources");
    if (!stopped) {
      expect(await fs.readdir(directory)).toEqual([]);
    }
  },
);
