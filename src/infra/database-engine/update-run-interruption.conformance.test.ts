import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { requireNodeSqlite } from "../node-sqlite.js";
import { interruptedRunFixture } from "../update-run-fixture.test-support.js";
import { persistInterruptedUpdateObservation } from "../update-run-interruption-store.js";
import { readUpdateRunRecord } from "../update-run-read.kernel.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const engines = mixedAgentConnection ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
describe.each(engines)("%s interrupted update cleanup", (engine) => {
  useMixedAgentPair(engine, engine);

  it("returns persisted bounded steps and untouched columns without rereading its update", () => {
    admit(() => {
      const options = { env: { ...process.env } };
      const fixture = interruptedRunFixture(options, { version: "2026.9.4", buildId: "candidate" });
      const initial = fixture.read()!;
      const pending = persistInterruptedUpdateObservation(
        { expected: initial, detail: "Cleanup pending", cleanup: "pending" },
        options,
        () => {},
      ).run!;
      const { db } = openOpenClawStateDatabase(options);
      const ledger = getNodeSqliteKysely<Pick<DB, "update_runs">>(db);
      // Previously stored fields must not be re-encoded using this observer's redaction roots.
      const target = { version: "/synthetic/retained-target" };
      const diagnostics = Array.from({ length: 14 }, (_, index) => ({
        step: `diagnostic:fixture:${index}`,
        status: "completed",
        detail: "d".repeat(1_024),
      }));
      runOpenClawStateWriteTransaction(
        () =>
          executeSqliteQuerySync(
            db,
            ledger
              .updateTable("update_runs")
              .set({
                target_json: JSON.stringify(target),
                steps_json: JSON.stringify([...pending.steps, ...diagnostics]),
              })
              .where("run_id", "=", fixture.id),
          ),
        options,
      );
      const expected = readUpdateRunRecord(db, fixture.id)!;
      let reads = 0;
      const isRunRead = (sql: string) => /^select .* from "update_runs"/iu.test(sql);
      const observation = channel("openclaw.database.statement");
      const observer = (event: unknown) => {
        if (
          event &&
          typeof event === "object" &&
          "sql" in event &&
          typeof event.sql === "string" &&
          isRunRead(event.sql)
        ) {
          reads += 1;
        }
      };
      const authority: string[] = [];
      let result: ReturnType<typeof persistInterruptedUpdateObservation>;
      const sqlite =
        engine === "sqlite"
          ? observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype)
          : undefined;
      observation.subscribe(observer);
      try {
        result = persistInterruptedUpdateObservation(
          { expected, detail: `/synthetic/diagnostic ${"x".repeat(6_000)}`, cleanup: "unknown" },
          { ...options, redactPaths: ["/synthetic"] },
          (stage) => authority.push(stage),
        );
        expect(sqlite ? sqlite.queries.filter(isRunRead).length : reads).toBe(2);
      } finally {
        observation.unsubscribe(observer);
        sqlite?.restore();
      }
      expect(authority).toEqual(["transaction", "commit"]);
      expect(result).toMatchObject({
        accepted: true,
        run: { target, updatedAtMs: pending.updatedAtMs },
      });
      const returned = result.run!;
      const stored = readUpdateRunRecord(db, fixture.id)!;
      expect(returned).toEqual(stored);
      expect(Buffer.byteLength(JSON.stringify(returned.steps))).toBeLessThanOrEqual(16 * 1024);
      expect(returned.steps.length).toBeLessThan(expected.steps.length);
      const cleanup = returned.steps.find((step) => step.step === "reconcile:settle")!;
      expect(cleanup).toMatchObject({
        status: "failed",
        endedAtMs: pending.steps.find((step) => step.step === "reconcile:settle")!.endedAtMs,
      });
      expect(cleanup.detail).toMatch(/^\[path\]\/diagnostic x+/u);
      expect(cleanup.detail!.length).toBeLessThan(6_000);
    });
  });
});
