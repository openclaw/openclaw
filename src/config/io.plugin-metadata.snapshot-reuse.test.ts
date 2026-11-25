import { DatabaseSync } from "node:sqlite";
import { it, expect, vi } from "vitest";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readBestEffortConfig } from "./io.js";

it("reads CLI routing metadata without synchronous SQLite work", async () => {
  await withOpenClawTestState({}, async (state) => {
    await state.writeConfig({ mcp: { servers: {} } });
    const opened = openOpenClawStateDatabase();
    const pathname = opened.path;
    const payload = JSON.stringify("x".repeat(1024 * 1024));
    opened.db
      .prepare("INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,1)")
      .run("synthetic.padding", payload);
    opened.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await closeOpenClawStateDatabaseAsync();
    const writer = new DatabaseSync(pathname);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO config_machine_state VALUES ('synthetic.wal','true',2)",
    );
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    const mainSql = observeMainThreadSql();
    try {
      clearPluginMetadataLifecycleCaches();
      const config = await readBestEffortConfig({ observe: false, skipPluginValidation: true });
      expect(config.mcp).toEqual({ servers: {} });
      expect(prepare).not.toHaveBeenCalled();
      mainSql.expectIdle();
    } finally {
      vi.restoreAllMocks();
      writer.close();
    }
  });
}, 120000);
