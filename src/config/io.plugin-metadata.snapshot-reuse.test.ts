import { DatabaseSync } from "node:sqlite";
import { it, expect, vi } from "vitest";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import * as readonly from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readBestEffortConfig } from "./io.js";

it("shares the CLI routing metadata snapshot without changing the resolved config", async () => {
  await withOpenClawTestState({}, async (state) => {
    await state.writeConfig({ mcp: { servers: {} } });
    const opened = openOpenClawStateDatabase();
    const pathname = opened.path;
    const payload = JSON.stringify("x".repeat(1024 * 1024));
    opened.db
      .prepare("INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,1)")
      .run("synthetic.padding", payload);
    opened.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    closeOpenClawStateDatabaseForTest();
    const writer = new DatabaseSync(pathname);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO config_machine_state VALUES ('synthetic.wal','true',2)",
    );
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    try {
      clearPluginMetadataLifecycleCaches();
      const bypass = vi
        .spyOn(readonly, "withSynchronousArtifactPreservingStateSnapshot")
        .mockImplementation((operation) => operation());
      const baseline = await readBestEffortConfig({ observe: false, skipPluginValidation: true });
      expect(prepare).toHaveBeenCalledTimes(2);
      bypass.mockRestore();
      clearPluginMetadataLifecycleCaches();
      prepare.mockClear();
      const config = await readBestEffortConfig({ observe: false, skipPluginValidation: true });
      expect(config).toEqual(baseline);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      writer.close();
    }
  });
}, 120000);
