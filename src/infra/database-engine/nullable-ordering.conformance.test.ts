import { describe, expect, it } from "vitest";
import { readSandboxRuntimeIdsInDatabase } from "../../agents/sandbox/registry.kernel.js";
import { failedRecord } from "../../channels/message/ingress-queue.codec.js";
import { listChannelIngressRowsInDatabase } from "../../channels/message/ingress-queue.kernel.js";
import { readSelectedSessionEntryRows } from "../../config/sessions/session-accessor.sqlite-entry-select.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { participantRecordsBySessionKey } from "../../config/sessions/session-accessor.sqlite-participant-projection.js";
import { hydrateSessionActorState } from "../../config/sessions/session-actor-hydration.worker.js";
import { sessionActorFileTarget } from "../../config/sessions/session-actor-worker.test-support.js";
import { listSessionTranscriptInstances } from "../../config/sessions/session-history-read.js";
import { queryDebugProxyCapturePreset } from "../../proxy-capture/store-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

// Independent expected orders include NULLs and ties; both real engines use their query owners.
describe.each(mixedAgentConnection ? (["sqlite", "postgres"] as const) : (["sqlite"] as const))(
  "%s nullable result ordering",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("puts missing hosts first among tied proxy preset counts", () =>
      withEngineStoreAdmission(() => {
        const { db } = openOpenClawStateDatabase();
        runSqliteImmediateTransactionSync(db, () => {
          db.prepare(
            "INSERT INTO capture_sessions (id, started_at, mode, source_scope, source_process) VALUES ('nullable-hosts', 1, 'test', 'test', 'test')",
          ).run();
          const insert = db.prepare(
            "INSERT INTO capture_events (session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id, method, host, path, status, data_sha256) VALUES ('nullable-hosts', 1, 'test', 'test', 'http', 'outbound', ?, 'flow', 'GET', ?, '/x?v=1', 429, 'same')",
          );
          for (const kind of ["request", "response", "ws-frame", "error"]) {
            for (const host of ["b.example", null, "top.example", "a.example"]) {
              for (let index = 0; index < (host === "top.example" ? 3 : 2); index++) {
                insert.run(kind, host);
              }
            }
          }
        });
        for (const preset of [
          "double-sends",
          "retry-storms",
          "cache-busting",
          "ws-duplicate-frames",
          "error-bursts",
        ] as const) {
          expect
            .soft(
              queryDebugProxyCapturePreset(db, preset, "nullable-hosts").map((row) => row.host),
              preset,
            )
            .toEqual(["top.example", null, "a.example", "b.example"]);
        }
      }));

    it("includes undated dead letters first before applying the listing limit", () =>
      withEngineStoreAdmission(() => {
        const { db } = openOpenClawStateDatabase();
        runSqliteImmediateTransactionSync(db, () => {
          const insert = db.prepare(
            "INSERT INTO channel_ingress_events (queue_name, event_id, channel_id, account_id, status, payload_json, received_at, updated_at, failed_at, failed_reason) VALUES (?, ?, 'test', 'default', ?, '{}', 1, 99, ?, 'test')",
          );
          for (const [id, time] of [
            ["null-z", null],
            ["tie-b", 10],
            ["newest", 20],
            ["null-a", null],
            ["tie-a", 10],
          ] as const) {
            insert.run("nullable-failures", id, "failed", time);
          }
          insert.run("other-queue", "other", "failed", null);
          insert.run("nullable-failures", "pending", "pending", null);
        });
        const read = (limit: number | "all") =>
          listChannelIngressRowsInDatabase(db, {
            queueName: "nullable-failures",
            status: "failed",
            limit,
          }).map((row) => failedRecord(row));
        expect
          .soft(read("all").map((row) => row.id))
          .toEqual(["null-a", "null-z", "tie-a", "tie-b", "newest"]);
        expect(read(2).map((row) => ({ id: row.id, failedAt: row.failedAt }))).toEqual([
          { id: "null-a", failedAt: 99 },
          { id: "null-z", failedAt: 99 },
        ]);
      }));

    it("puts unprompted participants first in standalone, fused, and actor reads", () =>
      withEngineStoreAdmission(() => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const key = "agent:main:nullable-participants";
        runSqliteImmediateTransactionSync(database.db, () => {
          writeSessionEntry(database, key, { sessionId: "nullable-participants", updatedAt: 1 });
          const insert = database.db.prepare(
            "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at) VALUES (?, ?, ?, 1, ?)",
          );
          for (const [type, id, time] of [
            ["profile", "b", 10],
            ["agent", "z", null],
            ["profile", "a", null],
            ["agent", "b", 10],
            ["agent", "c", 20],
            ["agent", "a", null],
          ] as const) {
            insert.run(key, JSON.stringify({ type }), id, time);
          }
        });
        const expected = [
          { type: "agent", id: "a" },
          { type: "profile", id: "a" },
          { type: "agent", id: "z" },
          { type: "agent", id: "b" },
          { type: "profile", id: "b" },
          { type: "agent", id: "c" },
        ];
        expect
          .soft(
            participantRecordsBySessionKey(database.db, [key])
              .get(key)
              ?.map((row) => row.identity),
            "standalone",
          )
          .toEqual(expected);
        const [selected] = readSelectedSessionEntryRows(database, key, "full", undefined, {
          includeWindowFacts: true,
        });
        const tuples: [string, string][] = JSON.parse(selected!.participant_identities_json!);
        expect
          .soft(
            tuples.map(([namespace, id]) => Object.assign({}, JSON.parse(namespace), { id })),
            "fused",
          )
          .toEqual(expected);
        const actor = hydrateSessionActorState(
          database,
          sessionActorFileTarget(database, key),
          { epoch: "nullable-order", sequence: 0 },
          "nullable-order",
        );
        expect(actor.hot.participants.map((row) => row.identity)).toEqual(expected);
      }));

    it("puts unused sandbox runtimes last after filtering, with stable name ties", () =>
      withEngineStoreAdmission(() => {
        const { db } = openOpenClawStateDatabase();
        runSqliteImmediateTransactionSync(db, () => {
          const insert = db.prepare(
            "INSERT INTO sandbox_registry_entries (registry_kind, container_name, session_key, backend_id, last_used_at_ms, entry_json, updated_at) VALUES ('container', ?, ?, ?, ?, '{}', 1)",
          );
          for (const [name, time] of [
            ["null-z", null],
            ["tie-b", 10],
            ["newest", 20],
            ["null-a", null],
            ["tie-a", 10],
          ] as const) {
            insert.run(name, "nullable-sandbox", "docker", time);
          }
          insert.run("other-backend", "nullable-sandbox", "other", 30);
          insert.run("other-scope", "other", "docker", 30);
        });
        expect(
          readSandboxRuntimeIdsInDatabase(db, {
            backendId: "docker",
            scopeKey: "nullable-sandbox",
          }),
        ).toEqual(["newest", "tie-a", "tie-b", "null-a", "null-z"]);
      }));

    it("puts windows without transcripts last only when they are included", () =>
      withEngineStoreAdmission(() => {
        const database = openOpenClawAgentDatabase({ agentId: "windows" });
        runSqliteImmediateTransactionSync(database.db, () => {
          const update = database.db.prepare(
            "UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?",
          );
          for (const [id, time] of [
            ["window-null-z", null],
            ["window-tie-b", 10],
            ["window-newest", 20],
            ["window-null-a", null],
            ["window-tie-a", 10],
          ] as const) {
            writeSessionEntry(database, `agent:windows:${id}`, { sessionId: id, updatedAt: 1 });
            update.run(time, id);
          }
        });
        const read = (includeAllWindows: boolean) =>
          listSessionTranscriptInstances(
            { agentId: "windows", storePath: database.path },
            { includeAllWindows },
          ).map((row) => row.sessionId);
        expect
          .soft(read(true))
          .toEqual([
            "window-newest",
            "window-tie-a",
            "window-tie-b",
            "window-null-a",
            "window-null-z",
          ]);
        expect(read(false)).toEqual(["window-newest", "window-tie-a", "window-tie-b"]);
      }));
  },
);
