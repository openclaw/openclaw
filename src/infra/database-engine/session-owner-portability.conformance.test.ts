import { describe, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "../../config/sessions/session-accessor.sqlite-owner.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { readSessionWorktreeOwnerFactsInDatabase } from "../../config/sessions/session-accessor.sqlite-worktree-owner.js";
import {
  createTranscriptPayloadUpdater,
  prepareTranscriptPayload,
} from "../../config/sessions/transcript-payload.js";
import { scanJsonObjectFields } from "../../state/json-predicate-fields.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { jsonObjectFieldsForScan, jsonScannedValue } from "./json-values.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} session owner portability`,
    () => {
      useMixedAgentPair(engine, engine);

      it("assigns an owner and preserves it when a stale session identity is refused", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const scope = {
            agentId: "main",
            storePath: database.path,
            sessionKey: "agent:main:portable-owner",
          };
          replaceSessionEntrySync(scope, {
            sessionId: "portable-owner",
            updatedAt: 100,
            lifecycleRevision: "owner-revision",
          });
          const assignment = {
            actor: { type: "agent", id: "research" },
            assignedBy: { type: "human", id: "synthetic-creator" },
            assignedAt: 200,
          } as const;
          expect(
            assignSessionOwner(scope, {
              owner: assignment.actor,
              assignedBy: assignment.assignedBy,
              assignedAt: assignment.assignedAt,
              expectedSessionId: "portable-owner",
            }),
          ).toEqual(assignment);
          const persisted = () =>
            database.db
              .prepare(
                "SELECT current_session_id, owner_actor_type, owner_actor_id, owner_assigned_by_type, owner_assigned_by_id, owner_assigned_at FROM session_nodes WHERE session_key = ?",
              )
              .get(scope.sessionKey);
          expect(persisted()).toEqual({
            current_session_id: "portable-owner",
            owner_actor_type: "agent",
            owner_actor_id: "research",
            owner_assigned_by_type: "human",
            owner_assigned_by_id: "synthetic-creator",
            owner_assigned_at: 200,
          });
          const before = persisted();
          expect(() =>
            assignSessionOwner(scope, {
              owner: { type: "agent", id: "stale-replacement" },
              assignedBy: assignment.assignedBy,
              expectedSessionId: "replaced-session",
            }),
          ).toThrow("session changed before owner assignment");
          expect(persisted()).toEqual(before);
        }));

      it("reads worktree facts without hydrating unrelated fields, preserving SQLite scalar comparisons", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const payloadMarker = "unrelated-portable-worktree-payload";
          const worktree = {
            id: "portable-worktree",
            branch: "synthetic-branch",
            repoRoot: "/synthetic/repository",
            canonicalWorkspaceDir: "/synthetic/workspace",
          };
          const active = {
            sessionId: "portable-worktree-active",
            updatedAt: 100,
            lastInteractionAt: 200,
            lifecycleRevision: "revision-\ud800",
            worktree,
          };
          const idle = { sessionId: "portable-worktree-idle", updatedAt: 10 };
          const archived = {
            sessionId: "portable-worktree-archived",
            updatedAt: 20,
            archivedAt: 30,
          };
          const entries = [active, idle, archived].map((entry) => ({
            sessionKey: `agent:main:${entry.sessionId}`,
            entry,
          }));
          for (const { sessionKey, entry } of entries) {
            replaceSessionEntrySync(
              { agentId: "main", storePath: database.path, sessionKey },
              { ...entry, label: payloadMarker.repeat(2_048) },
            );
          }
          const aliasKey = "agent:main:portable-worktree-alias";
          replaceSessionEntrySync(
            { agentId: "main", storePath: database.path, sessionKey: aliasKey },
            { sessionId: "portable-worktree-alias", updatedAt: 100 },
          );
          runOpenClawAgentWriteTransaction(
            () => {
              // JSON1 paths truncate member labels at NUL; duplicate detection compares whole labels.
              database.db
                .prepare(
                  "UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?",
                )
                .run(
                  '{"sessionId":"portable-worktree-alias","updatedAt":100,"lifecycleRevision\\u0000alias":"alias-revision","lifecycleRevision":"exact-revision"}',
                  aliasKey,
                );
            },
            { agentId: "main", path: database.path },
          );
          const numericKey = "agent:main:portable-worktree-numeric";
          replaceSessionEntrySync(
            { agentId: "main", storePath: database.path, sessionKey: numericKey },
            { sessionId: "portable-worktree-numeric", updatedAt: 100 },
          );
          runOpenClawAgentWriteTransaction(
            () =>
              database.db
                .prepare(
                  "UPDATE session_nodes SET entry_json = ?, entry_valid = 1 WHERE session_key = ?",
                )
                .run('{"sessionId":"portable-worktree-numeric","updatedAt":"1e2"}', numericKey),
            { agentId: "main", path: database.path },
          );
          const parseJson = JSON.parse;
          const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
            if (text.startsWith('{"sessionId"') && text.includes(payloadMarker)) {
              throw new Error("worktree facts parsed an unrelated full session payload");
            }
            return parseJson(text, reviver);
          });
          try {
            expect(
              readSessionWorktreeOwnerFactsInDatabase(database, [
                ...entries.map(({ sessionKey }) => sessionKey),
                aliasKey,
                numericKey,
                "agent:main:portable-worktree-missing",
              ]).toSorted((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
            ).toEqual(
              [
                ...entries,
                {
                  sessionKey: numericKey,
                  entry: { sessionId: "portable-worktree-numeric", updatedAt: 100 },
                },
                {
                  sessionKey: aliasKey,
                  entry: {
                    sessionId: "portable-worktree-alias",
                    updatedAt: 100,
                    lifecycleRevision: "alias-revision",
                  },
                },
              ].toSorted((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
            );
          } finally {
            parse.mockRestore();
          }
        }));

      it("refuses duplicate keys, stale nullable timestamps, explicit null metadata, and malformed JSON", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const cases = [
            {
              name: "duplicate",
              json: '{"sessionId":"portable-invalid-duplicate","updatedAt":100,"lifecycleRevision":"old","lifecycleRevision":"new"}',
              archivedAt: null,
            },
            {
              name: "stale-nullable",
              json: '{"sessionId":"portable-invalid-stale-nullable","updatedAt":100}',
              archivedAt: 1,
            },
            {
              name: "explicit-null",
              json: '{"sessionId":"portable-invalid-explicit-null","updatedAt":100,"archivedAt":null}',
              archivedAt: null,
            },
            {
              name: "deep",
              json: `{"sessionId":"portable-invalid-deep","updatedAt":100,"details":${"[".repeat(1001)}0${"]".repeat(1001)}}`,
              archivedAt: null,
            },
            { name: "malformed", json: "{", archivedAt: null },
          ];
          for (const entry of cases) {
            const sessionId = `portable-invalid-${entry.name}`;
            const sessionKey = `agent:main:${sessionId}`;
            replaceSessionEntrySync(
              { agentId: "main", storePath: database.path, sessionKey },
              { sessionId, updatedAt: 100 },
            );
            runOpenClawAgentWriteTransaction(
              () => {
                database.db
                  .prepare(
                    "UPDATE session_nodes SET entry_json = ?, archived_at = ?, entry_valid = 1 WHERE session_key = ?",
                  )
                  .run(entry.json, entry.archivedAt, sessionKey);
              },
              { agentId: "main", path: database.path },
            );
            const read = () => readSessionWorktreeOwnerFactsInDatabase(database, [sessionKey]);
            if (entry.name === "malformed" || entry.name === "deep") {
              expect(read).toThrow();
            } else {
              expect(read).toThrow("requires repair");
            }
          }
        }));

      it("extracts compact SQL control facts with typed provenance and first-member selection", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const scope = {
            agentId: "main",
            storePath: database.path,
            path: database.path,
            sessionKey: "agent:main:portable-inputs",
            sessionId: "portable-inputs",
          };
          replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 100 });
          const provenance = {
            kind: "internal_system",
            sourceTool: "main_session_restart_recovery",
            sourceSessionKey: scope.sessionKey,
            nested: { enabled: true, count: 2, values: [null, "λ🦞"] },
          };
          runOpenClawAgentWriteTransaction(
            () => {
              appendTranscriptEventsInTransaction(
                database,
                scope,
                [
                  { type: "session", id: scope.sessionId, version: 3 },
                  {
                    type: "message",
                    id: "source",
                    parentId: null,
                    message: {
                      role: "user",
                      // A valid escape exercises SQLite's existing uncompressed identity path.
                      content: "unrelated input body".repeat(2_048) + "\u0001",
                      idempotencyKey: "source:user",
                      __openclaw: { runId: "source-run" },
                      provenance,
                    },
                  },
                  {
                    type: "message",
                    id: "answer",
                    parentId: "source",
                    message: { role: "assistant", content: "unrelated answer body" },
                  },
                  {
                    type: "message",
                    id: "later",
                    parentId: "answer",
                    message: { role: "user", content: "Later input", idempotencyKey: "later:user" },
                  },
                ],
                { scheduleProjectionReconcile: false },
              );
            },
            { agentId: "main", path: database.path },
          );
          const read = () =>
            executeSqliteQuerySync(
              database.db,
              getNodeSqliteKysely<DB>(database.db)
                .selectFrom("transcript_events")
                .select((eb) => [
                  jsonObjectFieldsForScan(database.db, eb.fn.coalesce("event_json", eb.val("{}")), {
                    message: { role: true },
                  }).as("facts"),
                  jsonObjectFieldsForScan(database.db, eb.fn.coalesce("event_json", eb.val("{}")), {
                    message: {
                      role: true,
                      idempotencyKey: true,
                      __openclaw: { runId: true },
                      provenance: true,
                    },
                  }).as("controls"),
                  eb
                    .fn<number>("length", [eb.fn.coalesce("event_json", eb.val(""))])
                    .as("stored_chars"),
                ])
                .where("session_id", "=", scope.sessionId)
                .where("seq", "in", [1, 3])
                .orderBy("seq", "asc"),
            ).rows;
          const rows = read();
          const compact = rows[0];
          expect(compact?.stored_chars).toBeGreaterThan(10_000);
          expect(compact?.facts.length).toBeLessThan(100);
          expect(JSON.parse(compact?.facts ?? "null")).toEqual({ message: { role: "user" } });
          const aliases = executeSqliteQuerySync(
            database.db,
            getNodeSqliteKysely<DB>(database.db).selectNoFrom((eb) =>
              jsonObjectFieldsForScan(
                database.db,
                eb.val(String.raw`{"id":"real","id\u0000hidden":"alias"}`),
                { id: true },
              ).as("facts"),
            ),
          ).rows[0];
          expect(JSON.parse(aliases?.facts ?? "null")).toEqual({
            id: "real",
            "id\0hidden": "alias",
          });
          const aliasFields = scanJsonObjectFields(aliases?.facts ?? "null", ["id", "id\0hidden"]);
          expect(jsonScannedValue(aliasFields.first.get("id"))).toBe("real");
          expect(jsonScannedValue(aliasFields.last.get("id\0hidden"))).toBe("alias");
          const expected = [
            {
              role: "user",
              idempotencyKey: "source:user",
              runId: "source-run",
              provenance,
            },
            {
              role: "user",
              idempotencyKey: "later:user",
              runId: null,
              provenance: null,
            },
          ];
          const expectControls = (selected: ReturnType<typeof read>) => {
            expect(selected).toHaveLength(expected.length);
            expect(selected.reduce((bytes, row) => bytes + row.controls.length, 0)).toBeLessThan(
              500,
            );
            for (const [index, row] of selected.entries()) {
              const message = scanJsonObjectFields(row.controls, ["message"]).first.get("message");
              expect(message?.kind).toBe("object");
              const fields = scanJsonObjectFields(message?.text ?? "{}", [
                "role",
                "idempotencyKey",
                "__openclaw",
                "provenance",
              ]).first;
              const internal = fields.get("__openclaw");
              const runId = scanJsonObjectFields(internal?.text ?? "{}", ["runId"]).first.get(
                "runId",
              );
              const expectedMessage = expected[index]!;
              expect(jsonScannedValue(fields.get("role"))).toEqual(expectedMessage.role);
              expect(jsonScannedValue(fields.get("idempotencyKey"))).toEqual(
                expectedMessage.idempotencyKey,
              );
              expect(jsonScannedValue(runId)).toEqual(expectedMessage.runId);
              expect(jsonScannedValue(fields.get("provenance"))).toEqual(
                expectedMessage.provenance,
              );
            }
          };
          expectControls(rows);
          runOpenClawAgentWriteTransaction(
            () => {
              // Imported JSON may contain duplicate members; refresh its real stored predicates too.
              const raw = `{"type":"message","id":"source","parentId":null,"message":{"role":"user","idempotencyKey":"source:user","__openclaw":{"runId":"source-run"},"provenance":${JSON.stringify(provenance)},"provenance":"ignored-later-member"}}`;
              createTranscriptPayloadUpdater(
                database.db,
                scope.sessionId,
              )({
                ...prepareTranscriptPayload(database.db, raw),
                seq: 1,
              });
            },
            { agentId: "main", path: database.path },
          );
          expectControls(read());
        }));
    },
  );
}
