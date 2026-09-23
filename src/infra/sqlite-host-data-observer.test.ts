import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { acquireStateDatabaseCoordinator } from "./state-database-coordinator.js";

afterEach(() => vi.restoreAllMocks());

describe("host data SQL observation", () => {
  it("excludes only the captured lifecycle database, not another state's coordinator", async () => {
    await withOpenClawTestState({ label: "sql-observer-control" }, async (state) => {
      const observer = observeHostDataSql(state.env);
      try {
        const own = acquireStateDatabaseCoordinator({
          databasePath: resolveOpenClawStateSqlitePath(state.env),
        });
        own.release();
        expect(observer.calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
        const other = acquireStateDatabaseCoordinator({
          databasePath: path.join(state.stateDir, "other.sqlite"),
        });
        other.release();
        expect(observer.calls[1]).toHaveBeenCalled();
      } finally {
        observer.restore();
      }
    });
  });

  it.each(["state", "agent", "memory", "unknown"] as const)(
    "detects every host SQL operation on %s data, including statements prepared before observation",
    async (kind) => {
      await withOpenClawTestState({ label: "sql-observer-data" }, async (state) => {
        const native = requireNodeSqlite();
        const location =
          kind === "memory" || kind === "unknown"
            ? ":memory:"
            : kind === "state"
              ? resolveOpenClawStateSqlitePath(state.env)
              : path.join(state.stateDir, "agent.sqlite");
        if (location !== ":memory:") {
          mkdirSync(path.dirname(location), { recursive: true });
        }
        const db = new native.DatabaseSync(location);
        const retained = db.prepare("SELECT 1 AS value");
        if (kind === "unknown") {
          vi.spyOn(db, "location").mockReturnValue(null);
        }
        const observer = observeHostDataSql(state.env);
        try {
          retained.get();
          expect(observer.calls[2]).toHaveBeenCalledExactlyOnceWith();
          observer.calls.forEach((call) => call.mockClear());
          db.exec("CREATE TABLE plugin_data (value INTEGER)");
          db.prepare("INSERT INTO plugin_data VALUES (?)").run(1);
          const read = db.prepare("SELECT value FROM plugin_data");
          expect(read.get()).toEqual({ value: 1 });
          expect(read.all()).toEqual([{ value: 1 }]);
          expect([...read.iterate()]).toEqual([{ value: 1 }]);
          expect(observer.calls.every((call) => call.mock.calls.length > 0)).toBe(true);
        } finally {
          observer.restore();
          db.close();
        }
      });
    },
  );
});
