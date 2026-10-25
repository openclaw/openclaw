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
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function projection(db: EngineConnection, sessionId: string) {
  const rows = (sql: string) => db.prepare(sql).all(sessionId);
  return {
    active: rows(
      "SELECT active_position, context_eligible, event_seq, message_position FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
    ),
    state: db
      .prepare(
        "SELECT active_event_count, active_message_count, indexed_seq, leaf_event_id, needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
      )
      .get(sessionId),
    fts: rows(
      "SELECT f.message_id, f.text, f.role, f.timestamp FROM session_transcript_fts_rows m JOIN session_transcript_fts f ON f.rowid = m.id WHERE m.session_id = ? ORDER BY m.id",
    ),
    identities: rows(
      "SELECT message_id FROM session_transcript_fts_rows WHERE session_id = ? ORDER BY id",
    ),
  };
}

const indexState = (events: number, messages: number, seq: number, leaf: string, dirty = 0) => ({
  active_event_count: events,
  active_message_count: messages,
  indexed_seq: seq,
  leaf_event_id: leaf,
  needs_rebuild: dirty,
});

function transcriptWindow(db: EngineConnection, sessionId: string) {
  return db
    .prepare(
      "SELECT updated_at, transcript_updated_at, row_transcript_updated_at, row_transcript_json FROM session_windows WHERE session_id = ?",
    )
    .get(sessionId);
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

function expectTrips(db: EngineConnection, run: () => void, count: number) {
  const trips = observePgTrips(db);
  try {
    run();
  } finally {
    trips.restore();
  }
  expect(trips.statements).toHaveLength(isPostgresSqlConnection(db) ? count : 0);
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
      const seed = admit(() => {
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
        admit(() => openOpenClawAgentDatabase(options)),
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
        return admit(() => f.mutate(command));
      };
      const mutation = (
        type: "session.actor.appendToolResult" | "session.actor.completeTurn",
        commandId: string,
        turn: SessionTurnPlan,
      ): Mutation => ({ type, input: { target: f.target, commandId, phaseId: "turn", turn } });
      const readPersisted = () =>
        admit(() => ({
          transcript: readTranscriptEventRows(f.database, f.scope.sessionId),
          projection: projection(f.database.db, f.scope.sessionId),
          window: transcriptWindow(f.database.db, f.scope.sessionId),
          identities: transcriptIdentities(f.database.db, f.scope.sessionId),
        }));
      try {
        const before = admit(() => f.read());
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
          mutation(
            "session.actor.appendToolResult",
            "tool",
            plan("tool", "toolResult", "Needle tool output", 20),
          ),
          mutation(
            "session.actor.completeTurn",
            "final",
            plan("final", "assistant", "Needle answer", 30),
          ),
        ];
        let expectedUpdatedAt: number | null | undefined;
        const trips = observePgTrips(f.database.db);
        try {
          for (const command of commands) {
            const outcome = await execute(command);
            expect(outcome.kind).toBe("committed");
            if (outcome.kind === "committed") {
              expectedUpdatedAt = outcome.receipt.transcript.after.updatedAt;
            }
          }
        } finally {
          trips.restore();
        }
        if (engine === "postgres") {
          const writes = trips.statements.filter(
            (sql) =>
              /(?:insert into|update)\s+"?session_transcript_(?:active_events|fts_rows|index_state)"?/iu.test(
                sql,
              ) || /update\s+"?session_windows"?\s+set[^;]*"transcript_updated_at"/iu.test(sql),
          );
          expect(writes).toHaveLength(3);
          expect(
            writes.every((sql) =>
              /update\s+"?session_windows"?\s+set[^;]*"transcript_updated_at"/iu.test(sql),
            ),
          ).toBe(true);
          expect(
            [
              /insert into\s+"?transcript_(?:events|event_identities)"?/iu,
              /^BEGIN\b/iu,
              /^COMMIT\b/iu,
              /pg_advisory_xact_lock/iu,
            ].map((pattern) => trips.statements.filter((sql) => pattern.test(sql)).length),
          ).toEqual([3, 3, 3, 3]);
        }
        const persisted = readPersisted();
        const search = admit(() =>
          searchSessionTranscriptsReadOnlySync(
            { agentId: "main", sessionId: f.scope.sessionId, query: "Needle", order: "recent" },
            { agentId: "main", path: f.database.path },
          ),
        );
        expect(persisted.transcript.map((row) => JSON.parse(row.eventJson))).toEqual([
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
          state: indexState(4, 4, 4, "final"),
          fts: [
            { message_id: "previous", text: "Previous answer", role: "assistant", timestamp: 1 },
            { message_id: "input", text: "Needle question", role: "user", timestamp: 10 },
            { message_id: "final", text: "Needle answer", role: "assistant", timestamp: 30 },
          ],
          identities: ["previous", "input", "final"].map((message_id) => ({ message_id })),
        });
        expect(persisted.window).toMatchObject({
          updated_at: 30,
          transcript_updated_at: expectedUpdatedAt,
          row_transcript_updated_at: expectedUpdatedAt,
          row_transcript_json: expect.stringContaining("Needle answer"),
        });
        const retry = plan("final", "assistant", "Needle answer", 30);
        expect(
          search.hits.map(({ messageId, role, timestamp }) => ({
            messageId,
            role,
            timestamp,
          })),
        ).toEqual([
          { messageId: "final", role: "assistant", timestamp: 30 },
          { messageId: "input", role: "user", timestamp: 10 },
        ]);

        expect(
          await execute(mutation("session.actor.appendToolResult", "retry", retry)),
        ).toMatchObject({ kind: "committed" });
        const stable = readPersisted();
        const decoded = (snapshot: typeof stable) => ({
          ...snapshot,
          transcript: snapshot.transcript.map((row) => JSON.parse(row.eventJson)),
        });
        expect(decoded(stable)).toEqual(decoded(persisted));
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
          const outcome = await execute(
            mutation(
              "session.actor.completeTurn",
              refusal,
              plan(`refused-${refusal}`, "assistant", "Refused answer", 100),
            ),
          );
          expect(outcome).toMatchObject({ kind: "rolled-back", error: { message: refusal } });
          delete f.hooks.withCommit;
          delete f.hooks.admit;
          expect(readPersisted()).toEqual(stable);
        }
      } finally {
        f.close();
      }
    });

    it("keeps row-only batches below the chunk bound without advancing the watermark", () =>
      admit(() => {
        const { database, scope } = fixture("batch");
        const db = database.db;
        runSqliteImmediateTransactionSync(db, () => {
          const empty = createTranscriptIndexAppenderInTransaction(db, scope.sessionId);
          expectTrips(
            db,
            () => {
              empty.flushRows();
              empty.flush();
            },
            0,
          );
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
          expectTrips(db, () => append.flushRows(), 2);
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
          expectTrips(db, () => append.flushRows(), 0);
          expect(projection(db, scope.sessionId)).toEqual(rowsOnly);
          expectTrips(db, () => append.flush(), 1);
          expect(projection(db, scope.sessionId)).toEqual({
            ...rowsOnly,
            state: indexState(count, count, count - 1, `batch-${count - 1}`),
          });
        });
      }));

    it("retains branch and compaction rebuilds when a pending flush becomes dirty", () =>
      admit(() => {
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
          expect(projection(db, scope.sessionId).state).toEqual(
            indexState(2, 2, 2, "abandoned", 1),
          );
          expect(reconcileSessionTranscriptIndexInTransaction(db, scope.sessionId)).toBe(true);
          const current = projection(db, scope.sessionId);
          expect(current.active.map((row) => row.event_seq)).toEqual([1, 3, 4]);
          expect(current.state).toEqual(indexState(3, 2, 4, "compact"));
          expect(current.fts).toEqual([
            { message_id: "root", text: "Needle root", role: "user", timestamp: 1 },
            { message_id: "selected", text: "Needle selected", role: "assistant", timestamp: 3 },
          ]);
        });
      }));
  },
);
