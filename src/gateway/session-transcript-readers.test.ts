import fs from "node:fs";
import { constants, zstdCompressSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { realisticTranscriptText } from "../../test/helpers/session-archive.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionArchiveReadPath } from "../config/sessions/archive-compression.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { ArchivedTranscriptReader } from "./session-transcript-archive-reader.js";
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
import { MAX_OVERSIZED_TRANSCRIPT_RECORD_BYTES } from "./session-transcript-record-parser.js";
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
  const oversizedStandIn = [{ type: "text", text: "[chat.history omitted: message too large]" }];
  /** The oversized row keeps its place and its id, and costs the page only its bound. */
  const expectBoundedStandInPage = (messages: unknown[]) => {
    expect(messages.map(readChatHistoryMessageId)).toEqual(["first", "huge", "last"]);
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(
      MAX_OVERSIZED_TRANSCRIPT_RECORD_BYTES,
    );
  };

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

  test("bounds source pages by bytes and stands in for a message larger than one page", async () => {
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
    // Model-context source pages still refuse a row they cannot carry whole.
    await expect(readSource(scope, { mode: "page" })).rejects.toThrow(
      "Chat history message exceeds the 8388608-byte page limit",
    );
    // History pages serve the documented stand-in rather than failing the page.
    await expect(readPage(scope, { offset: 0, maxMessages: 1 })).resolves.toMatchObject({
      messages: [{ content: oversizedStandIn }],
    });
    await expect(readRecent(scope, { maxMessages: 1 })).resolves.toMatchObject({
      messages: [{ content: oversizedStandIn }],
    });
    await expect(
      readAround(scope, { messageId: "oversized", maxMessages: 1 }),
    ).resolves.toMatchObject({ found: true, messages: [{ content: oversizedStandIn }] });
    database()
      .db.prepare("DELETE FROM transcript_event_identities WHERE session_id = ?")
      .run(sessionId);
    // Exact reads stay whole; they are the fetchable reference behind the stand-in.
    await expect(readById(scope, "oversized")).resolves.toMatchObject({ found: true });
    await expect(
      readAround(scope, { messageId: "oversized", maxMessages: 1 }),
    ).resolves.toMatchObject({ found: true, messages: [{ content: oversizedStandIn }] });
  });

  // docs/web/webchat.md promises an oversized entry becomes
  // "[chat.history omitted: message too large]" rather than exceeding the page budget;
  // one such row must not make a whole session unreadable.
  test("keeps history readable across an inline-image row larger than one page", async () => {
    const scope = await writeTranscript("reader-oversized-row", [
      event("first", null, { role: "user", content: "first prompt" }),
      event("huge", "first", {
        role: "user",
        content: Array.from({ length: 5 }, () => ({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "A".repeat(2 * 1024 * 1024) },
        })),
      }),
      event("last", "huge", { role: "assistant", content: "last answer" }),
    ]);
    expect(await readCount(scope)).toBe(3);
    expectBoundedStandInPage((await readPage(scope, { offset: 0, maxMessages: 3 })).messages);
    expectBoundedStandInPage((await readRecent(scope, { maxMessages: 3 })).messages);
    expectBoundedStandInPage(
      (await readAround(scope, { messageId: "huge", maxMessages: 3 })).messages,
    );
    // Anchoring on a neighbor has to keep the window expanding across the huge row:
    // truncating it would drop the rows past it with nothing disclosed to the client.
    expectBoundedStandInPage(
      (await readAround(scope, { messageId: "last", maxMessages: 3 })).messages,
    );
    // The chat.history kernel behind the Control UI serves the same bounded page.
    const history = await readChatHistoryPageKernel(
      {
        entry: undefined,
        provider: undefined,
        sessionId: scope.sessionId,
        storePath: scope.storePath,
        sessionAgentId: scope.agentId,
        canonicalKey: scope.sessionKey,
        max: 3,
        maxHistoryBytes: 8 * 1024 * 1024,
        effectiveMaxChars: 1_000_000,
        offset: 0,
        messageId: undefined,
      },
      { readers },
    );
    expectBoundedStandInPage(history.messages);
  });

  // A display row that is not a message (compaction, reset, custom_message) is charged
  // the stand-in bound at admission like any other oversized row, so the page must not
  // select its payload either.
  test("stands in for an oversized non-message display row", async () => {
    const scope = await writeTranscript("reader-oversized-display-row", [
      event("first", null, { role: "user", content: "first prompt" }),
      {
        type: "custom_message",
        id: "huge",
        parentId: "first",
        timestamp: "2026-08-11T18:00:00.000Z",
        customType: "run-failed-before-reply",
        content: "c".repeat(9 * 1024 * 1024),
        display: true,
      },
      event("last", "huge", { role: "assistant", content: "last answer" }),
    ]);
    expectBoundedStandInPage((await readPage(scope, { offset: 0, maxMessages: 3 })).messages);
    expectBoundedStandInPage((await readRecent(scope, { maxMessages: 3 })).messages);
    expectBoundedStandInPage(
      (await readAround(scope, { messageId: "huge", maxMessages: 3 })).messages,
    );
  });

  // Admission charges an oversized row only the stand-in bound, so the reader must not
  // select its payload either: sixteen such rows would otherwise fit one page's charge
  // while the history worker materialized every body.
  test.each([false, true])(
    "serves an oversized row from its identity without selecting its payload (historical=%s)",
    async (historical) => {
      const sessionId = `reader-oversized-unselected-${historical}`;
      const events: unknown[] = [
        event("first", null, { role: "user", content: "first prompt" }),
        event("huge", "first", { role: "user", content: "h".repeat(9 * 1024 * 1024) }),
        event("last", "huge", { role: "assistant", content: "last answer" }),
      ];
      if (historical) {
        events.push({
          type: "reset",
          id: "reset",
          parentId: "last",
          timestamp: "2026-10-01T00:00:00.000Z",
        });
      }
      const scope = await writeTranscript(sessionId, events);
      // Keep the recorded size but poison the body: any reader that selects it fails to parse.
      database()
        .db.prepare(
          `UPDATE transcript_events
             SET event_utf8_bytes = coalesce(event_utf8_bytes, octet_length(event_json)),
                 event_json = '{malformed'
           WHERE session_id = ? AND seq = (
             SELECT seq FROM transcript_event_identities WHERE session_id = ? AND event_id = 'huge'
           )`,
        )
        .run(sessionId, sessionId);
      // The reset that closes the interval takes one slot of an anchored page.
      const max = historical ? 4 : 3;
      const kernel = (messageId: string | undefined) =>
        readChatHistoryPageKernel(
          {
            entry: undefined,
            provider: undefined,
            sessionId: scope.sessionId,
            storePath: scope.storePath,
            sessionAgentId: scope.agentId,
            canonicalKey: scope.sessionKey,
            max,
            maxHistoryBytes: 8 * 1024 * 1024,
            effectiveMaxChars: 1_000_000,
            offset: undefined,
            messageId,
          },
          { readers },
        );
      if (!historical) {
        expectBoundedStandInPage((await readPage(scope, { offset: 0, maxMessages: 3 })).messages);
        expectBoundedStandInPage((await readRecent(scope, { maxMessages: 3 })).messages);
        expectBoundedStandInPage((await kernel(undefined)).messages);
      }
      const messagesOf = (page: { messages: unknown[] }) =>
        page.messages.filter((message) => readChatHistoryMessageId(message) !== "reset");
      for (const messageId of ["huge", "last"]) {
        expectBoundedStandInPage(
          messagesOf(await readAround(scope, { messageId, maxMessages: max })),
        );
        expectBoundedStandInPage(messagesOf(await kernel(messageId)));
      }
    },
  );

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

  // #190690 refused both: a ~10x production transcript and its own 2 MiB repeated-byte frame.
  // History's own per-message payload cap still applies once the archive is readable.
  test.each([
    [
      "production-like",
      (index: number) => realisticTranscriptText(64 * 1024, index + 1),
      realisticTranscriptText(64 * 1024, 24),
    ],
    [
      "repeated-byte bomb",
      (index: number) => (index === 23 ? "x".repeat(2 * 1024 * 1024) : "m"),
      [{ type: "text", text: "[chat.history omitted: message too large]" }],
    ],
  ] as const)(
    "reads %s archives during discovery and exact reads",
    async (_shape, content, latest) => {
      const sessionId = "reader-expanding-archive";
      const sessionFile = fixture.path("custom.jsonl");
      const scope = { ...scopeFor(sessionId), sessionFile };
      const archivePath = `${sessionFile}.reset.2026-07-12T18-00-00.000Z.zst`;
      const body = chain(24, "m", content).map((entry) => JSON.stringify(entry));
      const plaintext = `${JSON.stringify({ type: "session", id: sessionId })}\n${body.join("\n")}\n`;
      const stored = zstdCompressSync(Buffer.from(plaintext));
      // Stored size plus 1 MiB was #190690's refusal threshold.
      expect(Buffer.byteLength(plaintext)).toBeGreaterThan(stored.length + 1024 * 1024);
      fs.writeFileSync(archivePath, stored);
      const damaged = zstdCompressSync(Buffer.from("corrupt suffix"), {
        params: { [constants.ZSTD_c_checksumFlag]: 1 },
      });
      damaged[damaged.length - 1] = damaged.readUInt8(damaged.length - 1) ^ 1;
      const newerPath = archivePath.replace("T18-", "T19-");
      fs.writeFileSync(newerPath, Buffer.concat([stored, damaged]));

      await expect(
        new ArchivedTranscriptReader(scope).readRecentWithStats({ maxMessages: 1 }),
      ).resolves.toMatchObject({ messages: [{ content: latest }], transcriptPath: archivePath });
      await expect(
        new ArchivedTranscriptReader({ ...scope, exactArchivePath: archivePath }).readAroundId({
          messageId: "m-10",
          maxMessages: 1,
          maxBytes: 256 * 1024,
        }),
      ).resolves.toMatchObject({ found: true });
      expect(
        fs.existsSync(resolveSessionArchiveReadPath(archivePath, fs.statSync(archivePath))),
      ).toBe(false);
    },
  );

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
