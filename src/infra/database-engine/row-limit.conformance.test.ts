import { describe, expect, it } from "vitest";
import { acpReplayOperations } from "../../acp/event-ledger.worker.js";
import { pruneChannelIngressInDatabase } from "../../channels/message/ingress-queue.kernel.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { addSessionSuggestionInDatabase } from "../../config/sessions/session-suggestion-store.kernel.js";
import { DebugProxyCaptureStore } from "../../proxy-capture/store.sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import type { WorkerWriteOperationContext } from "../../state/worker-operation-registry.js";
import {
  redeemDevicePairingJoinCodeInWorker,
  registerDevicePairingJoinCodeInWorker,
} from "../device-pairing-join-code.worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function withState(run: (fixture: ReturnType<typeof stateFixture>) => void) {
  return admit(() => run(stateFixture()));
}
function stateFixture() {
  const database = openOpenClawStateDatabase();
  const { db } = database;
  const write: WorkerWriteOperationContext["write"] = (operation) =>
    runOpenClawStateWriteTransaction(operation, { database });
  const context: WorkerWriteOperationContext = {
    open: () => database,
    stateOptions: () => ({ path: database.path, env: process.env }),
    write,
    writeAdmitted: write,
  };
  return {
    db,
    write,
    rows: (sql: string) => db.prepare(sql).all(),
    startReplay: () =>
      acpReplayOperations["acpReplay.start"](
        {
          session: { sessionId: "fresh", sessionKey: "key", cwd: "/work", complete: true },
          now: 200,
        },
        context,
      ),
  };
}

