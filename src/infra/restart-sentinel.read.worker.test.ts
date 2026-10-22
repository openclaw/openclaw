import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { getOpenClawStateFeatureSchemaSql } from "../state/openclaw-state-feature-schema.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { buildRestartSentinelRow } from "./restart-sentinel-store.js";
import { restartSentinelReadOperations } from "./restart-sentinel.read.worker.js";

it.each([
  { current: null, floor: null, invalid: false, revision: null },
  { current: 20, floor: null, invalid: false, revision: 20 },
  { current: null, floor: 30, invalid: false, revision: 30 },
  { current: 20, floor: 30, invalid: false, revision: 30 },
  { current: 30, floor: 20, invalid: false, revision: 30 },
  { current: 20, floor: 30, invalid: true, revision: 30 },
])("reads one snapshot for current=$current, floor=$floor, invalid=$invalid", (scenario) => {
  const { DatabaseSync, StatementSync } = requireNodeSqlite();
  const db = new DatabaseSync(":memory:");
  const payload = { kind: "restart", status: "ok", ts: 1 } as const;
  const insert = (key: string, revision: number, version = 1) =>
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Pick<DB, "gateway_restart_sentinel">>(db)
        .insertInto("gateway_restart_sentinel")
        .values({ ...buildRestartSentinelRow(payload, revision, key), version }),
    );
  try {
    db.exec(getOpenClawStateFeatureSchemaSql("gateway_restart_sentinel"));
    // Unrelated receipt rows must not affect the current notification or its floor.
    insert("latest-update-install", 100);
    if (scenario.current !== null) {
      insert("current", scenario.current, scenario.invalid ? 2 : 1);
    }
    if (scenario.floor !== null) {
      insert("revision-floor", scenario.floor);
    }
    const reads = observeSqliteReadSql(StatementSync.prototype);
    const exec = vi.spyOn(db, "exec");
    try {
      expect(restartSentinelReadOperations["restartSentinel.snapshot"](undefined, db)).toEqual({
        type: "restartSentinel.snapshot",
        snapshot: {
          sentinel:
            scenario.current === null || scenario.invalid
              ? null
              : { version: 1, payload, revision: scenario.current },
          revision: scenario.revision,
        },
      });
      expect(reads.queries).toHaveLength(1);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      reads.restore();
      exec.mockRestore();
    }
  } finally {
    db.close();
  }
});
