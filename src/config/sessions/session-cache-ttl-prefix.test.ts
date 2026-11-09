import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

it.each([false, true])(
  "bounds imported cache-TTL prefix identity probes (analyzed=%s)",
  async (analyzed) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database, scope } = createSessionCompoundWorkerFixture();
      const marker = {
        type: "custom",
        id: "checkpoint",
        parentId: null,
        customType: "openclaw.cache-ttl",
        data: {
          prunedToolResults: [{ key: "synthetic-tool", mode: "soft" }],
          ambiguousToolResultBaseKeys: [],
          frozenToolResults: [],
        },
      };
      const messages = Array.from({ length: 128 }, (_, index) => ({
        type: "message",
        id: `message-${index}`,
        parentId: index === 0 ? marker.id : `message-${index - 1}`,
        message: { role: "user", content: "synthetic message payload ".repeat(32) },
      }));
      runOpenClawAgentWriteTransaction(
        () => {
          appendTranscriptEventsInTransaction(
            database,
            scope,
            [{ type: "session", id: scope.sessionId, version: 3 }, marker, ...messages],
            { scheduleProjectionReconcile: false },
          );
          // Imported transcripts can retain the canonical header without its auxiliary identity.
          database.db
            .prepare("DELETE FROM transcript_event_identities WHERE session_id = ? AND seq = 0")
            .run(scope.sessionId);
        },
        { agentId: database.agentId, path: database.path },
      );
      if (analyzed) {
        database.db.exec("ANALYZE");
      }
      clearNodeSqliteKyselyCacheForDatabase(database.db);
      const prepare = database.db.prepare.bind(database.db);
      const statements = new Map<StatementSync, string>();
      let prefixRows = 0;
      const spy = vi.spyOn(database.db, "prepare").mockImplementation((query) => {
        const statement = prepare(query);
        if (
          query.includes('"transcript_event_identities"') &&
          query.includes('"active"."active_position" <') &&
          statement.columns().some(({ name }) => name === "event_json") &&
          statement.columns().some(({ name }) => name === "navigation_valid")
        ) {
          statement.iterate = new Proxy(statement.iterate.bind(statement), {
            apply(invoke, receiver: StatementSync, args) {
              const rows: ReturnType<StatementSync["iterate"]> = Reflect.apply(
                invoke,
                receiver,
                args,
              );
              statements.set(statement, receiver.expandedSQL);
              return (function* () {
                for (const row of rows) {
                  prefixRows += 1;
                  yield row;
                }
              })();
            },
          });
        }
        return statement;
      });
      try {
        // Exercise the bounded-context consumer, not a separately assembled lookalike SQL query.
        const bounded = readSessionTranscriptBoundedActiveContextCore(scope, {
          maxBytes: 4096,
          maxEvents: 2,
        });
        expect(bounded.truncated).toBe(true);
        expect(bounded.events).toEqual([
          { type: "session", id: scope.sessionId, version: 3 },
          ...messages.slice(-2),
        ]);
        expect(bounded.cacheTtlProjectionPrefixes).toEqual([
          { anchorIds: [messages.at(-2)!.id], entries: [marker] },
        ]);
        expect(prefixRows).toBe(1);
        expect(statements.size).toBe(1);
        const query = statements.values().next().value;
        if (!query) {
          throw new Error("Expected the executed prefix query with its actual bindings");
        }
        const plan = prepare("EXPLAIN QUERY PLAN " + query).all();
        expect(
          plan.some(
            ({ detail }) =>
              typeof detail === "string" &&
              detail.includes("idx_agent_transcript_event_identity_sequence") &&
              detail.includes("(session_id=? AND seq=?) LEFT-JOIN"),
          ),
        ).toBe(true);
      } finally {
        spy.mockRestore();
        clearNodeSqliteKyselyCacheForDatabase(database.db);
      }
    });
  },
);
