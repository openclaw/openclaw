import { describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readTranscriptEventRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  createSessionActorWorkerFixture,
  type Mutation,
} from "../../config/sessions/session-actor-worker.test-support.js";
import {
  createTranscriptIndexAppenderInTransaction,
  reconcileSessionTranscriptIndexInTransaction,
} from "../../config/sessions/session-transcript-index.js";
import { searchSessionTranscriptsReadOnlySync } from "../../config/sessions/session-transcript-search.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import type { SessionTurnPlan } from "../../config/sessions/session-turn.types.js";
import {
  createTranscriptEventInserter,
  TRANSCRIPT_INSERT_BATCH_SIZE,
} from "../../config/sessions/transcript-payload.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isPostgresSqlConnection, type EngineConnection } from "../sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function projection(db: EngineConnection, sessionId: string) {
  return {
    active: db
      .prepare(
        "SELECT active_position, context_eligible, event_seq, message_position FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
      )
      .all(sessionId),
    state: db
      .prepare(
        "SELECT active_event_count, active_message_count, indexed_seq, leaf_event_id, needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
      )
      .get(sessionId),
    fts: db
      .prepare(
        "SELECT f.message_id, f.text, f.role, f.timestamp FROM session_transcript_fts_rows m JOIN session_transcript_fts f ON f.rowid = m.id WHERE m.session_id = ? ORDER BY m.id",
      )
      .all(sessionId),
    identities: db
      .prepare(
        "SELECT message_id FROM session_transcript_fts_rows WHERE session_id = ? ORDER BY id",
      )
      .all(sessionId),
  };
}

function transcriptIdentities(db: EngineConnection, sessionId: string) {
  return db
    .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
    .all(sessionId);
}

