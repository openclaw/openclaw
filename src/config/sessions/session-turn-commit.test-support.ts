import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { expect, it, vi } from "vitest";
import type { DatabaseEngineId } from "../../infra/database-engine/types.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionTranscriptTurnMessageAppend } from "./session-accessor.types.js";
import { readStagedSessionTranscriptAuthority } from "./session-transcript-authority.js";
import type { SessionTranscriptAuthority } from "./session-transcript-authority.types.js";
import { createSessionTranscriptTurnKernel } from "./session-turn.kernel.js";

type TurnTestHarness = {
  engine: DatabaseEngineId;
  storePath: () => string;
  run: <T>(operation: () => T) => T;
};

export function runSessionTurnCountTests(harness: TurnTestHarness) {
  it.each([
    [1, false],
    [2, false],
    [4, false],
    [513, false],
    [2, true],
  ] as const)(
    "batches %i messages (caller IDs: %s) while preserving strict window advances",
    (count, callerIds) =>
      harness.run(() => {
        const sessionId = randomUUID();
        const sessionKey = `agent:main:${sessionId}`;
        const scope = { agentId: "main", sessionId, sessionKey, storePath: harness.storePath() };
        replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const resolved = resolveSqliteTranscriptScope(scope);
        const databaseOptions = toDatabaseOptions(resolved);
        const database = openOpenClawAgentDatabase(databaseOptions);
        const select = (columns: string) =>
          database.db
            .prepare(`SELECT ${columns} FROM session_windows WHERE session_id = ?`)
            .get(scope.sessionId);
        const fresh = Array.from({ length: count }, (_, index) => ({
          eventId: `fresh-${index}`,
          parentId: index ? `fresh-${index - 1}` : "seed",
          message: { role: index % 2 ? "assistant" : "user", content: `Message ${index}` },
        }));
        const kernel = createSessionTranscriptTurnKernel(resolved, {
          expectedSessionId: scope.sessionId,
          sessionFile: scope.sessionKey,
          keyFormat: "agent-qualified",
          messages: [],
        });
        let authority: SessionTranscriptAuthority | undefined;
        const commit = (messages: SessionTranscriptTurnMessageAppend[]) =>
          runOpenClawAgentWriteTransaction((db) => {
            const result = kernel.commit(db, messages).result;
            const fact = readStagedSessionTranscriptAuthority(db)?.[0]?.facts.get(scope.sessionKey);
            authority = fact?.kind === "postimage" ? fact.value : undefined;
            return result;
          }, databaseOptions);
        commit([{ eventId: "seed", message: { role: "assistant", content: "Existing history" } }]);
        runOpenClawAgentWriteTransaction(
          () =>
            database.db
              .prepare(
                "UPDATE session_windows SET transcript_updated_at = ?, transcript_observed_at = ? WHERE session_id = ?",
              )
              .run(10000, 20000, scope.sessionId),
          databaseOptions,
        );
        vi.spyOn(Date, "now").mockReturnValue(5000);
        const measured = { statements: 0, trips: 0 };
        const events = channel("openclaw.database.statement");
        const observe = (value: unknown) => {
          const event = value as { engine: string; sql?: string; outcome: string };
          if (event.engine === harness.engine && event.outcome === "ok") {
            measured.trips += 1;
            measured.statements += event.sql?.split(";").filter((part) => part.trim()).length ?? 0;
          }
        };
        events.subscribe(observe);
        let result;
        try {
          result = commit(
            fresh.map(({ eventId, message }) => ({ ...(callerIds ? { eventId } : {}), message })),
          );
        } finally {
          events.unsubscribe(observe);
        }
        const ids = result.appendedMessages.map((message) => message.messageId);
        expect(result.appendedMessages).toMatchObject(
          fresh.map((_, index) => ({
            messageId: callerIds ? fresh[index]!.eventId : expect.any(String),
            appended: true,
            effectiveParentId: ids[index - 1] ?? "seed",
            anchor: { rawSeq: index + 2, activeMessagePosition: index + 1 },
          })),
        );
        expect(select("transcript_updated_at, transcript_observed_at")).toEqual({
          transcript_updated_at: 20000 + count,
          transcript_observed_at: 20000,
        });
        const window = select("row_transcript_json") as { row_transcript_json: string };
        const lastAssistant = { text: `Message ${count - (count % 2 ? 2 : 1)}`, timestamp: 5000 };
        expect(JSON.parse(window.row_transcript_json).lastAssistantMessage).toEqual(
          count % 2 ? "unchanged" : lastAssistant,
        );
        expect(authority?.lastAssistantMessage).toEqual(count === 1 ? "unchanged" : lastAssistant);
        expect(
          database.db
            .prepare(
              "SELECT event_id, parent_id FROM transcript_event_identities WHERE session_id = ? AND event_type = 'message' ORDER BY seq",
            )
            .all(scope.sessionId),
        ).toEqual([
          { event_id: "seed", parent_id: null },
          ...ids.map((eventId, index) => ({
            event_id: eventId,
            parent_id: ids[index - 1] ?? "seed",
          })),
        ]);
        // Includes the transaction envelope and every adapter trip.
        const sqliteBudget = count === 1 ? 13 : count === 513 ? 16 : callerIds ? 12 : 11;
        const postgresBudget = count === 1 ? 12 : count === 513 ? 9 : callerIds ? 8 : 7;
        expect(measured).toEqual(
          harness.engine === "sqlite"
            ? { statements: sqliteBudget, trips: sqliteBudget }
            : { statements: postgresBudget, trips: postgresBudget - 1 },
        );
      }),
  );
}

