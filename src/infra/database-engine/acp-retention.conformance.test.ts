import { describe, expect, it } from "vitest";
import { acpReplayOperations } from "../../acp/event-ledger.worker.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import type { WorkerWriteOperationContext } from "../../state/worker-operation-registry.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(`${engine} ACP retention`, () => {
    useMixedAgentPair(engine, engine);

    it.each([false, true])(
      "keeps ordered partial eviction and clamped accounting (understated=%s)",
      (understated) =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          const { db } = database;
          const updateJson = JSON.stringify({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x".repeat(64 * 1024) },
          });
          const eventBytes = 34 + Buffer.byteLength(updateJson);
          runOpenClawStateWriteTransaction(
            () => {
              db.prepare("DELETE FROM acp_replay_sessions").run();
              for (const id of ["a", "b", "c"]) {
                db.prepare(
                  "INSERT INTO acp_replay_sessions (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes) VALUES (?, ?, '', 1, 100, 100, 131, ?)",
                ).run(id, id, understated && id === "a" ? 1 : 34 + 130 * eventBytes);
                const insert = db.prepare(
                  "INSERT INTO acp_replay_events (session_id, seq, at, session_key, run_id, update_json, estimated_bytes) VALUES (?, ?, 100, ?, NULL, ?, ?)",
                );
                for (let seq = 1; seq <= 130; seq++) {
                  insert.run(id, seq, id, updateJson, eventBytes);
                }
              }
            },
            { database },
          );
          const context: WorkerWriteOperationContext = {
            open: () => database,
            stateOptions: () => ({ path: database.path, env: process.env }),
            write: (operation) => runOpenClawStateWriteTransaction(operation, { database }),
            writeAdmitted: (operation) => runOpenClawStateWriteTransaction(operation, { database }),
          };
          acpReplayOperations["acpReplay.start"](
            {
              session: { sessionId: "fresh", sessionKey: "key", cwd: "/work", complete: true },
              now: 200,
            },
            context,
          );
          expect(
            db
              .prepare(
                "SELECT session_id, complete, estimated_bytes FROM acp_replay_sessions WHERE session_id <> 'fresh' ORDER BY session_id",
              )
              .all(),
          ).toEqual([
            { session_id: "b", complete: 0, estimated_bytes: 34 + 66 * eventBytes },
            { session_id: "c", complete: 1, estimated_bytes: 34 + 130 * eventBytes },
          ]);
          expect(
            db
              .prepare(
                "SELECT MIN(seq) AS lo, MAX(seq) AS hi, COUNT(*) AS n FROM acp_replay_events WHERE session_id = 'b'",
              )
              .get(),
          ).toEqual({ lo: 65, hi: 130, n: 66 });
          expect(
            db.prepare("SELECT COUNT(*) AS n FROM acp_replay_events WHERE session_id = 'c'").get(),
          ).toEqual({ n: 130 });
        }),
    );

    it("retains the first 200 sessions by recency and stable ID order", () =>
      withEngineStoreAdmission(() => {
        const database = openOpenClawStateDatabase();
        const { db } = database;
        runOpenClawStateWriteTransaction(
          () => {
            db.prepare("DELETE FROM acp_replay_sessions").run();
            const insert = db.prepare(
              "INSERT INTO acp_replay_sessions (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes) VALUES (?, ?, '', 1, 100, 100, 1, 100)",
            );
            for (let index = 0; index <= 200; index++) {
              const id = String(index).padStart(3, "0");
              insert.run(id, id);
            }
          },
          { database },
        );
        const context: WorkerWriteOperationContext = {
          open: () => database,
          stateOptions: () => ({ path: database.path, env: process.env }),
          write: (operation) => runOpenClawStateWriteTransaction(operation, { database }),
          writeAdmitted: (operation) => runOpenClawStateWriteTransaction(operation, { database }),
        };
        acpReplayOperations["acpReplay.start"](
          {
            session: { sessionId: "fresh", sessionKey: "key", cwd: "/work", complete: true },
            now: 200,
          },
          context,
        );
        expect(
          db.prepare("SELECT session_id FROM acp_replay_sessions ORDER BY session_id").all(),
        ).toEqual([
          ...Array.from({ length: 199 }, (_, index) => ({
            session_id: String(index).padStart(3, "0"),
          })),
          { session_id: "fresh" },
        ]);
      }));
  });
}
