import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import {
  transcriptMessage as event,
  useTranscriptFixture,
} from "./session-transcript-fixtures.test-support.js";
import { visitSessionMessagesAsync } from "./session-transcript-native.test-support.js";
import {
  readRecentSessionMessagesWithStatsAsync as readRecent,
  readSessionMessageByIdAsync as readById,
  readSessionMessageCountAsync as readCount,
  readSessionTranscriptAccountingAsync as readAccounting,
  readSessionMessagesAsync as readMessages,
  readSessionMessagesAroundIdWithStatsAsync as readAround,
  readSessionMessagesPageWithStatsAsync as readPage,
  readSessionMessagesWithSourceAsync as readSource,
} from "./session-transcript-readers.js";
import * as readers from "./session-transcript-readers.js";
import { readLatestSessionUsageFromTranscriptAsync as readUsage } from "./session-transcript-usage.js";

describe("session transcript reader facade", () => {
  const fixture = useTranscriptFixture("transcript-readers-");
  const { scopeFor, database, writeTranscript } = fixture;

  function chain(count: number, prefix: string, content: (index: number) => string) {
    return Array.from({ length: count }, (_, index) =>
      event(`${prefix}-${index}`, index ? `${prefix}-${index - 1}` : null, {
        role: "user",
        content: content(index),
      }),
    );
  }
  function writeArtifact(sessionId: string, message: Record<string, unknown>, suffix = "") {
    const file = fixture.path(`${sessionId}.jsonl${suffix}`);
    const header = JSON.stringify({ type: "session", version: 1, id: sessionId });
    fs.writeFileSync(file, `${header}\n${JSON.stringify({ message })}\n`, "utf8");
    return file;
  }
  const usageMessage = (input: number, output: number) => ({
    role: "assistant",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: { input, output, cost: { total: 0.001 } },
  });
  const expectHistoryOverflow = (read: Promise<unknown>) =>
    expect(read).rejects.toThrow("Transcript history message exceeds the 8388608-byte page limit");

  test("prepares byte, usage and taint facts without host transcript SQL", async () => {
    const events = [
      event("user", null, { role: "user", content: "question" }),
      event("answer", "user", {
        role: "assistant",
        content: "answer",
        usage: { input: 200, output: 7 },
        __openclaw: { turnTainted: true },
      }),
    ];
    const scope = await writeTranscript("accounting", events);
    const options = { includeByteSize: true, includeUsage: true, includeTurnTaint: true };
    await readAccounting(scope, options);
    const hostSql = observeHostDataSql();
    const result = await readAccounting(scope, options).finally(() => hostSql.restore());
    expect(hostSql.queries).toEqual([]);
    expect(result).toEqual({
      byteSize: events.reduce(
        (bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)) + 1,
        0,
      ),
      eventCount: 2,
      turnTainted: true,
      usage: { promptTokens: 200, outputTokens: 7, trailingMessages: [] },
    });
  });

  test("sizes CLI output from the context marker when counters cover the whole turn", async () => {
    const scope = await writeTranscript("cli-turn-usage", [
      event("answer", null, {
        role: "assistant",
        api: "cli",
        content: "multi-call turn",
        // Counters sum every model call in the turn; contextUsage is the latest call.
        usage: {
          input: 135_864,
          output: 30_000,
          cacheRead: 37_888,
          totalTokens: 203_752,
          contextUsage: { state: "available", promptTokens: 86_876, totalTokens: 88_876 },
        },
      }),
    ]);

    const result = await readAccounting(scope, { includeByteSize: false, includeUsage: true });

    expect(result.usage).toEqual({
      promptTokens: 86_876,
      outputTokens: 2_000,
      trailingMessages: [],
    });
  });

  test("reads active-branch messages and message ids through a scope", async () => {
    const root = { role: "user", content: "root prompt" };
    const answer = {
      role: "assistant",
      content: "active answer",
      idempotencyKey: "active:assistant",
    };
    const scope = await writeTranscript("reader-active-branch", [
      event("root", null, { ...root }, { timestamp: "0" }),
      event("inactive", "root", { role: "assistant", content: "stale answer" }),
      event("active", "root", { ...answer }, { timestamp: "2026" }),
    ]);

    await expect(
      readMessages(scope, { mode: "full", reason: "facade active branch test" }),
    ).resolves.toMatchObject([
      {
        content: "root prompt",
        __openclaw: { id: "root", seq: 1, recordTimestampMs: Date.parse("0") },
      },
      {
        content: "active answer",
        idempotencyKey: "active:assistant",
        __openclaw: {
          id: "active",
          seq: 2,
          recordTimestampMs: Date.parse("2026"),
          idempotencyKey: "active:assistant",
        },
      },
    ]);
    const visited: Array<{ message: unknown; seq: number }> = [];
    await expect(
      visitSessionMessagesAsync(scope, (message, seq) => visited.push({ message, seq })),
    ).resolves.toBe(2);
    expect(visited).toEqual([
      { message: root, seq: 1 },
      { message: answer, seq: 2 },
    ]);
    await expect(readCount(scope)).resolves.toBe(2);
    await expect(readById(scope, "active")).resolves.toMatchObject({
      found: true,
      oversized: false,
      seq: 2,
    });
    await expect(readAround(scope, { messageId: "active", maxMessages: 1 })).resolves.toMatchObject(
      {
        found: true,
        hasOverreadContext: true,
        messages: [{ content: "root prompt" }, { content: "active answer" }],
        offset: 0,
        totalMessages: 2,
      },
    );
  });

  test("bounds source pages and freezes their sequence across appends", async () => {
    const sessionId = "reader-source-pages";
    const scope = await writeTranscript(
      sessionId,
      chain(260, "message", (index) => `prompt ${index}`),
    );
    let page = await readSource(scope, { mode: "page" });
    expect(page.messages).toHaveLength(128);
    expect(page.nextCursor).toBeDefined();
    expect(page.snapshot).toMatchObject({ totalMessages: 260 });
    const firstCursor = page.nextCursor;
    const snapshot = page.snapshot;
    const messages = [...page.messages];

    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "appended",
          parentId: "message-259",
          message: { role: "assistant", content: "appended after the first page" },
        },
      ],
      touchSessionEntry: false,
    });
    expect(await readCount(scope)).toBe(261);
    while (page.nextCursor) {
      page = await readSource(scope, { mode: "page", cursor: page.nextCursor });
      expect(page.messages.length).toBeLessThanOrEqual(128);
      expect(page.snapshot).toEqual(snapshot);
      messages.push(...page.messages);
    }
    expect(
      messages.map((message) => (message as { __openclaw: { id: string } })["__openclaw"].id),
    ).toEqual(Array.from({ length: 260 }, (_, index) => `message-${index}`));

    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: sessionId },
      event("replacement", null, { role: "user", content: "new transcript" }),
    ]);
    await expect(readSource(scope, { mode: "page", cursor: firstCursor })).rejects.toMatchObject({
      name: "SessionTranscriptProjectionUnavailableError",
      reason: "window-changed",
    });
  });

  test("bounds source pages by bytes and rejects a message larger than one page", async () => {
    const sessionId = "reader-source-page-bytes";
    const content = "a".repeat(3 * 1024 * 1024);
    const scope = await writeTranscript(
      sessionId,
      chain(3, "large", () => content),
    );
    expect(await readCount(scope)).toBe(3);
    const first = await readSource(scope, { mode: "page" });
    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const last = await readSource(scope, { mode: "page", cursor: first.nextCursor });
    expect(last.messages).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
    for (const page of [first, last]) {
      expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThan(8 * 1024 * 1024);
      for (const message of page.messages) {
        expect((message as { content: string }).content).toBe(content);
      }
    }

    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: sessionId },
      event("oversized", null, { role: "user", content: "b".repeat(8 * 1024 * 1024) }),
    ]);
    expect(await readCount(scope)).toBe(1);
    await expect(readSource(scope, { mode: "page" })).rejects.toThrow(
      "Transcript source message exceeds the 8388608-byte page limit",
    );
    await expectHistoryOverflow(readPage(scope, { offset: 0, maxMessages: 1 }));
    await expectHistoryOverflow(readRecent(scope, { maxMessages: 1 }));
    await expectHistoryOverflow(readAround(scope, { messageId: "oversized", maxMessages: 1 }));
    database()
      .db.prepare("DELETE FROM transcript_event_identities WHERE session_id = ?")
      .run(sessionId);
    await expect(readById(scope, "oversized")).resolves.toMatchObject({ found: true });
    await expectHistoryOverflow(readAround(scope, { messageId: "oversized", maxMessages: 1 }));
  });

  test("bounds unbounded anchor windows and caps payloads before decoding", async () => {
    const sessionId = "reader-anchor-page-bytes";
    const scope = await writeTranscript(
      sessionId,
      chain(3, "large", () => "a".repeat(3 * 1024 * 1024)),
    );
    // Earlier-history paging anchors on older windows; an oversized window must still page.
    const older = await readAround(scope, {
      messageId: "large-2",
      maxMessages: 3,
      direction: "older",
    });
    expect(older.messages).toMatchObject([
      { __openclaw: { id: "large-1" } },
      { __openclaw: { id: "large-2" } },
    ]);
    expect(
      (await readAround(scope, { messageId: "large-1", maxMessages: 3 })).messages,
    ).toMatchObject([{ __openclaw: { id: "large-0" } }, { __openclaw: { id: "large-1" } }]);
    const db = database();
    // Preserve recorded sizes while poisoning excluded payloads: a late cap would parse this.
    db.db
      .prepare(
        "UPDATE transcript_events SET event_json = '{malformed', event_zstd = NULL WHERE session_id = ? AND seq = 1",
      )
      .run(sessionId);
    const page = await readAround(scope, {
      messageId: "large-1",
      maxMessages: 3,
      maxBytes: 4 * 1024 * 1024,
    });
    expect(page.messages).toMatchObject([{ __openclaw: { id: "large-1" } }]);
    expect(page.hasOverreadContext).toBe(false);
  });

  test.each([false, true])(
    "pages adjacent 5 MiB messages in both directions (historical=%s)",
    async (historical) => {
      const ids = ["large-0", "large-1", "large-2"];
      const events: unknown[] = chain(3, "large", () => "a".repeat(5 * 1024 * 1024));
      if (historical) {
        events.push({
          type: "reset",
          id: "reset",
          parentId: "large-2",
          timestamp: "2026-10-01T00:00:00.000Z",
        });
        ids.push("reset");
      }
      const scope = await writeTranscript("anchor-walk", events);
      const params = {
        entry: undefined,
        provider: undefined,
        sessionId: scope.sessionId,
        storePath: scope.storePath,
        sessionAgentId: scope.agentId,
        canonicalKey: scope.sessionKey,
        max: 3,
        maxHistoryBytes: 8 * 1024 * 1024,
        effectiveMaxChars: 100,
        offset: undefined,
        messageId: "large-1",
      };
      const jump = await readChatHistoryPageKernel(params, { readers });
      expect(jump.messages.map(readChatHistoryMessageId)).toContain("large-1");
      for (const direction of ["older", "newer"] as const) {
        const expected = direction === "older" ? ids.toReversed() : ids;
        // A closing reset uses the current interval; start older traversal at its preceding message.
        const traversal = historical && direction === "older" ? expected.slice(1) : expected;
        let messageId = traversal[0]!;
        const seen = [messageId];
        for (let index = 1; index < traversal.length; index++) {
          const page = await readChatHistoryPageKernel(
            {
              ...params,
              messageId,
              pageCursor: {
                sessionId: scope.sessionId,
                source: jump.anchor!.source,
                messageId,
                direction,
              },
            },
            { readers },
          );
          expect(page.windowReset).not.toBe(true);
          const actual = page.messages.map(readChatHistoryMessageId);
          if (direction === "older") {
            actual.reverse();
          }
          expect(actual.length).toBeGreaterThan(0);
          seen.push(...actual.filter((id): id is string => id !== undefined));
          messageId =
            direction === "older" ? page.anchor!.oldestMessageId! : page.anchor!.newestMessageId!;
          const hasMore = direction === "older" ? page.anchor!.hasOlder : page.anchor!.hasNewer;
          expect(hasMore).toBe(seen.length < traversal.length);
          if (!hasMore) {
            break;
          }
        }
        expect(seen).toEqual(traversal);
      }
    },
  );

  test("acquires messages incrementally and releases the cursor after visitor failure", async () => {
    const sessionId = "reader-stream-visitor";
    const scope = await writeTranscript(sessionId, [
      event("first", null, { role: "user", content: "first prompt" }),
      event("later", "first", { role: "assistant", content: "later answer" }),
    ]);
    const db = database();
    // Keep the ready projection, but poison a later payload: an early abort must never parse it.
    db.db
      .prepare(
        `UPDATE transcript_events SET event_json = '{malformed'
           WHERE session_id = ? AND seq = (
             SELECT MAX(seq) FROM transcript_events WHERE session_id = ?
           )`,
      )
      .run(sessionId, sessionId);
    const stopped = new Error("visitor stopped");
    const visited: Array<{ message: unknown; seq: number }> = [];
    const traversal = visitSessionMessagesAsync(scope, (message, seq) => {
      expect(db.db.isTransaction).toBe(true);
      visited.push({ message, seq });
      throw stopped;
    });
    await expect(traversal).rejects.toBe(stopped);
    expect(visited).toEqual([{ message: { role: "user", content: "first prompt" }, seq: 1 }]);
    expect(db.db.isTransaction).toBe(false);
    // A surviving read cursor prevents checkpointing even after transaction rollback.
    expect(db.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
  });

  test("keeps SQLite precedence by ignoring an obsolete active JSONL during archive fallback", async () => {
    const sessionId = "reader-reset-archive-only";
    const scope = scopeFor(sessionId);
    writeArtifact(sessionId, { role: "assistant", content: "obsolete live file" });
    writeArtifact(
      sessionId,
      { role: "assistant", content: "retained archive" },
      ".reset.2026-07-12T18-00-00.000Z",
    );

    for (const allowResetArchiveFallback of [false, undefined]) {
      await expect(
        readPage(scope, {
          offset: 0,
          maxMessages: 1,
          allowResetArchiveFallback,
        }),
      ).rejects.toMatchObject({
        name: "SessionTranscriptStorageUnavailableError",
        reason: "database-missing",
      });
    }

    await expect(
      readMessages(scope, {
        mode: "full",
        reason: "archive-only fallback test",
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject([{ content: "retained archive" }]);
    await expect(
      readRecent(scope, { maxMessages: 1, allowResetArchiveFallback: true }),
    ).resolves.toMatchObject({ messages: [{ content: "retained archive" }] });
    await expect(
      readPage(scope, { offset: 0, maxMessages: 1, allowResetArchiveFallback: true }),
    ).resolves.toMatchObject({ messages: [{ content: "retained archive" }] });
  });

  test.each(["artifact", "sqlite"] as const)(
    "reads usage from %s storage with a placeholder store path",
    async (storage) => {
      const sessionId = `reader-placeholder-${storage}`;
      const sessionKey = `agent:main:${sessionId}`;
      const message = usageMessage(15, 4);
      if (storage === "sqlite") {
        await persistSessionTranscriptTurn(
          {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath: fixture.path("agents", "main", "sessions", "sessions.json"),
          },
          { messages: [{ message }], updateMode: "file-only" },
        );
      }
      const scope =
        storage === "artifact"
          ? {
              agentId: "main",
              sessionId,
              sessionKey,
              sessionFile: writeArtifact(sessionId, message),
            }
          : { sessionId, sessionKey, sessionFile: sessionKey };
      await expect(readUsage({ ...scope, storePath: "(multiple)" })).resolves.toMatchObject({
        inputTokens: 15,
        outputTokens: 4,
      });
    },
  );

  test("waits for an in-flight SQLite projection before counting messages", async () => {
    const sessionId = "reader-sqlite-rebuilding-count";
    const scope = scopeFor(sessionId);
    await persistSessionTranscriptTurn(scope, {
      messages: [
        ["root", null, "user", "cross-client prompt"] as const,
        ["reply", "root", "assistant", "cross-client reply"] as const,
      ].map(([eventId, parentId, role, content]) => ({
        eventId,
        parentId,
        message: { role, content },
      })),
      touchSessionEntry: false,
    });
    database()
      .db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      )
      .run(sessionId);

    const visited: unknown[] = [];
    await expect(
      visitSessionMessagesAsync(scope, (message) => visited.push(message)),
    ).rejects.toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
    expect(visited).toEqual([]);
    await expect(readCount(scope)).resolves.toBe(2);
  });
});
