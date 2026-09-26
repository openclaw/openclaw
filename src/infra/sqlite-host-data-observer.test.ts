import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "./node-sqlite.js";

afterEach(() => vi.restoreAllMocks());

describe("host data SQL observation", () => {
  it.each(["state", "agent", "memory", "unknown", "raw"] as const)(
    "detects every host SQL operation on %s data, including statements prepared before observation",
    async (kind) => {
      await withOpenClawTestState({ label: "sql-observer-data" }, async (state) => {
        const native = requireNodeSqlite();
        const location =
          kind === "memory" || kind === "unknown" || kind === "raw"
            ? ":memory:"
            : kind === "state"
              ? resolveOpenClawStateSqlitePath(state.env)
              : path.join(state.stateDir, "agent.sqlite");
        if (location !== ":memory:") {
          mkdirSync(path.dirname(location), { recursive: true });
        }
        const db =
          kind === "raw" ? new native.DatabaseSync(location) : openNodeSqliteDatabase(location);
        const retained = db.prepare("SELECT 1 AS value");
        const retainedDdl = db.prepare("CREATE TABLE retained_data (value INTEGER)");
        if (kind === "unknown") {
          vi.spyOn(db, "location").mockReturnValue(null);
        }
        const observer = observeHostDataSql();
        try {
          retained.get();
          expect(observer.calls[2]).toHaveBeenCalledExactlyOnceWith();
          observer.calls.forEach((call) => call.mockClear());
          retainedDdl.run();
          expect(observer.calls[4]).toHaveBeenCalledExactlyOnceWith();
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