function normalize(value: unknown, sessionId: string): unknown {
  if (value === sessionId || value === `agent:main:${sessionId}`) {
    return "session";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry, sessionId));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "generation" && typeof entry === "string"
          ? "generation"
          : key === "storePath"
            ? "store"
            : key === "sessionId" || key === "sessionKey" || key === "sessionFile"
              ? "session"
              : normalize(entry, sessionId),
      ]),
    );
  }
  return value;
}

export function runSessionTurnPostimageTests(harness: TurnTestHarness) {
  it.each([
    "clean",
    "header",
    "missing",
    "dirty",
    "stale",
    "unclassified",
    "generation",
    "nonmessage",
    "keyed",
    "replay",
  ] as const)("keeps %s turn postimages equivalent to the ordered callback path", (scenario) =>
    harness.run(() => {
      vi.spyOn(Date, "now").mockReturnValue(5000);
      const run = (ordered: boolean) => {
        const sessionId = randomUUID();
        const scope = {
          agentId: "main",
          sessionId,
          sessionKey: `agent:main:${sessionId}`,
          storePath: harness.storePath(),
        };
        replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        if (scenario !== "header") {
          replaceTranscriptEventsSync(scope, [
            { type: "session", version: 3, id: sessionId },
            {
              type: "message",
              id: "seed",
              parentId: null,
              message: { role: "user", content: "Seed" },
            },
            ...(scenario === "nonmessage"
              ? [{ type: "custom", id: "note", parentId: "seed", data: "note" }]
              : []),
          ]);
        }
        const resolved = resolveSqliteTranscriptScope(scope);
        const options = toDatabaseOptions(resolved);
        const database = openOpenClawAgentDatabase(options);
        runOpenClawAgentWriteTransaction(() => {
          if (scenario === "missing") {
            database.db
              .prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?")
              .run(sessionId);
          }
          if (scenario === "dirty") {
            database.db
              .prepare(
                "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
              )
              .run(sessionId);
          }
          if (scenario === "stale") {
            database.db
              .prepare(
                "UPDATE session_transcript_index_state SET indexed_seq = 0 WHERE session_id = ?",
              )
              .run(sessionId);
          }
          if (scenario === "generation") {
            database.db
              .prepare("DELETE FROM transcript_rewrite_watermarks WHERE session_id = ?")
              .run(sessionId);
          }
          if (scenario === "unclassified") {
            database.db
              .prepare(
                "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
              )
              .run(sessionId);
          }
          database.db
            .prepare(
              "UPDATE session_windows SET transcript_updated_at = 10000, transcript_observed_at = 20000 WHERE session_id = ?",
            )
            .run(sessionId);
        }, options);
        const kernel = createSessionTranscriptTurnKernel(resolved, {
          expectedSessionId: sessionId,
          sessionFile: scope.sessionKey,
          keyFormat: "agent-qualified",
          messages: [],
        });
        const messages: SessionTranscriptTurnMessageAppend[] = [
          {
            eventId: "question",
            message: {
              role: "user",
              content: "Question",
              ...(scenario === "keyed" ? { idempotencyKey: "question-key" } : {}),
            },
          },
          { eventId: "answer", message: { role: "assistant", content: "Answer" } },
        ];
        if (ordered) {
          for (const message of messages) {
            message.beforeFreshMessageCommit = () => {};
          }
        }
        const commit = () =>
          runOpenClawAgentWriteTransaction(
            (db) => kernel.commit(db, messages, { scheduleProjectionReconcile: false }).result,
            options,
          );
        const result = commit();
        const replay = scenario === "replay" ? commit() : undefined;
        expect(
          result.appendedMessages.map(({ messageId, appended, message }) => ({
            messageId,
            appended,
            message,
          })),
        ).toEqual([
          { messageId: "question", appended: true, message: messages[0]!.message },
          { messageId: "answer", appended: true, message: messages[1]!.message },
        ]);
        if (replay) {
          expect(replay.appendedMessages.map((message) => message.appended)).toEqual([
            false,
            false,
          ]);
        }
        const rows = (table: string, columns: string, order: string) =>
          database.db
            .prepare(`SELECT ${columns} FROM ${table} WHERE session_id = ? ORDER BY ${order}`)
            .all(sessionId);
        const rawSeq = scenario === "header" ? 2 : scenario === "nonmessage" ? 4 : 3;
        const updatedAt = scenario === "header" ? 20003 : 20002;
        expect(
          rows("session_windows", "transcript_updated_at, transcript_observed_at", "session_id"),
        ).toEqual([{ transcript_updated_at: updatedAt, transcript_observed_at: 20000 }]);
        expect(result.appendedMessages.map((message) => message.effectiveParentId)).toEqual([
          scenario === "header" ? null : scenario === "nonmessage" ? "note" : "seed",
          "question",
        ]);
        if (["missing", "dirty", "stale", "unclassified"].includes(scenario)) {
          expect(result.appendedMessages.map((message) => message.anchor)).toEqual([
            undefined,
            undefined,
          ]);
        } else {
          const generation = rows("transcript_rewrite_watermarks", "generation", "session_id")[0]
            ?.generation;
          expect(generation).toEqual(expect.any(String));
          expect(result.appendedMessages.map((message) => message.anchor)).toMatchObject([
            {
              entryId: "question",
              generation,
              rawSeq: rawSeq - 1,
              activeMessagePosition: scenario === "header" ? 0 : 1,
            },
            {
              entryId: "answer",
              generation,
              rawSeq,
              activeMessagePosition: scenario === "header" ? 1 : 2,
            },
          ]);
        }
        return normalize(
          {
            result,
            replay,
            identities: rows(
              "transcript_event_identities",
              "seq, event_id, event_type, parent_id, message_idempotency_key",
              "seq",
            ),
            active: rows(
              "session_transcript_active_events",
              "active_position, event_seq, message_position, context_eligible",
              "active_position",
            ),
            index: rows(
              "session_transcript_index_state",
              "active_event_count, active_message_count, indexed_seq, leaf_event_id, needs_rebuild",
              "session_id",
            ),
            window: rows(
              "session_windows",
              "updated_at, transcript_updated_at, transcript_observed_at, row_transcript_json, row_transcript_updated_at",
              "session_id",
            ),
          },
          sessionId,
        );
      };
      expect(run(false)).toEqual(run(true));
    }),
  );
}
