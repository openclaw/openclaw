import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readTranscriptStorageRows } from "../../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptMessageInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
} from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { createTranscriptEventInserter } from "../../config/sessions/transcript-payload.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function message(id: string, parentId: string | null, key: string, timestamp: number) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "assistant", content: `Answer ${id}`, timestamp, idempotencyKey: key },
  };
}

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s transcript identity insertion",
  (engine) => {
    useMixedAgentPair(engine, engine);

    function fixture(name: string) {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        path: database.path,
        sessionKey: `agent:main:identity-${name}`,
        sessionId: `identity-${name}`,
      };
      replaceSessionEntrySync(
        { ...scope, storePath: database.path },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );
      const write = <T>(run: () => T) => runSqliteImmediateTransactionSync(database.db, run);
      const header = {
        type: "session",
        version: 3,
        id: scope.sessionId,
        timestamp: new Date(0).toISOString(),
      };
      write(() =>
        appendTranscriptEventsInTransaction(database, scope, [header], {
          scheduleProjectionReconcile: false,
        }),
      );
      const append = (
        event: Parameters<typeof appendTranscriptEventInTransaction>[2],
        options: Parameters<typeof appendTranscriptEventInTransaction>[3] = {},
      ) =>
        appendTranscriptEventInTransaction(database, scope, event, {
          scheduleProjectionReconcile: false,
          ...options,
        });
      const identities = () =>
        database.db
          .prepare(
            "SELECT event_id, seq, event_type, parent_id, message_idempotency_key, created_at FROM transcript_event_identities WHERE session_id = ? ORDER BY seq",
          )
          .all(scope.sessionId);
      const state = () => ({
        events: readTranscriptStorageRows(database, scope.sessionId),
        identities: identities(),
      });
      const expectedIdentities = (
        events: readonly (typeof header | ReturnType<typeof message>)[],
        keyOverrides: Record<string, string | null> = {},
      ) =>
        events.map((event, seq) => ({
          event_id: event.id,
          seq,
          event_type: event.type,
          parent_id: "parentId" in event ? event.parentId : null,
          message_idempotency_key:
            event.id in keyOverrides
              ? keyOverrides[event.id]
              : "message" in event
                ? event.message.idempotencyKey
                : null,
          created_at: Date.parse(event.timestamp),
        }));
      const expectState = (events: readonly (typeof header | ReturnType<typeof message>)[]) => {
        expect(state()).toEqual({
          events: events.map((event, seq) => ({
            seq,
            eventJson: JSON.stringify(event),
            createdAt: Date.parse(event.timestamp),
          })),
          identities: expectedIdentities(events),
        });
      };
      return {
        database,
        scope,
        header,
        append,
        write,
        state,
        identities,
        expectState,
        expectedIdentities,
      };
    }

    it("rejects scalar event and key duplicates without changing accepted bytes or consuming a sequence", () =>
      withEngineStoreAdmission(() => {
        const f = fixture("duplicates");
        const first = message("first", null, "first-key", 10);
        expect(f.write(() => f.append(first))).toBe(JSON.stringify(first));
        const before = f.state();
        expect(
          f.write(() =>
            f.append({
              ...first,
              timestamp: new Date(20).toISOString(),
              message: { ...first.message, content: "Rejected replacement" },
            }),
          ),
        ).toBe(false);
        expect(f.state()).toEqual(before);
        expect(
          f.write(() =>
            f.append(message("duplicate-key", "first", "first-key", 30), {
              idempotencyKeyMode: "dedupe",
            }),
          ),
        ).toBe(false);
        expect(f.state()).toEqual(before);
        const next = message("next", "first", "next-key", 40);
        expect(f.write(() => f.append(next))).toBe(JSON.stringify(next));
        f.expectState([f.header, first, next]);
      }));

    it("scan-assistant appends and replays an answer without stealing a colliding user's key", () =>
      withEngineStoreAdmission(() => {
        const f = fixture("scan-assistant");
        const user = {
          ...message("input", null, "shared-key", 10),
          message: {
            role: "user",
            content: "Question",
            timestamp: 10,
            idempotencyKey: "shared-key",
          },
        };
        f.write(() => f.append(user));
        const answer = {
          role: "assistant",
          content: "Answer",
          timestamp: 20,
          idempotencyKey: "shared-key",
        };
        const appendAnswer = (eventId: string) =>
          f.write(() =>
            appendTranscriptMessageInTransaction(
              f.database,
              f.scope,
              {
                eventId,
                parentId: "input",
                message: answer,
                now: 20,
                idempotencyLookup: "scan-assistant",
              },
              undefined,
              { scheduleProjectionReconcile: false },
            ),
          );
        expect(appendAnswer("answer")?.result).toMatchObject({
          appended: true,
          messageId: "answer",
          message: answer,
        });
        const beforeRetry = f.state();
        expect(appendAnswer("ignored-retry")?.result).toMatchObject({
          appended: false,
          messageId: "answer",
          message: answer,
        });
        expect(f.state()).toEqual(beforeRetry);
        const events = [
          f.header,
          user,
          { ...message("answer", "input", "shared-key", 20), message: answer },
        ];
        expect(f.state().events.map((row) => JSON.parse(row.eventJson))).toEqual(events);
        expect(f.identities()).toEqual(f.expectedIdentities(events, { answer: null }));
      }));

    it("relocates a caller-checked key only with its accepted event and rolls both back together", () =>
      withEngineStoreAdmission(() => {
        const f = fixture("relocation");
        const original = message("original", null, "relocated-key", 10);
        f.write(() => f.append(original));
        const before = f.state();
        const appendMoved = () =>
          appendTranscriptMessageInTransaction(
            f.database,
            f.scope,
            {
              eventId: "moved",
              parentId: "original",
              message: original.message,
              now: 20,
              idempotencyLookup: "caller-checked",
            },
            undefined,
            { scheduleProjectionReconcile: false },
          );
        expect(() =>
          f.write(() => {
            expect(appendMoved()?.result).toMatchObject({ appended: true, messageId: "moved" });
            expect(f.identities().filter((row) => row.message_idempotency_key !== null)).toEqual([
              {
                event_id: "moved",
                seq: 2,
                event_type: "message",
                parent_id: "original",
                message_idempotency_key: "relocated-key",
                created_at: 20,
              },
            ]);
            throw new Error("rollback relocated identity");
          }),
        ).toThrow("rollback relocated identity");
        expect(f.state()).toEqual(before);
        expect(f.write(appendMoved)?.result).toMatchObject({
          appended: true,
          messageId: "moved",
          message: original.message,
        });
        const events = [
          f.header,
          original,
          { ...message("moved", "original", "relocated-key", 20), message: original.message },
        ];
        expect(f.state().events.map((row) => JSON.parse(row.eventJson))).toEqual(events);
        expect(f.identities()).toEqual(f.expectedIdentities(events, { original: null }));
      }));

    it("commits a duplicate relocation rejection without clearing the other key owner", () =>
      withEngineStoreAdmission(() => {
        const f = fixture("rejected-relocation");
        const first = message("first", null, "first-key", 10);
        const owner = message("owner", "first", "owned-key", 20);
        f.write(() => {
          f.append(first);
          f.append(owner);
        });
        const before = f.state();
        expect(
          f.write(() =>
            f.append(message("first", "owner", "owned-key", 30), {
              idempotencyKeyMode: "relocate-owner",
            }),
          ),
        ).toBe(false);
        expect(f.state()).toEqual(before);
        f.expectState([f.header, first, owner]);
      }));

    if (engine === "postgres") {
      it("keeps event acceptance independent of ignored identity conflicts and rejects conflicting keys", () =>
        withEngineStoreAdmission(() => {
          const f = fixture("identity-conflicts");
          const insert = createTranscriptEventInserter(
            f.database.db,
            f.scope.sessionId,
          ).withIdentity;
          assert(insert);
          const event = message("accepted", null, "accepted-key", 10);
          const identity = {
            eventId: event.id,
            eventType: "message",
            parentId: null,
            messageIdempotencyKey: "accepted-key",
          };
          const row = {
            seq: 1,
            eventJson: JSON.stringify(event),
            createdAt: 10,
            eventId: event.id,
          };
          expect(f.write(() => insert(row, identity))).toBe(true);
          const accepted = f.state();
          expect(f.write(() => insert({ ...row, seq: 2, createdAt: 20 }, identity))).toBe(false);
          expect(f.state()).toEqual(accepted);

          // Complete actors omit the event guard; a skipped identity must not reject their event.
          expect(
            f.write(() => insert({ ...row, seq: 2, createdAt: 20, eventId: undefined }, identity)),
          ).toBe(true);
          const duplicate = f.state();
          expect(duplicate.events).toEqual([
            ...accepted.events,
            { seq: 2, eventJson: row.eventJson, createdAt: 20 },
          ]);
          expect(duplicate.identities).toEqual(accepted.identities);
          expect(accepted.identities.at(-1)).toEqual({
            event_id: event.id,
            seq: 1,
            event_type: "message",
            parent_id: null,
            message_idempotency_key: "accepted-key",
            created_at: 10,
          });

          const conflict = message("conflicting-key", "accepted", "accepted-key", 30);
          expect(() =>
            f.write(() =>
              insert(
                {
                  seq: 3,
                  eventJson: JSON.stringify(conflict),
                  createdAt: 30,
                  eventId: conflict.id,
                },
                { ...identity, eventId: conflict.id, parentId: "accepted" },
              ),
            ),
          ).toThrow(/unique constraint/iu);
          expect(f.state()).toEqual(duplicate);
        }));
    }
  },
);
