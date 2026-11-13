import type { SQLInputValue } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { withCurrentProjectionSnapshot } from "../../config/sessions/session-accessor.sqlite-active-projection.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionTranscriptRunInputVisibilityFromProjection } from "../../config/sessions/session-accessor.sqlite-history-input-visibility.js";
import {
  findUnindexedActiveTranscriptEntry,
  iterateUnindexedActiveTranscriptNavigation,
} from "../../config/sessions/session-accessor.sqlite-history-navigation.js";
import {
  readSessionTranscriptModelContext,
  readSessionTranscriptContextMessages,
  readSessionTranscriptContextSeed,
  validateSessionTranscriptContextVersion,
} from "../../config/sessions/session-accessor.sqlite-model-context.js";
import type { CurrentTranscriptProjection } from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import { resolveSqliteTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-read-scope.js";
import { loadTranscriptSuffixEventsBoundedSync } from "../../config/sessions/session-accessor.sqlite-suffix-read.js";
import { readTranscriptMirrorFacts } from "../../config/sessions/session-accessor.sqlite-transcript-mirror.js";
import { canRebasePreparedAssistantInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-parent.js";
import {
  advanceTranscriptMutationAtInTransaction,
  ensureTranscriptGenerationInTransaction,
  ensureTranscriptSessionRoot,
} from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import { prepareIncrementalSuffixIdempotencyMutation } from "../../config/sessions/session-accessor.sqlite-transcript-suffix-idempotency.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../../config/sessions/session-transcript-index.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { createTranscriptEventInserter } from "../../config/sessions/transcript-payload.js";
import { appendSessionTranscriptMessageByIdentity } from "../../plugin-sdk/session-transcript-runtime.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
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

      it.runIf(engine === "postgres")(
        "hydrates covered active facts without executing payload subplans",
        () =>
          withEngineStoreAdmission(() => {
            const fixture = transcriptFixture(
              "active-facts",
              [
                message("root", null, { role: "user", content: "Earlier question" }),
                message("pending", "root", {
                  provider: "openclaw",
                  model: "automation-result",
                  content: [{ type: "text", text: "Required background result" }],
                  excludeFromContext: true,
                  openclawModelPlacement: "pending",
                }),
                message("tail", "pending", { role: "user", content: "Latest question" }),
              ],
              false,
            );
            const db = fixture.database.db;
            if (!isPostgresSqlConnection(db)) {
              throw new Error("Expected PostgreSQL connection");
            }
            const observed: Array<{ sql: string; parameters: readonly SQLInputValue[] }> = [];
            const query = db.query.bind(db);
            const observer = vi
              .spyOn(db, "query")
              .mockImplementation((statementSql, parameters = []) => {
                if (statementSql.includes("session_transcript_active_event_facts")) {
                  observed.push({ sql: statementSql, parameters });
                }
                return query(statementSql, parameters);
              });
            const read = () =>
              readSessionTranscriptBoundedActiveContextCore(fixture.scope, {
                transaction: fixture.database,
                maxEvents: 1,
                maxBytes: 100_000,
              });
            try {
              fixture.write(() => {
                const covered = read();
                expect(covered.events).toEqual([
                  expect.objectContaining({ id: "pending" }),
                  expect.objectContaining({ id: "tail" }),
                ]);
                const queries = observed.splice(0);
                expect(queries).toHaveLength(2);
                for (const statement of queries) {
                  const plan = query(
                    `EXPLAIN (ANALYZE, BUFFERS) ${statement.sql}`,
                    statement.parameters,
                  ).rows.map((row) => String(row["QUERY PLAN"]));
                  const payloadPlans = plan.filter((line) =>
                    / on transcript_events event(?:_\d+)? /u.test(line),
                  );
                  expect(payloadPlans.length).toBeGreaterThan(0);
                  expect(payloadPlans.every((line) => line.includes("never executed"))).toBe(true);
                }
                db.exec("SAVEPOINT active_facts_control");
                try {
                  db.prepare(
                    "DELETE FROM session_transcript_active_event_facts WHERE session_id = ? AND seq = 1",
                  ).run(fixture.scope.sessionId);
                  expect(read()).toEqual(covered);
                  db.prepare(
                    "DELETE FROM session_transcript_active_event_facts WHERE session_id = ?",
                  ).run(fixture.scope.sessionId);
                  expect(read()).toEqual(covered);
                } finally {
                  db.exec("ROLLBACK TO active_facts_control; RELEASE active_facts_control");
                }
              });
            } finally {
              observer.mockRestore();
            }
          }),
      );

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

      it.each([
        [
          "key",
          '"message":{"role":"user","content":"request","idempotencyKey":"wrong","idempotencyKey":"seed:user","timestamp":1}',
        ],
        [
          "role",
          '"message":{"role":"assistant","role":"user","content":"request","idempotencyKey":"seed:user","timestamp":1}',
        ],
        [
          "message",
          '"message":{"role":"assistant"},"message":{"role":"user","content":"request","idempotencyKey":"seed:user","timestamp":1}',
        ],
      ])(
        "seeds duplicate %s scalars using the full reader's last-member semantics",
        (name, fields) =>
          withEngineStoreAdmission(() => {
            const fixture = transcriptFixture(
              `seed-duplicates-${name}`,
              [
                {
                  id: "summary",
                  parentId: null,
                  json: '{"type":"branch_summary","id":"summary","parentId":null,"fromId":"earlier","timestamp":"2026-11-09T00:00:00.000Z","summary":"older","summary":""}',
                },
                {
                  id: "admitted",
                  parentId: "summary",
                  json: `{"type":"message","id":"admitted","parentId":"summary",${fields}}`,
                },
              ],
              false,
            );
            const full = readSessionTranscriptContextMessages(fixture.scope, (messages) => [
              ...messages,
            ]);
            const seed = readSessionTranscriptContextSeed(fixture.scope, {
              maxBytes: 100_000,
              tokenBudget: 25_000,
              admittedKey: "seed:user",
              beforeAdmittedUser: true,
            });
            expect(seed.messages).toEqual([]);
            expect(seed.seed?.admittedUser).toEqual(full[0]);
            expect(seed.seed?.admittedUser).toMatchObject({ idempotencyKey: "seed:user" });
          }),
      );

      it("seeds branch summaries and admitted input with escapes JSONB rejects", () =>
        withEngineStoreAdmission(() => {
          const fixture = transcriptFixture(
            "seed-exceptional",
            [
              {
                id: "summary",
                parentId: null,
                json: JSON.stringify({
                  type: "branch_summary",
                  id: "summary",
                  parentId: null,
                  fromId: "earlier",
                  timestamp: "2026-11-09T00:00:00.000Z",
                  summary: "retained summary \ud800",
                }),
              },
              {
                id: "admitted",
                parentId: "summary",
                json: JSON.stringify({
                  type: "message",
                  id: "admitted",
                  parentId: "summary",
                  message: {
                    role: "user",
                    content: "admitted request \udc00",
                    idempotencyKey: "seed:user",
                    timestamp: 1,
                  },
                }),
              },
            ],
            false,
          );
          const seed = readSessionTranscriptContextSeed(fixture.scope, {
            maxBytes: 100_000,
            tokenBudget: 25_000,
            admittedKey: "seed:user",
            beforeAdmittedUser: true,
          });
          expect(seed.messages).toMatchObject([
            { role: "branchSummary", summary: "retained summary \ud800" },
          ]);
          expect(seed.seed?.admittedUser).toMatchObject({
            role: "user",
            content: "admitted request \udc00",
            idempotencyKey: "seed:user",
          });
          expect(seed.seed?.retainedInputTokens).toBeGreaterThan(0);
        }));

      it("reads, validates and indexes escapes JSONB rejects without rewriting rows", async () => {
        const scope = withEngineStoreAdmission(() => ({
          agentId: "main",
          sessionId: "transcript-portability-escapes",
          sessionKey: "agent:main:transcript-portability-escapes",
          storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
        }));
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
        const runId = "run-escapes";
        const key = `${runId}:user`;
        const text = (value: string) => [{ type: "text", text: value }];
        const call = { type: "toolCall", id: "call", name: "read", arguments: { path: "\ud83d" } };
        const entries = [
          { role: "user", content: "low \udc00 \u0000 needle", idempotencyKey: key, timestamp: 1 },
          { role: "assistant", content: [call], stopReason: "toolUse", __openclaw: { runId } },
          { role: "toolResult", toolCallId: "call", toolName: "read", content: text("\ud800") },
          { role: "assistant", content: text("aside \ud83d"), excludeFromContext: true },
        ];
        const append = (index: number) =>
          appendSessionTranscriptMessageByIdentity({
            ...scope,
            eventId: `escape-${index}`,
            message:
              index === 2
                ? { ...entries[2], details: { x: "\ud800" }, isError: false }
                : entries[index],
          });
        const stored = () =>
          withEngineStoreAdmission(() =>
            openOpenClawAgentDatabase({ agentId: "main" })
              .db.prepare(
                "SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
              )
              .all(scope.sessionId),
          );
        const read = (limits?: { maxBytes: number; maxEvents: number }) =>
          withEngineStoreAdmission(() =>
            readSessionTranscriptModelContext(scope, undefined, limits),
          ).events.flatMap((event) => (isRecord(event) && event.message ? [event.message] : []));
        for (const index of [0, 1, 2]) {
          await append(index);
        }
        const before = stored();
        const { version } = withEngineStoreAdmission(() =>
          readSessionTranscriptModelContext(scope),
        );
        expect(read()).toMatchObject(entries.slice(0, 3));
        // The second bounded read reuses cached navigation pages and must keep private details out.
        for (const _ of [1, 2]) {
          const bounded = read({ maxBytes: 100_000, maxEvents: 2 });
          expect(bounded).toMatchObject(entries.slice(1, 3));
          expect(bounded[1]).not.toHaveProperty("details");
        }
        const manager = await SessionManager.openModelContextAsync(scope);
        expect(manager.buildSessionContext().messages).toMatchObject(entries.slice(0, 3));
        const seed = withEngineStoreAdmission(() =>
          readSessionTranscriptContextSeed(scope, {
            maxBytes: 100_000,
            tokenBudget: 25_000,
            admittedKey: key,
            beforeAdmittedUser: true,
          }),
        );
        expect(seed.messages).toEqual([]);
        expect(seed.seed?.admittedUser).toMatchObject(entries[0]!);
        expect(seed.seed?.retainedInputTokens).toBeGreaterThan(0);
        await append(3);
        withEngineStoreAdmission(() => {
          // Growth after the read takes detached validation through its prefix scan.
          validateSessionTranscriptContextVersion(scope, version);
          readSessionTranscriptBoundedActiveContextCore(scope, { maxEvents: 9, maxBytes: 99_999 });
          const suffix = { maxBytes: 99_999, maxEvents: 9, retainedCustomDataIds: ["absent"] };
          expect(loadTranscriptSuffixEventsBoundedSync(scope, 0, suffix)).toHaveLength(5);
          const resolved = {
            ...resolveSqliteTranscriptReadScope(scope),
            sessionKey: scope.sessionKey,
          };
          const mirror = { idempotencyKeys: [key], sourceRunId: runId };
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          expect(readTranscriptMirrorFacts(database, resolved, mirror).sourceEvents).toHaveLength(
            1,
          );
          const visibility = {
            idempotencyKey: key,
            runId,
            messageSeq: 2,
            isHiddenInput: () => true,
          };
          const hidden = withCurrentProjectionSnapshot(scope, (projection) =>
            readSessionTranscriptRunInputVisibilityFromProjection(projection, visibility),
          );
          expect(hidden).toMatchObject({ hidden: true });
        });
        // Search text replaces NUL; nearby words still find the stored message.
        const query = { agentId: "main", query: "needle", sessionKeys: [scope.sessionKey] };
        expect((await searchSessionTranscripts(query)).hits).toHaveLength(1);
        expect(stored().slice(0, before.length)).toEqual(before);
      });

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
