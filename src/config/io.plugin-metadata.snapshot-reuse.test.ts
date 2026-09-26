import fs from "node:fs";
import { performance } from "node:perf_hooks";
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
    const rows = process.env.SQLITE_BOOTSTRAP_BENCHMARK === "1" ? 420 : 1;
    opened.db.exec("BEGIN");
    const insert = opened.db.prepare(
      "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,1)",
    );
    for (let n = 0; n < rows; n++) {
      insert.run(`synthetic.padding.${n}`, payload);
    }
    opened.db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    closeOpenClawStateDatabaseForTest();
    const writer = new DatabaseSync(pathname);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO config_machine_state VALUES ('synthetic.wal','true',2)",
    );
    const prepare = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync");
    const scope = readonly.withSynchronousArtifactPreservingStateSnapshot;
    let expected: unknown;
    try {
      for (let trial = 0; trial < (rows > 1 ? 3 : 1); trial++) {
        for (const mode of trial % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
          clearPluginMetadataLifecycleCaches();
          prepare.mockClear();
          const bypass =
            mode === "baseline"
              ? vi
                  .spyOn(readonly, "withSynchronousArtifactPreservingStateSnapshot")
                  .mockImplementation((operation) => operation())
              : undefined;
          const started = performance.now();
          let config;
          try {
            config = await readBestEffortConfig({ observe: false, skipPluginValidation: true });
          } finally {
            bypass?.mockRestore();
          }
          const ms = performance.now() - started;
          expected ??= config;
          expect(config).toEqual(expected);
          expect(prepare).toHaveBeenCalledTimes(mode === "baseline" ? 2 : 1);
          console.log(
            JSON.stringify({
              mode,
              trial,
              ms,
              snapshots: prepare.mock.calls.length,
              sourceBytes: fs.statSync(pathname).size,
              walBytes: fs.statSync(pathname + "-wal").size,
              rss: process.memoryUsage().rss,
            }),
          );
        }
      }
      expect(readonly.withSynchronousArtifactPreservingStateSnapshot).toBe(scope);
    } finally {
      vi.restoreAllMocks();
      writer.close();
    }
  });
}, 120000);
