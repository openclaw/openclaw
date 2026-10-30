import { describe, expect, it } from "vitest";
import { withCurrentProjectionSnapshot } from "../../config/sessions/session-accessor.sqlite-active-projection.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  findUnindexedActiveTranscriptEntry,
  iterateUnindexedActiveTranscriptNavigation,
} from "../../config/sessions/session-accessor.sqlite-history-navigation.js";
import type { CurrentTranscriptProjection } from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import { canRebasePreparedAssistantInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-parent.js";
import {
  advanceTranscriptMutationAtInTransaction,
  ensureTranscriptGenerationInTransaction,
  ensureTranscriptSessionRoot,
} from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { prepareIncrementalSuffixIdempotencyMutation } from "../../config/sessions/session-accessor.sqlite-transcript-suffix-idempotency.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../../config/sessions/session-transcript-index.js";
import { createTranscriptEventInserter } from "../../config/sessions/transcript-payload.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

type StoredEvent = {
  id: string;
  parentId: string | null;
  json: string;
  key?: string;
};

function message(id: string, parentId: string | null, fields: Record<string, unknown> = {}) {
  return {
    id,
    parentId,
    json: JSON.stringify({
      type: "message",
      id,
      parentId,
      message: { role: "assistant", ...fields },
    }),
  };
}

function transcriptFixture(name: string, events: readonly StoredEvent[], indexed = true) {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = {
    agentId: "main",
    sessionId: `transcript-portability-${name}`,
    sessionKey: `agent:main:transcript-portability-${name}`,
    storePath: database.path,
  };
  replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const write = <T>(run: () => T) => runSqliteImmediateTransactionSync(database.db, run);
  const rows = events.map((event, seq) => ({ seq, eventJson: event.json, createdAt: seq + 1 }));
  write(() => {
    ensureTranscriptSessionRoot(database, scope, 1);
    ensureTranscriptGenerationInTransaction(database, scope.sessionId);
    const insert = createTranscriptEventInserter(database.db, scope.sessionId);
    const insertIdentity = database.db.prepare(
      "INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at) VALUES (?, ?, ?, 'message', ?, ?, ?)",
    );
    for (const [seq, event] of events.entries()) {
      insert({ seq, eventJson: event.json, createdAt: seq + 1 });
      if (indexed) {
        insertIdentity.run(
          scope.sessionId,
          event.id,
          seq,
          event.parentId,
          event.key ?? null,
          seq + 1,
        );
      }
    }
    if (!indexed) {
      reconcileSessionTranscriptIndexInTransaction(database.db, scope.sessionId);
    }
  });
  return {
    database,
    scope,
    rows,
    write,
    project: <T>(read: (projection: CurrentTranscriptProjection) => T) =>
      write(() => withCurrentProjectionSnapshot(scope, read, { transaction: database })),
  };
}

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} transcript portability`,
    () => {
      useMixedAgentPair(engine, engine);

      it("rebases only transparent newer messages using first-member roles and exact booleans", () =>
        withEngineStoreAdmission(() => {
          const cases = [
            [
              "command",
              '"role":"user","excludeFromContext":true,"__openclaw":{"contextFreeCommand":true}',
              true,
            ],
            [
              "numeric-command",
              '"role":"user","excludeFromContext":1,"__openclaw":{"contextFreeCommand":true}',
              false,
            ],
            [
              "string-command",
              '"role":"user","excludeFromContext":true,"__openclaw":{"contextFreeCommand":"true"}',
              false,
            ],
            ["first-user", '"role":"user","role":"assistant"', false],
            ["first-assistant", '"role":"assistant","role":"user"', true],
            [
              "first-voice",
              '"role":"user","provenance":{"kind":"realtime_voice","kind":"other","sourceChannel":"talk"}',
              true,
            ],
            [
              "last-voice",
              '"role":"user","provenance":{"kind":"other","kind":"realtime_voice","sourceChannel":"talk"}',
              false,
            ],
            [
              "partial-voice",
              '"role":"user","provenance":{"kind":"realtime_voice","sourceChannel":"other"}',
              false,
            ],
          ] as const;
          for (const [name, fields, expected] of cases) {
            const fixture = transcriptFixture(name, [
              message("root", null),
              {
                id: "newer",
                parentId: "root",
                json: `{"type":"message","id":"newer","parentId":"root","message":{${fields}}}`,
              },
            ]);
            expect(
              fixture.write(() =>
                canRebasePreparedAssistantInTransaction(
                  fixture.database,
                  fixture.scope.sessionId,
                  "root",
                ),
              ),
              name,
            ).toBe(expected);
          }
        }));

      it("selects the newest retained idempotency owner while tolerating unrelated malformed JSON", () =>
        withEngineStoreAdmission(() => {
          const fixture = transcriptFixture("suffix", [
            message("root", null),
            { id: "malformed", parentId: "root", json: "{" },
            message("earlier", "malformed", { idempotencyKey: "retry" }),
            message("latest", "earlier", { idempotencyKey: "\t\u00a0retry\ufeff\n" }),
            {
              id: "last-member-only",
              parentId: "latest",
              json: '{"type":"message","id":"last-member-only","parentId":"latest","message":{"role":"assistant","idempotencyKey":"other","idempotencyKey":"retry"}}',
            },
            {
              ...message("removed", "last-member-only", { idempotencyKey: "retry" }),
              key: "retry",
            },
          ]);
          const before = fixture.database.db
            .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
            .all(fixture.scope.sessionId);
          expect(
            fixture.write(() =>
              prepareIncrementalSuffixIdempotencyMutation({
                database: fixture.database,
                resolved: fixture.scope,
                expectedRows: fixture.rows.slice(5),
                next: [],
                startSeq: 5,
              }),
            ),
          ).toEqual({
            suffixIdentityKeys: [["removed", "retry"]],
            replacementByIdempotencyKey: [["retry", "latest"]],
          });
          expect(
            fixture.database.db
              .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
              .all(fixture.scope.sessionId),
          ).toEqual(before);
        }));

      it("finds unindexed last-member IDs and retains deep and malformed navigation behavior", () =>
        withEngineStoreAdmission(() => {
          const fixture = transcriptFixture(
            "navigation",
            [
              message("root", null),
              {
                id: "last",
                parentId: "root",
                json: '{"type":"message","id":"first","id":"\\tlast\\n","parentId":"root","message":{"role":"assistant"}}',
              },
              message("last-suffix", "last"),
              {
                id: "deep",
                parentId: "last-suffix",
                json: `{"type":"message","id":"deep","parentId":"last-suffix","message":{"role":"assistant"},"details":${"[".repeat(1001)}0${"]".repeat(1001)}}`,
              },
            ],
            false,
          );
          const find = (id: string) =>
            fixture.project((projection) => findUnindexedActiveTranscriptEntry(projection, id));
          expect(find("last")).toMatchObject({ event_seq: 1, event: { id: "\tlast\n" } });
          expect(find("first")).toBeUndefined();
          expect(find("suffix")).toBeUndefined();
          expect(find("deep")).toMatchObject({ event_seq: 3, event: { id: "deep" } });
          for (const requested of [
            ["root", "last"],
            ["last", ...Array.from({ length: 32 }, (_, index) => `missing-${index}`)],
          ]) {
            const ids = fixture.project((projection) =>
              Array.from(
                iterateUnindexedActiveTranscriptNavigation(projection, { eventIds: requested }),
              )
                .map((row) => row.event.id)
                .filter((id): id is string => typeof id === "string")
                .map((id) => id.trim())
                .filter((id) => requested.includes(id)),
            );
            expect(ids).toContain("last");
          }
          fixture.write(() => {
            fixture.database.db
              .prepare(
                "UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 3",
              )
              .run(fixture.scope.sessionId);
          });
          expect(() => find("missing")).toThrow();
          fixture.write(() => {
            fixture.database.db
              .prepare(
                "INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at) VALUES (?, 'deep', 3, 'message', 'last-suffix', NULL, 4)",
              )
              .run(fixture.scope.sessionId);
          });
          expect(find("missing")).toBeUndefined();
        }));

      it("advances mutation time beyond both prior mutation and observation with nullable fields", () =>
        withEngineStoreAdmission(() => {
          const fixture = transcriptFixture("mutation", [message("root", null)]);
          fixture.write(() => {
            fixture.database.db
              .prepare(
                "UPDATE session_windows SET transcript_updated_at = 100, transcript_observed_at = 200 WHERE session_id = ?",
              )
              .run(fixture.scope.sessionId);
            advanceTranscriptMutationAtInTransaction(
              fixture.database,
              fixture.scope.sessionId,
              50,
              {
                strictly: true,
                steps: 3,
              },
            );
          });
          const read = () =>
            fixture.database.db
              .prepare("SELECT transcript_updated_at FROM session_windows WHERE session_id = ?")
              .get(fixture.scope.sessionId);
          expect(read()).toEqual({ transcript_updated_at: 203 });
          fixture.write(() => {
            fixture.database.db
              .prepare(
                "UPDATE session_windows SET transcript_updated_at = NULL, transcript_observed_at = NULL WHERE session_id = ?",
              )
              .run(fixture.scope.sessionId);
            advanceTranscriptMutationAtInTransaction(fixture.database, fixture.scope.sessionId, 0, {
              strictly: true,
            });
          });
          expect(read()).toEqual({ transcript_updated_at: 0 });
        }));
    },
  );
}
