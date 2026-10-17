import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendTranscriptEventsInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function message(id: string, parentId: string | null, timestamp: number) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content: id, idempotencyKey: id },
  };
}

it("settles batch recency and index once, including rejected attempts and a later rewrite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { database, scope, events } = createSessionCompoundWorkerFixture();
    const write = (run: () => void) =>
      runOpenClawAgentWriteTransaction(run, { agentId: "main", path: database.path });
    const append = (rows: ReturnType<typeof message>[]) =>
      appendTranscriptEventsInTransaction(database, scope, rows, { idempotencyKeyMode: "dedupe" });
    const window = () =>
      database.db
        .prepare(
          "SELECT updated_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
        )
        .get(scope.sessionId);
    const index = () =>
      database.db
        .prepare(
          "SELECT active_event_count, active_message_count, indexed_seq, leaf_event_id, needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId);
    const generation = () =>
      database.db
        .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id = ?")
        .get(scope.sessionId)?.generation;
    vi.spyOn(Date, "now").mockReturnValue(1000);
    write(() => expect(append([message("root", null, 10)])).toBe(1));
    const originalGeneration = generation();
    const writes = trackSqliteStatementExecutions(database.db, ["window", "index"], (sql) => {
      if (/^update "session_windows"/i.test(sql)) {
        return "window";
      }
      return /^(?:insert into|update) "session_transcript_index_state"/i.test(sql) ? "index" : null;
    });
    try {
      write(() =>
        expect(
          append([
            message("one", "root", 20),
            message("two", "one", 30),
            message("two", "one", 25),
            {
              ...message("rejected", "two", 40),
              message: { role: "user", content: "retry", idempotencyKey: "one" },
            },
          ]),
        ).toBe(2),
      );
      expect(writes.counts).toEqual({ window: 1, index: 1 });
    } finally {
      writes.restore();
    }
    expect(events().map((event) => event.id)).toEqual(["root", "one", "two"]);
    expect(window()).toEqual({ updated_at: 40, transcript_updated_at: 1001 });
    expect(index()).toEqual({
      active_event_count: 3,
      active_message_count: 3,
      indexed_seq: 2,
      leaf_event_id: "two",
      needs_rebuild: 0,
    });
    expect(generation()).toBe(originalGeneration);
    write(() => expect(append([message("two", "one", 50)])).toBe(0));
    expect(window()).toEqual({ updated_at: 50, transcript_updated_at: 1001 });
    write(() =>
      replaceSqliteTranscriptEventsInTransaction(database, scope, [message("reset", null, 60)]),
    );
    const rewrittenGeneration = generation();
    expect(rewrittenGeneration).not.toBe(originalGeneration);
    write(() => expect(append([message("after", "reset", 70)])).toBe(1));
    expect(generation()).toBe(rewrittenGeneration);
    expect(index()).toEqual({
      active_event_count: 2,
      active_message_count: 2,
      indexed_seq: 1,
      leaf_event_id: "after",
      needs_rebuild: 0,
    });
  });
});

it.each(["commit prefix", "rollback"] as const)(
  "settles a throwing iterator before %s",
  async (outcome) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database, scope, events } = createSessionCompoundWorkerFixture();
      const write = (run: () => void) =>
        runOpenClawAgentWriteTransaction(run, { agentId: "main", path: database.path });
      vi.spyOn(Date, "now").mockReturnValue(1000);
      write(() => {
        appendTranscriptEventsInTransaction(database, scope, [message("root", null, 10)]);
      });
      const feedback: boolean[] = [];
      function* rows(): Generator<ReturnType<typeof message>, void, boolean> {
        feedback.push(yield message("one", "root", 20));
        feedback.push(yield message("one", "root", 30));
        feedback.push(yield message("two", "one", 40));
        throw new Error("source failed");
      }
      const append = () => appendTranscriptEventsInTransaction(database, scope, rows());
      if (outcome === "rollback") {
        expect(() => write(append)).toThrow("source failed");
      } else {
        write(() => expect(append).toThrow("source failed"));
      }
      expect(feedback).toEqual([true, false, true]);
      const retained = outcome === "commit prefix";
      expect(events().map((event) => event.id)).toEqual(
        retained ? ["root", "one", "two"] : ["root"],
      );
      expect(
        database.db
          .prepare(
            "SELECT updated_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
          )
          .get(scope.sessionId),
      ).toEqual({ updated_at: retained ? 40 : 10, transcript_updated_at: 1000 });
      expect(
        database.db
          .prepare(
            "SELECT indexed_seq, leaf_event_id, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
          )
          .get(scope.sessionId),
      ).toEqual({
        indexed_seq: retained ? 2 : 0,
        leaf_event_id: retained ? "two" : "root",
        active_message_count: retained ? 3 : 1,
      });
    });
  },
);
