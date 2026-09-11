// Context accounting excludes display-only activity without changing durable history.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  loadTranscriptEventsSync,
  persistSessionTranscriptTurn,
  readTranscriptStatsSync,
} from "./session-accessor.js";
import {
  readRecentSessionTranscriptActiveEvents,
  readSessionTranscriptActiveStats,
  readSessionTranscriptMessageEventPage,
  withRecentSessionTranscriptActiveEvents,
} from "./session-accessor.sqlite-active-events.js";
import { reconcileSessionTranscriptIndexes } from "./session-transcript-reconcile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readSessionTranscriptMessageEventCount = (
  scope: Parameters<typeof readSessionTranscriptMessageEventPage>[0],
): number =>
  readSessionTranscriptMessageEventPage(scope, { maxMessages: 0, offset: 0 }).totalMessages;

describe("SQLite transcript context accounting", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    const stateDir = tempDirs.make("openclaw-context-accounting-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "context-accounting-test",
      sessionKey: "agent:main:context-accounting-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["append", "rebuild"])(
    "keeps usage and bootstrap facts inside the bounded context tail after %s despite display activity",
    async (mode) => {
      await appendTranscriptEvent(scope, {
        type: "custom",
        id: "bootstrap",
        parentId: null,
        customType: "bootstrap-completed",
        data: {},
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          {
            eventId: "usage",
            parentId: "bootstrap",
            message: {
              role: "assistant",
              content: "answer",
              usage: { input: 86_000, output: 2_000 },
            },
          },
          ...Array.from({ length: 513 }, (_, index) => ({
            eventId: `display-${index}`,
            parentId: index === 0 ? "usage" : `display-${index - 1}`,
            message: {
              role: "custom",
              customType: "tool-activity",
              display: true,
              excludeFromContext: true,
              content: "completed",
            },
          })),
        ],
        touchSessionEntry: false,
      });

      if (mode === "rebuild") {
        openOpenClawAgentDatabase(scope)
          .db.prepare(
            "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
          )
          .run(scope.sessionId);
        expect(await reconcileSessionTranscriptIndexes(scope)).toEqual({ reconciledSessions: 1 });
      }
      const tail = readRecentSessionTranscriptActiveEvents(scope, 2);
      expect(tail.map((event) => (event as { id: string }).id)).toEqual(["bootstrap", "usage"]);
      expect(tail[1]).toMatchObject({ message: { usage: { input: 86_000, output: 2_000 } } });
      const visited: unknown[] = [];
      withRecentSessionTranscriptActiveEvents(scope, 2, (visit) => {
        visit((event) => visited.push(event));
      });
      expect(visited).toEqual(tail.toReversed());
      expect(readTranscriptStatsSync(scope).eventCount).toBeGreaterThan(513);
    },
  );

  it("keeps repeated visits on one snapshot and expires their reader on return", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "seed", parentId: null, message: { role: "user", content: "before" } }],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase(scope);
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(database.path);
    let savedVisit: ((visitor: (event: unknown) => void) => void) | undefined;
    const first: unknown[] = [];
    const second: unknown[] = [];
    try {
      withRecentSessionTranscriptActiveEvents(scope, 1, (visit) => {
        savedVisit = visit;
        visit((event) => first.push(event));
        writer.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?").run(
          JSON.stringify({
            type: "message",
            id: "seed",
            parentId: null,
            message: { role: "user", content: "after" },
          }),
          scope.sessionId,
        );
        visit((event) => second.push(event));
      });
    } finally {
      writer.close();
    }
    expect(first).toMatchObject([{ message: { content: "before" } }]);
    expect(second).toEqual(first);
    expect(readRecentSessionTranscriptActiveEvents(scope, 1)).toMatchObject([
      { message: { content: "after" } },
    ]);
    expect(() => savedVisit?.(() => {})).toThrow("outside its read snapshot");
  });

  it.each(["json", "sql", "consumer"] as const)(
    "preserves %s failure precedence and releases the read cursor",
    async (failureKind) => {
      await persistSessionTranscriptTurn(scope, {
        messages: [
          { eventId: "oldest", parentId: null, message: { role: "user", content: "oldest" } },
          {
            eventId: "middle",
            parentId: "oldest",
            message: { role: "assistant", content: "middle" },
          },
          { eventId: "newest", parentId: "middle", message: { role: "user", content: "newest" } },
        ],
        touchSessionEntry: false,
      });
      const database = openOpenClawAgentDatabase(scope);
      const failure = new Error("consumer stopped");
      const malformed = '{"old":}';
      let parseFailure: Error | undefined;
      try {
        JSON.parse(malformed);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        parseFailure = error;
      }
      if (failureKind !== "consumer") {
        // The connection-local view corrupts reads without changing canonical rows or projections.
        database.db.exec(`CREATE TEMP VIEW transcript_events AS
          SELECT event.session_id, event.seq, event.created_at,
            CASE identity.event_id
              WHEN 'oldest' THEN ${failureKind === "sql" ? "json_extract('{broken', '$')" : "'{\"old\":}'"}
              WHEN 'middle' THEN '{"newer":}'
              ELSE event.event_json
            END AS event_json
          FROM main.transcript_events AS event
          JOIN transcript_event_identities AS identity
            ON identity.session_id = event.session_id AND identity.seq = event.seq`);
      }
      try {
        if (failureKind === "consumer") {
          expect(() =>
            withRecentSessionTranscriptActiveEvents(scope, 3, (visit) => {
              visit(() => {
                throw failure;
              });
            }),
          ).toThrow(failure);
        } else {
          expect(() => readRecentSessionTranscriptActiveEvents(scope, 3)).toThrow(
            failureKind === "sql" ? "malformed JSON" : parseFailure,
          );
        }
      } finally {
        if (failureKind !== "consumer") {
          database.db.exec("DROP VIEW temp.transcript_events");
        }
      }
      expect(database.db.isTransaction).toBe(false);
      expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
        busy: 0,
      });
      expect(readRecentSessionTranscriptActiveEvents(scope, 3)).toHaveLength(3);
      await appendTranscriptEvent(scope, { type: "custom", id: "after", parentId: "newest" });
      expect(readRecentSessionTranscriptActiveEvents(scope, 1)).toMatchObject([{ id: "after" }]);
    },
  );

  it.each(["unbounded", "reset", "compaction"] as const)(
    "does not count display-only activity toward %s context pressure",
    async (boundary) => {
      const activity = {
        role: "custom",
        customType: "tool-activity",
        display: true,
        excludeFromContext: true,
        content: "",
        details: { output: "x".repeat(32_000) },
        timestamp: 1,
      };
      await persistSessionTranscriptTurn(scope, {
        messages: [
          { eventId: "kept-user", parentId: null, message: { role: "user", content: "question" } },
          { eventId: "display-prefix", parentId: "kept-user", message: activity },
          {
            eventId: "kept-assistant",
            parentId: "display-prefix",
            message: { role: "assistant", content: "answer" },
          },
        ],
        touchSessionEntry: false,
      });
      if (boundary !== "unbounded") {
        await appendTranscriptEvent(scope, {
          type: boundary,
          id: "boundary",
          parentId: "kept-assistant",
          timestamp: "2026-08-28T00:00:00.000Z",
          firstKeptEntryId: "kept-user",
          ...(boundary === "compaction"
            ? { summary: "summary", tokensBefore: 100 }
            : { reason: "reset" }),
        });
      }
      const contextIds = new Set([
        "kept-user",
        "kept-assistant",
        ...(boundary === "compaction" ? ["boundary"] : []),
      ]);
      const contextEvents = loadTranscriptEventsSync(scope).filter((event) =>
        contextIds.has((event as { id: string }).id),
      );
      const expected = {
        eventCount: contextEvents.length,
        sizeBytes: contextEvents.reduce<number>(
          (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8") + 1,
          0,
        ),
      };
      expect(readSessionTranscriptActiveStats(scope)).toEqual(expected);
      const physicalBefore = readTranscriptStatsSync(scope);
      const historyBefore = readSessionTranscriptMessageEventCount(scope);
      await persistSessionTranscriptTurn(scope, {
        messages: [{ eventId: "display-tail", message: activity }],
        touchSessionEntry: false,
      });

      expect(readSessionTranscriptActiveStats(scope)).toEqual(expected);
      expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(
        physicalBefore.sizeBytes + 32_000,
      );
      expect(readSessionTranscriptMessageEventCount(scope)).toBe(historyBefore + 1);
    },
  );
});
