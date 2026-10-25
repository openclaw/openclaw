import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { DebugProxyCaptureStore } from "../../proxy-capture/store.sqlite.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  redeemDevicePairingJoinCodeInWorker,
  registerDevicePairingJoinCodeInWorker,
} from "../device-pairing-join-code.worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../sql-connection.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";
import { createSqlStatementObserver } from "./sql-statement-observer.test-support.js";

function countStatements<T>(db: EngineConnection, matches: (sql: string) => boolean, run: () => T) {
  let statements = 0;
  const observation = channel("openclaw.database.statement");
  const observe = createSqlStatementObserver(matches, () => {
    statements += 1;
  });
  const native = isPostgresSqlConnection(db)
    ? undefined
    : trackSqliteStatementExecutions(db, ["target"], (sql) => (matches(sql) ? "target" : null));
  observation.subscribe(observe);
  try {
    const result = run();
    return { result, statements: native?.counts.target ?? statements };
  } finally {
    observation.unsubscribe(observe);
    native?.restore();
  }
}

const engines = mixedAgentConnection ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
describe.each(engines)("%s SQL probe removal", (engine) => {
  useMixedAgentPair(engine, engine);

  it.each(["success", "missing", "expired", "malformed"] as const)(
    "consumes a %s join code in two statements and burns it once",
    (outcome) => {
      admit(() => {
        const database = openOpenClawStateDatabase();
        const { db } = database;
        const codes = getNodeSqliteKysely<Pick<DB, "device_pairing_join_codes">>(db);
        const shortcode = `synthetic-${outcome}`;
        const now = Date.now();
        const expiresAtMs = outcome === "expired" ? now - 1 : now + 600_000;
        const payloadJson =
          outcome === "malformed"
            ? "{invalid synthetic payload"
            : '{"url":"wss://synthetic.invalid","bootstrapToken":"synthetic"}';
        const transact = <T>(run: () => T) => runOpenClawStateWriteTransaction(run, { database });
        transact(() => {
          registerDevicePairingJoinCodeInWorker(db, {
            shortcode,
            payloadJson,
            createdAtMs: now - 2,
            expiresAtMs,
          });
          if (outcome === "missing") {
            executeSqliteQuerySync(
              db,
              codes.deleteFrom("device_pairing_join_codes").where("shortcode", "=", shortcode),
            );
          }
        });

        const measured = countStatements(
          db,
          (sql) => /\bdevice_pairing_join_codes\b/u.test(sql),
          () => transact(() => redeemDevicePairingJoinCodeInWorker(db, { shortcode })),
        );

        expect(measured.result).toEqual(
          outcome === "missing" || outcome === "expired"
            ? undefined
            : { payload_json: payloadJson, expires_at_ms: expiresAtMs },
        );
        expect(
          executeSqliteQuerySync(
            db,
            codes
              .selectFrom("device_pairing_join_codes")
              .select("shortcode")
              .where("shortcode", "=", shortcode),
          ).rows,
        ).toEqual([]);
        expect(
          transact(() => redeemDevicePairingJoinCodeInWorker(db, { shortcode })),
        ).toBeUndefined();
        expect(measured.statements).toBe(2);
      });
    },
  );

  it.skipIf(engine !== "postgres")(
    "reports capture deletion changes while preserving shared blobs and missing outcomes",
    () => {
      admit(() => {
        const store = new DebugProxyCaptureStore();
        try {
          const payload = "synthetic shared capture";
          const blob = store.persistPayload(Buffer.from(payload), "text/plain");
          for (const [sessionId, eventCount] of [
            ["capture-a", 2],
            ["capture-b", 1],
          ] as const) {
            for (let index = 0; index < eventCount; index += 1) {
              store.recordEvent({
                sessionId,
                ts: index + 1,
                sourceScope: "openclaw",
                sourceProcess: "synthetic",
                protocol: "https",
                direction: "outbound",
                kind: "request",
                flowId: `${sessionId}-${index}`,
                dataBlobId: blob.blobId,
              });
            }
          }
          const remove = (sessionIds: string[]) =>
            countStatements(
              store.db,
              (sql) => /\bcapture_(?:sessions|events|blobs)\b/u.test(sql),
              () => store.deleteSessions(sessionIds),
            );

          const shared = remove([" capture-a ", "capture-a", ""]);
          expect(shared.result).toEqual({ sessions: 1, events: 2, blobs: 0 });
          expect(store.readBlob(blob.blobId)).toBe(payload);
          expect(store.getSessionEvents("capture-a")).toEqual([]);
          expect(store.getSessionEvents("capture-b")).toHaveLength(1);

          const last = remove(["capture-b"]);
          expect(last.result).toEqual({ sessions: 1, events: 1, blobs: 1 });
          expect(store.readBlob(blob.blobId)).toBeNull();
          const missing = remove(["capture-b"]);
          expect(missing.result).toEqual({ sessions: 0, events: 0, blobs: 0 });
          expect([shared.statements, last.statements, missing.statements]).toEqual([4, 5, 3]);
        } finally {
          store.close();
        }
      });
    },
  );
});