const engines = mixedAgentConnection ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
describe.each(engines)("%s retention and single-use storage", (engine) => {
  useMixedAgentPair(engine, engine);

  it("bounds resolved suggestions by tied ID order without deleting pending or other sessions", () =>
    admit(() => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const sessionKey = "agent:main:retention",
        otherKey = "agent:main:retention-other";
      for (const key of [sessionKey, otherKey]) {
        replaceSessionEntrySync(
          { agentId: "main", storePath: database.path, sessionKey: key },
          { sessionId: key, updatedAt: 1 },
        );
      }
      runSqliteImmediateTransactionSync(database.db, () => {
        const insert = database.db.prepare(
          "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES (?, ?, 'synthetic', 'idea', 100, ?)",
        );
        for (let index = 0; index < 205; index++) {
          insert.run(
            String(index).padStart(3, "0"),
            sessionKey,
            index % 2 ? "accepted" : "dismissed",
          );
        }
        insert.run("pending", sessionKey, "pending");
        insert.run("other", otherKey, "accepted");
        addSessionSuggestionInDatabase(database, sessionKey, {
          id: "fresh",
          authorId: "synthetic",
          text: "new idea",
          createdAt: 200,
        });
      });
      const ids = (where: string, ...params: string[]) =>
        database.db.prepare(`SELECT id FROM session_suggestions WHERE ${where}`).all(...params);
      expect(ids("session_key = ? AND state <> 'pending' ORDER BY id", sessionKey)).toEqual(
        Array.from({ length: 200 }, (_, index) => ({ id: String(index + 5).padStart(3, "0") })),
      );
      expect(ids("state = 'pending' ORDER BY id")).toEqual([{ id: "fresh" }, { id: "pending" }]);
      expect(ids("session_key = ?", otherKey)).toEqual([{ id: "other" }]);
    }));

  it.each(["pending", "completed", "failed"] as const)(
    "keeps protected %s rows in their original retention slots across batches",
    (status) =>
      withState(({ db, write }) => {
        const query = getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);
        const queueName = `limit-${status}`;
        const protectedIds = Array.from({ length: 500 }, (_, i) => String(i + 18).padStart(4, "0"));
        write(() => {
          executeSqliteQuerySync(
            db,
            query.insertInto("channel_ingress_events").values(
              Array.from({ length: 520 }, (_, index) => ({
                queue_name: queueName,
                event_id: String(index).padStart(4, "0"),
                channel_id: "synthetic",
                account_id: "account",
                status,
                payload_json: "null",
                received_at: 100,
                updated_at: 100,
              })),
            ),
          );
        });
        const maxOption = `${status}MaxEntries` as const;
        const prune = (max: number, protectIds: string[]) =>
          write(() =>
            pruneChannelIngressInDatabase(db, {
              queueName,
              options: { [maxOption]: max, protectIds },
              now: 200,
            }),
          );
        const remaining = () =>
          executeSqliteQuerySync(
            db,
            query
              .selectFrom("channel_ingress_events")
              .select("event_id")
              .where("queue_name", "=", queueName)
              .orderBy("event_id", "asc"),
          ).rows.map((row) => row.event_id);
        expect(prune(2, protectedIds)).toBe(18);
        expect(remaining()).toEqual([...protectedIds, "0518", "0519"]);
        expect(prune(2, protectedIds)).toBe(0);
        expect(prune(0, protectedIds)).toBe(2);
        expect(remaining()).toEqual(protectedIds);
        expect(prune(0, [])).toBe(500);
        expect(remaining()).toEqual([]);
      }),
  );

  it.each([false, true])(
    "keeps ordered partial eviction and clamped accounting (understated=%s)",
    (understated) =>
      withState(({ db, write, rows, startReplay }) => {
        const updateJson = JSON.stringify({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "x".repeat(64 * 1024) },
        });
        const eventBytes = 34 + Buffer.byteLength(updateJson);
        write(() => {
          db.prepare("DELETE FROM acp_replay_sessions").run();
          const sessions = db.prepare(
            "INSERT INTO acp_replay_sessions (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes) VALUES (?, ?, '', 1, 100, 100, 131, ?)",
          );
          const events = db.prepare(
            "INSERT INTO acp_replay_events (session_id, seq, at, session_key, run_id, update_json, estimated_bytes) VALUES (?, ?, 100, ?, NULL, ?, ?)",
          );
          for (const id of ["a", "b", "c"]) {
            sessions.run(id, id, understated && id === "a" ? 1 : 34 + 130 * eventBytes);
            for (let seq = 1; seq <= 130; seq++) {
              events.run(id, seq, id, updateJson, eventBytes);
            }
          }
        });
        startReplay();
        expect(
          rows(
            "SELECT session_id, complete, estimated_bytes FROM acp_replay_sessions WHERE session_id <> 'fresh' ORDER BY session_id",
          ),
        ).toEqual([
          { session_id: "b", complete: 0, estimated_bytes: 34 + 66 * eventBytes },
          { session_id: "c", complete: 1, estimated_bytes: 34 + 130 * eventBytes },
        ]);
        expect(
          rows(
            "SELECT MIN(seq) AS lo, MAX(seq) AS hi, COUNT(*) AS n FROM acp_replay_events WHERE session_id = 'b'",
          ),
        ).toEqual([{ lo: 65, hi: 130, n: 66 }]);
        expect(rows("SELECT COUNT(*) AS n FROM acp_replay_events WHERE session_id = 'c'")).toEqual([
          { n: 130 },
        ]);
      }),
  );

  it("retains the first 200 sessions by recency and stable ID order", () =>
    withState(({ db, write, rows, startReplay }) => {
      write(() => {
        db.prepare("DELETE FROM acp_replay_sessions").run();
        const insert = db.prepare(
          "INSERT INTO acp_replay_sessions (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes) VALUES (?, ?, '', 1, 100, 100, 1, 100)",
        );
        for (let index = 0; index <= 200; index++) {
          const id = String(index).padStart(3, "0");
          insert.run(id, id);
        }
      });
      startReplay();
      expect(rows("SELECT session_id FROM acp_replay_sessions ORDER BY session_id")).toEqual([
        ...Array.from({ length: 199 }, (_, index) => ({
          session_id: String(index).padStart(3, "0"),
        })),
        { session_id: "fresh" },
      ]);
    }));

  it.each(["success", "missing", "expired", "malformed"] as const)(
    "consumes a %s join code and burns it once",
    (outcome) =>
      withState(({ db, write, rows }) => {
        const codes = getNodeSqliteKysely<Pick<DB, "device_pairing_join_codes">>(db);
        const shortcode = `synthetic-${outcome}`,
          now = Date.now();
        const expiresAtMs = outcome === "expired" ? now - 1 : now + 600_000;
        const payloadJson =
          outcome === "malformed"
            ? "{invalid synthetic payload"
            : '{"url":"wss://synthetic.invalid","bootstrapToken":"synthetic"}';
        write(() => {
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
        const redeem = () => write(() => redeemDevicePairingJoinCodeInWorker(db, { shortcode }));
        expect(redeem()).toEqual(
          outcome === "missing" || outcome === "expired"
            ? undefined
            : { payload_json: payloadJson, expires_at_ms: expiresAtMs },
        );
        expect(rows("SELECT shortcode FROM device_pairing_join_codes")).toEqual([]);
        expect(redeem()).toBeUndefined();
      }),
  );

  it.skipIf(engine !== "postgres")(
    "reports capture deletion changes while preserving shared blobs and missing outcomes",
    () =>
      admit(() => {
        const store = new DebugProxyCaptureStore();
        try {
          const payload = "synthetic shared capture";
          const blob = store.persistPayload(Buffer.from(payload), "text/plain");
          for (const [sessionId, eventCount] of [
            ["capture-a", 2],
            ["capture-b", 1],
          ] as const) {
            for (let index = 0; index < eventCount; index++) {
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
          expect(store.deleteSessions([" capture-a ", "capture-a", ""])).toEqual({
            sessions: 1,
            events: 2,
            blobs: 0,
          });
          expect(store.readBlob(blob.blobId)).toBe(payload);
          expect(store.getSessionEvents("capture-a")).toEqual([]);
          expect(store.getSessionEvents("capture-b")).toHaveLength(1);
          expect(store.deleteSessions(["capture-b"])).toEqual({ sessions: 1, events: 1, blobs: 1 });
          expect(store.readBlob(blob.blobId)).toBeNull();
          expect(store.deleteSessions(["capture-b"])).toEqual({ sessions: 0, events: 0, blobs: 0 });
        } finally {
          store.close();
        }
      }),
  );
});
