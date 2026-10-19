import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { readCacheTtlProjectionPrefix } from "./session-cache-ttl-prefix.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

it.each([false, true])(
  "selects cache-TTL dependencies without scanning messages (analyzed=%s)",
  async (analyzed) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database, scope } = createSessionCompoundWorkerFixture();
      const checkpoint = {
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
      const messages = Array.from({ length: 1_000 }, (_, index) => ({
        type: "message",
        id: `message-${index}`,
        parentId: index === 0 ? checkpoint.id : `message-${index - 1}`,
        message: { role: "user", content: `synthetic-${index}` },
      }));
      runOpenClawAgentWriteTransaction(
        () =>
          appendTranscriptEventsInTransaction(
            database,
            scope,
            [{ type: "session", id: scope.sessionId, version: 3 }, checkpoint, ...messages],
            { scheduleProjectionReconcile: false },
          ),
        { agentId: database.agentId, path: database.path },
      );
      if (analyzed) {
        database.db.exec("ANALYZE");
      }
      const prepare = database.db.prepare.bind(database.db);
      const statements: StatementSync[] = [];
      const spy = vi.spyOn(database.db, "prepare").mockImplementation((query) => {
        const statement = prepare(query);
        const columns = statement.columns().map(({ name }) => name);
        if (
          columns.length === 2 &&
          columns.includes("event_json") &&
          columns.includes("navigation_valid")
        ) {
          statements.push(statement);
        }
        return statement;
      });
      try {
        const anchor = messages.at(-1)!;
        const prefix = withCurrentProjectionSnapshot(scope, (projection) =>
          readCacheTtlProjectionPrefix(projection, {
            activePosition: messages.length,
            id: anchor.id,
            entry: anchor,
          }),
        );
        expect(prefix).toEqual({ anchorIds: [anchor.id], entries: [checkpoint] });
        expect(statements).toHaveLength(1);
        const plan = prepare(`EXPLAIN QUERY PLAN ${statements[0]!.expandedSQL}`).all();
        const drivingSearch = plan.find(
          ({ detail }) => typeof detail === "string" && detail.startsWith("SEARCH "),
        )?.detail;
        expect(drivingSearch).toMatch(/\(session_id=\? AND event_type=\?/u);
      } finally {
        spy.mockRestore();
      }
    });
  },
);