function observePgTrips(db: EngineConnection) {
  const statements: string[] = [];
  if (!isPostgresSqlConnection(db)) {
    return { statements, restore() {} };
  }
  const query = db.query.bind(db);
  const spy = vi.spyOn(db, "query").mockImplementation(
    new Proxy(query, {
      apply(target, receiver, args) {
        statements.push(args[0]);
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  return { statements, restore: () => spy.mockRestore() };
}

function message(
  id: string,
  parentId: string | null,
  role: string,
  content: string,
  timestamp: number,
  idempotencyKey?: string,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content, timestamp, ...(idempotencyKey ? { idempotencyKey } : {}) },
  };
}

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s transcript projection flush",
  (engine) => {
    useMixedAgentPair(engine, engine);

    function fixture(name: string) {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: `agent:main:projection-${name}`,
        sessionId: `projection-${name}`,
      };
      replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      return { database, scope };
    }

    it("uses one projection trip per accepted input, tool result, and final without changing persisted content", async () => {
      const seed = withEngineStoreAdmission(() => {
        const fixtureState = fixture("turn");
        runSqliteImmediateTransactionSync(fixtureState.database.db, () =>
          appendTranscriptEventsInTransaction(fixtureState.database, fixtureState.scope, [
            { type: "session", id: fixtureState.scope.sessionId, version: 3 },
            message("previous", null, "assistant", "Previous answer", 1),
          ]),
        );
        return fixtureState;
      });
      const f = createSessionActorWorkerFixture(seed, (options) =>
        withEngineStoreAdmission(() => openOpenClawAgentDatabase(options)),
      );
      const plan = (id: string, role: string, content: string, now: number): SessionTurnPlan => ({
        agentId: "main",
        sessionKey: f.scope.sessionKey,
        options: {
          expectedSessionId: f.scope.sessionId,
          sessionFile: f.scope.sessionKey,
          messages: [
            { eventId: id, message: { role, content, timestamp: now, idempotencyKey: id }, now },
          ],
        },
      });
      const execute = async (command: Mutation) => {
        await f.prepare(command);
        return withEngineStoreAdmission(() => f.mutate(command));
      };
      try {
        const before = withEngineStoreAdmission(() => f.read());
        const commands: Mutation[] = [
          {
            type: "session.actor.acceptInput",
            input: {
              target: f.target,
              commandId: "input",
              phaseId: "turn",
              expectedState: buildRestartRecoveryExpectedState(before.entry!),
              lifecycle: {},
              turn: plan("input", "user", "Needle question", 10),
            },
          },
          {
            type: "session.actor.appendToolResult",
            input: {
              target: f.target,
              commandId: "tool",
              phaseId: "turn",
              turn: plan("tool", "toolResult", "Needle tool output", 20),
            },
          },
          {
            type: "session.actor.completeTurn",
            input: {
              target: f.target,
              commandId: "final",
              phaseId: "turn",
              turn: plan("final", "assistant", "Needle answer", 30),
            },
          },
        ];
        const trips = observePgTrips(f.database.db);
        try {
          for (const command of commands) {
            expect((await execute(command)).kind).toBe("committed");
          }
        } finally {
          trips.restore();
        }
        if (engine === "postgres") {
          const writes = trips.statements.filter((sql) =>
            /(?:insert into|update)\s+"?session_transcript_(?:active_events|fts_rows|index_state)"?/iu.test(
              sql,
            ),
          );
          expect(writes).toHaveLength(3);
          expect(
            trips.statements.filter((sql) =>
              /insert into\s+"?transcript_(?:events|event_identities)"?/iu.test(sql),
            ),
          ).toHaveLength(3);
          expect(trips.statements.filter((sql) => /^BEGIN\b/iu.test(sql))).toHaveLength(3);
          expect(trips.statements.filter((sql) => /^COMMIT\b/iu.test(sql))).toHaveLength(3);
          expect(
            trips.statements.filter((sql) => /pg_advisory_xact_lock/iu.test(sql)),
          ).toHaveLength(3);
        }
        const persisted = withEngineStoreAdmission(() => ({
          transcript: readTranscriptEventRows(f.database, f.scope.sessionId).map((row) =>
            JSON.parse(row.eventJson),
          ),
          projection: projection(f.database.db, f.scope.sessionId),
          identities: transcriptIdentities(f.database.db, f.scope.sessionId),
          search: searchSessionTranscriptsReadOnlySync(
            { agentId: "main", sessionId: f.scope.sessionId, query: "Needle", order: "recent" },
            { agentId: "main", path: f.database.path },
          ),
        }));
        expect(persisted.transcript).toEqual([
          { type: "session", id: f.scope.sessionId, version: 3 },
          message("previous", null, "assistant", "Previous answer", 1),
          message("input", "previous", "user", "Needle question", 10, "input"),
          message("tool", "input", "toolResult", "Needle tool output", 20, "tool"),
          message("final", "tool", "assistant", "Needle answer", 30, "final"),
        ]);
        expect(persisted.projection).toEqual({
          active: [1, 2, 3, 4].map((event_seq, index) => ({
            active_position: index,
            context_eligible: 1,
            event_seq,
            message_position: index,
          })),
          state: {
            active_event_count: 4,
            active_message_count: 4,
            indexed_seq: 4,
            leaf_event_id: "final",
            needs_rebuild: 0,
          },
          fts: [
            { message_id: "previous", text: "Previous answer", role: "assistant", timestamp: 1 },
            { message_id: "input", text: "Needle question", role: "user", timestamp: 10 },
            { message_id: "final", text: "Needle answer", role: "assistant", timestamp: 30 },
          ],
          identities: ["previous", "input", "final"].map((message_id) => ({ message_id })),
        });
        const retry = plan("final", "assistant", "Needle answer", 30);
        expect(
          persisted.search.hits.map(({ messageId, role, timestamp }) => ({
            messageId,
            role,
            timestamp,
          })),
        ).toEqual([
          { messageId: "final", role: "assistant", timestamp: 30 },
          { messageId: "input", role: "user", timestamp: 10 },
        ]);

        expect(
          await execute({
            type: "session.actor.appendToolResult",
            input: {
              target: f.target,
              commandId: "retry",
              phaseId: "turn",
              turn: retry,
            },
          }),
        ).toMatchObject({ kind: "committed" });
        const stable = withEngineStoreAdmission(() => ({
          transcript: readTranscriptEventRows(f.database, f.scope.sessionId),
          projection: projection(f.database.db, f.scope.sessionId),
          identities: transcriptIdentities(f.database.db, f.scope.sessionId),
        }));
        expect(stable.projection).toEqual(persisted.projection);
        expect(stable.identities).toEqual(persisted.identities);
        expect(stable.transcript.map((row) => JSON.parse(row.eventJson))).toEqual(
          persisted.transcript,
        );
        // Both failure points run after the projection statement, before durable commit.
        for (const refusal of ["rollback", "revoked grant"] as const) {
          if (refusal === "rollback") {
            f.hooks.withCommit = () => {
              throw new Error(refusal);
            };
          } else {
            f.hooks.admit = (stage) => {
              if (stage === "commit") {
                throw new Error(refusal);
              }
            };
          }
          const outcome = await execute({
            type: "session.actor.completeTurn",
            input: {
              target: f.target,
              commandId: refusal,
              phaseId: "turn",
              turn: plan(`refused-${refusal}`, "assistant", "Refused answer", 100),
            },
          });
          expect(outcome).toMatchObject({ kind: "rolled-back", error: { message: refusal } });
          delete f.hooks.withCommit;
          delete f.hooks.admit;
          expect(
            withEngineStoreAdmission(() => ({
              transcript: readTranscriptEventRows(f.database, f.scope.sessionId),
              projection: projection(f.database.db, f.scope.sessionId),
              identities: transcriptIdentities(f.database.db, f.scope.sessionId),
            })),
          ).toEqual(stable);
        }
      } finally {
        f.close();
      }
    });

    it("keeps row-only batches below the chunk bound without advancing the watermark", () =>
      withEngineStoreAdmission(() => {
        const { database, scope } = fixture("batch");
        const db = database.db;
        runSqliteImmediateTransactionSync(db, () => {
          const empty = createTranscriptIndexAppenderInTransaction(db, scope.sessionId);
          const trips = observePgTrips(db);
          try {
            empty.flushRows();
            empty.flush();
          } finally {
            trips.restore();
          }
          expect(trips.statements).toEqual([]);
          expect(projection(db, scope.sessionId)).toEqual({
            active: [],
            state: undefined,
            fts: [],
            identities: [],
          });
          const append = createTranscriptIndexAppenderInTransaction(db, scope.sessionId);
          const insert = createTranscriptEventInserter(db, scope.sessionId);
          const count = TRANSCRIPT_INSERT_BATCH_SIZE + 1;
          const events = Array.from({ length: count }, (_, seq) =>
            message(
              `batch-${seq}`,
              seq ? `batch-${seq - 1}` : null,
              "user",
              `Needle ${seq}`,
              seq + 1,
            ),
          );
          insert.batch(
            events.map((event, seq) => ({
              seq,
              eventJson: JSON.stringify(event),
              createdAt: seq + 1,
            })),
          );
          for (const [seq, event] of events.entries()) {
            expect(append.append({ seq, event, eventId: event.id, createdAt: seq + 1 })).toBe(
              false,
            );
          }
          const batchTrips = observePgTrips(db);
          try {
            append.flushRows();
          } finally {
            batchTrips.restore();
          }
          if (engine === "postgres") {
            expect(batchTrips.statements).toHaveLength(2);
          }
          const rowsOnly = projection(db, scope.sessionId);
          expect(rowsOnly.state).toBeUndefined();
          expect(rowsOnly.active).toHaveLength(count);
          expect(rowsOnly.identities).toEqual(
            Array.from({ length: count }, (_, seq) => ({ message_id: `batch-${seq}` })),
          );
          expect(rowsOnly.fts).toEqual(
            Array.from({ length: count }, (_, seq) => ({
              message_id: `batch-${seq}`,
              text: `Needle ${seq}`,
              role: "user",
              timestamp: seq + 1,
            })),
          );
          const repeatedTrips = observePgTrips(db);
          try {
            append.flushRows();
          } finally {
            repeatedTrips.restore();
          }
          expect(repeatedTrips.statements).toEqual([]);
          expect(projection(db, scope.sessionId)).toEqual(rowsOnly);
          const watermarkTrips = observePgTrips(db);
          try {
            append.flush();
          } finally {
            watermarkTrips.restore();
          }
          if (engine === "postgres") {
            expect(watermarkTrips.statements).toHaveLength(1);
          }
          expect(projection(db, scope.sessionId)).toEqual({
            ...rowsOnly,
            state: {
              active_event_count: count,
              active_message_count: count,
              indexed_seq: count - 1,
              leaf_event_id: `batch-${count - 1}`,
              needs_rebuild: 0,
            },
          });
        });
      }));

    it("retains branch and compaction rebuilds when a pending flush becomes dirty", () =>
      withEngineStoreAdmission(() => {
        const { database, scope } = fixture("branch");
        const db = database.db;
        runSqliteImmediateTransactionSync(db, () => {
          const events = [
            { type: "session", id: scope.sessionId, version: 3 },
            message("root", null, "user", "Needle root", 1),
            message("abandoned", "root", "assistant", "Abandoned answer", 2),
            message("selected", "root", "assistant", "Needle selected", 3),
            {
              type: "compaction",
              id: "compact",
              parentId: "selected",
              summary: "Needle summary",
              firstKeptEntryId: "root",
              tokensBefore: 100,
              timestamp: new Date(4).toISOString(),
            },
          ];
          createTranscriptEventInserter(db, scope.sessionId).batch(
            events.map((event, seq) => ({ seq, eventJson: JSON.stringify(event), createdAt: seq })),
          );
          const append = createTranscriptIndexAppenderInTransaction(db, scope.sessionId);
          for (const [seq, event] of events.entries()) {
            expect(append.append({ seq, event, eventId: event.id, createdAt: seq })).toBe(seq >= 3);
          }
          append.flush();
          expect(projection(db, scope.sessionId).state).toEqual({
            active_event_count: 2,
            active_message_count: 2,
            indexed_seq: 2,
            leaf_event_id: "abandoned",
            needs_rebuild: 1,
          });
          expect(reconcileSessionTranscriptIndexInTransaction(db, scope.sessionId)).toBe(true);
          const current = projection(db, scope.sessionId);
          expect(current.active.map((row) => row.event_seq)).toEqual([1, 3, 4]);
          expect(current.state).toEqual({
            active_event_count: 3,
            active_message_count: 2,
            indexed_seq: 4,
            leaf_event_id: "compact",
            needs_rebuild: 0,
          });
          expect(current.fts).toEqual([
            { message_id: "root", text: "Needle root", role: "user", timestamp: 1 },
            { message_id: "selected", text: "Needle selected", role: "assistant", timestamp: 3 },
          ]);
        });
      }));
  },
);
