import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { createTranscriptDisplaySource } from "../sessions/transcript-display-position.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPageKernel } from "./server-methods/chat-history-page-kernel.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";
import { visitSessionMessagesAsync } from "./session-transcript-native.test-support.js";
import type { SessionTranscriptPageReader } from "./session-transcript-read.types.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
  readSessionTranscriptAccountingAsync,
  readSessionMessagesAsync,
  readSessionMessagesAroundIdWithStatsAsync,
  readSessionMessagesPageWithStatsAsync,
  readSessionMessagesWithSourceAsync,
} from "./session-transcript-readers.js";
import * as transcriptReaders from "./session-transcript-readers.js";
import { readLatestSessionUsageFromTranscriptAsync } from "./session-transcript-usage.js";

describe("session transcript reader facade", () => {
  let tempDir: string;
  let storePath: string;
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-transcript-readers-",
      layout: "state-only",
    });
    setRuntimeConfigSnapshot({});
    tempDir = state.stateDir;
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    await state.cleanup();
    clearRuntimeConfigSnapshot();
  });

  async function writeTranscript(sessionId: string, events: unknown[]) {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await replaceTranscriptEvents(scope, events);
    return scope;
  }

  test("pages mixed-size earlier history contiguously through the SQL worker facade", async () => {
    // Mixed widths force byte trimming independently of the requested message count.
    const widths = [1, 3, 1, 3, 1, 3];
    const expected = widths.map((_, index) => "mixed-" + index);
    const scope = await writeTranscript("mixed-pages", [
      { type: "session", version: 3, id: "mixed-pages" },
      ...widths.map((width, index) => ({
        type: "message",
        id: expected[index],
        parentId: index ? expected[index - 1] : null,
        message: { role: "user", content: "x".repeat(width * 1024 * 1024) },
      })),
    ]);
    const read = (messageId: string, direction?: "older" | "newer") =>
      readSessionMessagesAroundIdWithStatsAsync(scope, { messageId, maxMessages: 6, direction });

    const observed: string[] = [expected.at(-1)!];
    let anchor = expected.at(-1)!;
    let remainingPages = expected.length;
    while (remainingPages-- > 0) {
      const page = await read(anchor, "older");
      const ids = page.messages.map((item) => readChatHistoryMessageId(item)!);
      expect(ids.at(-1)).toBe(anchor);
      const older = ids.slice(0, -1);
      if (older.length === 0) {
        expect(anchor).toBe(expected[0]);
        break;
      }
      const start = expected.indexOf(older[0]!);
      expect(ids).toEqual(expected.slice(start, expected.indexOf(anchor) + 1));
      expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThan(8 * 1024 * 1024);
      expect(page.hasOverreadContext).toBe(false);
      observed.unshift(...older);
      anchor = older[0]!;
    }
    expect(observed).toEqual(expected);
    const around = await read("mixed-2");
    expect(around.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ __openclaw: expect.objectContaining({ id: "mixed-2" }) }),
      ]),
    );
    const newer = await read("mixed-1", "newer");
    expect(newer.messages[0]).toMatchObject({ __openclaw: { id: "mixed-1" } });
    expect(newer.offset).toBe(
      expected.length - 1 - expected.indexOf(readChatHistoryMessageId(newer.messages.at(-1))!),
    );
  });

  test.each([false, true])(
    "chat kernel advances adjacent 5 MiB rows (closed=%s)",
    async (closed) => {
      const events = [
        { type: "session", version: 3, id: "kernel-adjacent" },
        {
          type: "message",
          id: "left",
          parentId: null,
          message: { role: "user", content: "x".repeat(5 * 1024 * 1024) },
        },
        {
          type: "message",
          id: "right",
          parentId: "left",
          message: { role: "user", content: "y".repeat(5 * 1024 * 1024) },
        },
        ...(closed
          ? [
              {
                type: "reset",
                id: "closing",
                parentId: "right",
                reason: "new",
                timestamp: "2026-10-11T00:00:01.000Z",
              },
              {
                type: "message",
                id: "current",
                parentId: "closing",
                message: { role: "user", content: "current" },
              },
            ]
          : []),
      ];
      const scope = await writeTranscript("kernel-adjacent", events);
      const read = async (
        messageId: string,
        direction?: "older" | "newer",
        source?: string,
        readers: SessionTranscriptPageReader = transcriptReaders,
      ) =>
        readChatHistoryPageKernel(
          {
            entry: undefined,
            provider: undefined,
            sessionId: scope.sessionId,
            storePath,
            sessionAgentId: "main",
            canonicalKey: scope.sessionKey,
            max: 1,
            maxHistoryBytes: 512 * 1024,
            effectiveMaxChars: 200,
            offset: undefined,
            messageId,
            ...(direction && source
              ? { pageCursor: { sessionId: scope.sessionId, source, messageId, direction } }
              : {}),
          },
          { readers, deferProfileDisplay: true },
        );
      const first = await read("right");
      expect(first.messages.map(readChatHistoryMessageId)).toEqual(["right"]);
      expect(first.anchor?.hasOlder).toBe(true);
      const source = first.anchor!.source;
      const older = await read("right", "older", source);
      expect(older.messages.map(readChatHistoryMessageId)).toEqual(["left"]);
      expect(older.anchor).toMatchObject({
        oldestMessageId: "left",
        newestMessageId: "left",
        hasOlder: false,
      });
      const newer = await read("left", "newer", source);
      expect(newer.messages.map(readChatHistoryMessageId)).toEqual(["right"]);
      expect(newer.anchor?.hasNewer).toBe(closed);
      if (closed) {
        const end = await read("right", "newer", source);
        expect(end.messages.map(readChatHistoryMessageId)).toEqual(["closing"]);
        expect(end.anchor?.hasNewer).toBe(false);
        const interval = await readSessionMessagesAroundIdWithStatsAsync(scope, {
          messageId: "closing",
          closedResetInterval: true,
          maxMessages: 4,
          direction: "older",
        });
        expect(interval.messages.map(readChatHistoryMessageId)).toEqual(["right"]);
        expect(interval).toMatchObject({ offset: 0, totalMessages: 2, hasOverreadContext: false });
      }
      const replacement = () =>
        writeTranscript(scope.sessionId, [
          events[0],
          {
            type: "message",
            id: "replacement",
            parentId: null,
            message: { role: "user", content: "new generation" },
          },
        ]);
      // Replace the physical selection between inclusive admission and continuation.
      // Both reads are real facade calls; no production test seam or fake result.
      let reads = 0;
      const readers: SessionTranscriptPageReader = {
        ...transcriptReaders,
        async readSessionMessagesAroundIdWithStatsAsync(target, options, signal) {
          if (++reads === 2) {
            await replacement();
          }
          return transcriptReaders.readSessionMessagesAroundIdWithStatsAsync(
            target,
            options,
            signal,
          );
        },
      };
      expect(await read("right", "older", source, readers)).toMatchObject({
        messages: [],
        windowReset: true,
      });
      expect(reads).toBe(2);
      expect(await read("right", "older", source)).toMatchObject({
        messages: [],
        windowReset: true,
      });
    },
  );

  test("final positioned SQL cap retains the anchor and reports its actual interval", async () => {
    const rows = ["first", "anchor", "last"].map((id, index, ids) => ({
      type: "message",
      id,
      parentId: index ? ids[index - 1] : null,
      message: { role: "user", content: "x".repeat(700) },
    }));
    const scope = await writeTranscript("positioned-cap", [
      { type: "session", version: 3, id: "positioned-cap" },
      ...rows,
    ]);
    // Both stored payloads fit, but positioned rows cross this exact budget.
    const maxBytes = Buffer.byteLength(JSON.stringify(rows.slice(0, 2))) + 2;
    const around = await readSessionMessagesAroundIdWithStatsAsync(scope, {
      messageId: "anchor",
      maxMessages: 1,
      maxBytes,
    });
    expect(around.messages.map(readChatHistoryMessageId)).toEqual(["anchor"]);
    expect(around).toMatchObject({ offset: 1, hasOverreadContext: false });
    const newer = await readSessionMessagesAroundIdWithStatsAsync(scope, {
      messageId: "first",
      direction: "newer",
      maxMessages: 2,
      maxBytes,
    });
    expect(newer.messages.map(readChatHistoryMessageId)).toEqual(["first"]);
    expect(newer).toMatchObject({ offset: 2, hasOverreadContext: false });
    for (const page of [around, newer]) {
      expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(maxBytes);
    }
    const small = await readSessionMessagesAroundIdWithStatsAsync(scope, {
      messageId: "anchor",
      maxMessages: 1,
      maxBytes: 1024,
    });
    const reset = await readSessionMessagesAroundIdWithStatsAsync(scope, {
      messageId: "anchor",
      maxMessages: 1,
      maxBytes,
      expectedReadWindow: { source: "stale", latestResetRawSeq: null },
    });
    expect(reset).toMatchObject({ windowReset: true, hasOverreadContext: false, offset: 1 });
    expect(reset.readWindow?.anchor?.seq).toBe(2);
    expect(reset.messages.map(readChatHistoryMessageId)).toEqual(["anchor"]);
    expect(small.messages.map(readChatHistoryMessageId)).toEqual(["anchor"]);
    expect(small).toMatchObject({ offset: 1, hasOverreadContext: false });
  });

  test("chat kernel continues after the default positioned SQL cap trims a raw-fitting page", async () => {
    const cap = 8 * 1024 * 1024;
    const rows = ["first", "second"].map((id, index) => ({
      type: "message",
      id,
      parentId: index ? "first" : null,
      message: { role: "user", content: "" },
    }));
    // Leave less room than the positioned row envelopes require, but admit
    // both raw records. This reaches the real final cap without a test budget.
    const payloadBytes = cap - Buffer.byteLength(JSON.stringify(rows)) - 16;
    rows[0]!.message.content = "x".repeat(Math.floor(payloadBytes / 2));
    rows[1]!.message.content = "y".repeat(payloadBytes - rows[0]!.message.content.length);
    const scope = await writeTranscript("kernel-positioned-cap", [
      { type: "session", version: 3, id: "kernel-positioned-cap" },
      ...rows,
    ]);
    const readers: SessionTranscriptPageReader = {
      ...transcriptReaders,
      async readSessionMessagesAroundIdWithStatsAsync(target, options, signal) {
        const page = await transcriptReaders.readSessionMessagesAroundIdWithStatsAsync(
          target,
          options,
          signal,
        );
        expect(Buffer.byteLength(JSON.stringify(page.messages))).toBeLessThanOrEqual(cap);
        return page;
      },
    };
    const read = (messageId: string, source?: string) =>
      readChatHistoryPageKernel(
        {
          entry: undefined,
          provider: undefined,
          sessionId: scope.sessionId,
          storePath,
          sessionAgentId: "main",
          canonicalKey: scope.sessionKey,
          max: 1,
          maxHistoryBytes: 512 * 1024,
          effectiveMaxChars: 200,
          offset: undefined,
          messageId,
          ...(source
            ? {
                pageCursor: {
                  sessionId: scope.sessionId,
                  source,
                  messageId,
                  direction: "newer" as const,
                },
              }
            : {}),
        },
        { readers, deferProfileDisplay: true },
      );
    const first = await read("first");
    expect(first.messages.map(readChatHistoryMessageId)).toEqual(["first"]);
    expect(first.anchor).toMatchObject({ hasOlder: false, hasNewer: true });
    const second = await read("first", first.anchor!.source);
    expect(second.messages.map(readChatHistoryMessageId)).toEqual(["second"]);
    expect(second.anchor).toMatchObject({ hasOlder: true, hasNewer: false });
  });

  test("chat kernel walks mixed widths without duplicate or omitted source rows", async () => {
    const widths = [1, 3, 1, 3, 1, 3];
    const expected = widths.map((_, index) => "walk-" + index);
    const scope = await writeTranscript("kernel-mixed", [
      { type: "session", version: 3, id: "kernel-mixed" },
      ...widths.map((width, index) => ({
        type: "message",
        id: expected[index],
        parentId: index ? expected[index - 1] : null,
        message: { role: "user", content: "x".repeat(width * 1024 * 1024) },
      })),
    ]);
    const initial = await readSessionMessagesAroundIdWithStatsAsync(scope, {
      messageId: expected[5]!,
      maxMessages: 1,
    });
    const source = createTranscriptDisplaySource([initial.displaySource!]);
    const seen = [expected[5]!];
    let anchor = expected[5]!;
    let remainingPages = expected.length;
    while (remainingPages-- > 0) {
      const page = await readChatHistoryPageKernel(
        {
          entry: undefined,
          provider: undefined,
          sessionId: scope.sessionId,
          storePath,
          sessionAgentId: "main",
          canonicalKey: scope.sessionKey,
          max: 2,
          maxHistoryBytes: 512 * 1024,
          effectiveMaxChars: 200,
          offset: undefined,
          messageId: anchor,
          pageCursor: { sessionId: scope.sessionId, source, messageId: anchor, direction: "older" },
        },
        { readers: transcriptReaders, deferProfileDisplay: true },
      );
      const ids = page.messages.map(readChatHistoryMessageId);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.some((id) => seen.includes(id!))).toBe(false);
      seen.unshift(...ids.map((id) => id!));
      anchor = page.anchor!.oldestMessageId!;
      if (!page.anchor!.hasOlder) {
        break;
      }
    }
    expect(seen).toEqual(expected);
  });

  function markProjectionNeedsRebuild(sessionId: string): void {
    openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    })
      .db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      )
      .run(sessionId);
  }

  test("prepares byte, usage and taint facts without host transcript SQL", async () => {
    const events = [
      { type: "session", id: "accounting", version: 3 },
      {
        type: "message",
        id: "user",
        parentId: null,
        message: { role: "user", content: "question" },
      },
      {
        type: "message",
        id: "answer",
        parentId: "user",
        message: {
          role: "assistant",
          content: "answer",
          usage: { input: 200, output: 7 },
          __openclaw: { turnTainted: true },
        },
      },
    ];
    const scope = await writeTranscript("accounting", events);
    const options = { includeByteSize: true, includeUsage: true, includeTurnTaint: true };
    await readSessionTranscriptAccountingAsync(scope, options);
    const hostSql = observeHostDataSql();
    const result = await readSessionTranscriptAccountingAsync(scope, options).finally(() =>
      hostSql.restore(),
    );
    expect(hostSql.queries).toEqual([]);
    expect(result).toEqual({
      byteSize: events
        .slice(1)
        .reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)) + 1, 0),
      eventCount: 2,
      turnTainted: true,
      usage: { promptTokens: 200, outputTokens: 7, trailingMessages: [] },
    });
  });

  test("reads active-branch messages and message ids through a scope", async () => {
    const scope = await writeTranscript("reader-active-branch", [
      { type: "session", version: 3, id: "reader-active-branch" },
      {
        type: "message",
        id: "root",
        parentId: null,
        message: { role: "user", content: "root prompt" },
      },
      {
        type: "message",
        id: "inactive",
        parentId: "root",
        message: { role: "assistant", content: "stale answer" },
      },
      {
        type: "message",
        id: "active",
        parentId: "root",
        message: { role: "assistant", content: "active answer" },
      },
    ]);

    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "facade active branch test" }),
    ).resolves.toMatchObject([
      { content: "root prompt", __openclaw: { id: "root", seq: 1 } },
      { content: "active answer", __openclaw: { id: "active", seq: 2 } },
    ]);
    const visited: Array<{ message: unknown; seq: number }> = [];
    await expect(
      visitSessionMessagesAsync(scope, (message, seq) => visited.push({ message, seq })),
    ).resolves.toBe(2);
    expect(visited).toEqual([
      { message: { role: "user", content: "root prompt" }, seq: 1 },
      { message: { role: "assistant", content: "active answer" }, seq: 2 },
    ]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(2);
    await expect(readSessionMessageByIdAsync(scope, "active")).resolves.toMatchObject({
      found: true,
      oversized: false,
      seq: 2,
    });
    await expect(
      readSessionMessagesAroundIdWithStatsAsync(scope, {
        messageId: "active",
        maxMessages: 1,
      }),
    ).resolves.toMatchObject({
      found: true,
      hasOverreadContext: true,
      messages: [{ content: "root prompt" }, { content: "active answer" }],
      offset: 0,
      totalMessages: 2,
    });
  });

  test("bounds source pages and freezes their sequence across appends", async () => {
    const sessionId = "reader-source-pages";
    const scope = await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      ...Array.from({ length: 260 }, (_, index) => ({
        type: "message",
        id: `message-${index}`,
        parentId: index === 0 ? null : `message-${index - 1}`,
        message: { role: "user", content: `prompt ${index}` },
      })),
    ]);
    let page = await readSessionMessagesWithSourceAsync(scope, { mode: "page" });
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
    expect(await readSessionMessageCountAsync(scope)).toBe(261);
    while (page.nextCursor) {
      page = await readSessionMessagesWithSourceAsync(scope, {
        mode: "page",
        cursor: page.nextCursor,
      });
      expect(page.messages.length).toBeLessThanOrEqual(128);
      expect(page.snapshot).toEqual(snapshot);
      messages.push(...page.messages);
    }
    expect(
      messages.map((message) => (message as { __openclaw: { id: string } })["__openclaw"].id),
    ).toEqual(Array.from({ length: 260 }, (_, index) => `message-${index}`));

    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: sessionId },
      {
        type: "message",
        id: "replacement",
        parentId: null,
        message: { role: "user", content: "new transcript" },
      },
    ]);
    await expect(
      readSessionMessagesWithSourceAsync(scope, { mode: "page", cursor: firstCursor }),
    ).rejects.toMatchObject({
      name: "SessionTranscriptProjectionUnavailableError",
      reason: "window-changed",
    });
  });

  test("bounds source pages by bytes and rejects a message larger than one page", async () => {
    const sessionId = "reader-source-page-bytes";
    const content = "a".repeat(3 * 1024 * 1024);
    const scope = await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      ...Array.from({ length: 3 }, (_, index) => ({
        type: "message",
        id: `large-${index}`,
        parentId: index === 0 ? null : `large-${index - 1}`,
        message: { role: "user", content },
      })),
    ]);
    expect(await readSessionMessageCountAsync(scope)).toBe(3);
    const first = await readSessionMessagesWithSourceAsync(scope, { mode: "page" });
    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const last = await readSessionMessagesWithSourceAsync(scope, {
      mode: "page",
      cursor: first.nextCursor,
    });
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
      {
        type: "message",
        id: "oversized",
        parentId: null,
        message: { role: "user", content: "b".repeat(8 * 1024 * 1024) },
      },
    ]);
    expect(await readSessionMessageCountAsync(scope)).toBe(1);
    await expect(readSessionMessagesWithSourceAsync(scope, { mode: "page" })).rejects.toThrow(
      "Transcript source message exceeds the 8388608-byte page limit",
    );
    await expect(
      readSessionMessagesPageWithStatsAsync(scope, { offset: 0, maxMessages: 1 }),
    ).rejects.toThrow("Transcript history message exceeds the 8388608-byte page limit");
    await expect(
      readRecentSessionMessagesWithStatsAsync(scope, { maxMessages: 1 }),
    ).rejects.toThrow("Transcript history message exceeds the 8388608-byte page limit");
    await expect(
      readSessionMessagesAroundIdWithStatsAsync(scope, { messageId: "oversized", maxMessages: 1 }),
    ).rejects.toThrow("Transcript history message exceeds the 8388608-byte page limit");
    openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    })
      .db.prepare("DELETE FROM transcript_event_identities WHERE session_id = ?")
      .run(sessionId);
    await expect(readSessionMessageByIdAsync(scope, "oversized")).resolves.toMatchObject({
      found: true,
    });
    await expect(
      readSessionMessagesAroundIdWithStatsAsync(scope, { messageId: "oversized", maxMessages: 1 }),
    ).rejects.toThrow("Transcript history message exceeds the 8388608-byte page limit");
  });

  test("bounds anchor windows before decoding excluded payloads", async () => {
    const sessionId = "reader-anchor-page-bytes";
    const scope = await writeTranscript(sessionId, [
      { type: "session", version: 3, id: sessionId },
      ...Array.from({ length: 3 }, (_, index) => ({
        type: "message",
        id: `large-${index}`,
        parentId: index === 0 ? null : `large-${index - 1}`,
        message: { role: "user", content: "a".repeat(3 * 1024 * 1024) },
      })),
    ]);
    const bounded = await readSessionMessagesAroundIdWithStatsAsync(scope, {
      messageId: "large-1",
      maxMessages: 3,
    });
    expect(bounded.messages).toMatchObject([
      { __openclaw: { id: "large-0" } },
      { __openclaw: { id: "large-1" } },
    ]);
    expect(bounded.offset).toBe(1);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: path.join(tempDir, "openclaw-agent.sqlite"),
    });
    // Preserve recorded sizes while poisoning excluded payloads: a late cap would parse this.
    database.db
      .prepare(
        "UPDATE transcript_events SET event_json = '{malformed', event_zstd = NULL WHERE session_id = ? AND seq = 1",
      )
      .run(sessionId);
    const page = await readSessionMessagesAroundIdWithStatsAsync(scope, {
      messageId: "large-1",
      maxMessages: 3,
      maxBytes: 4 * 1024 * 1024,
    });
    expect(page.messages).toMatchObject([{ __openclaw: { id: "large-1" } }]);
    expect(page.hasOverreadContext).toBe(false);
  });

  test.each(["visitor"] as const)(
    "acquires messages incrementally and releases the cursor after %s failure",
    async (failure) => {
      const sessionId = `reader-stream-${failure}`;
      const scope = await writeTranscript(sessionId, [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "first",
          parentId: null,
          message: { role: "user", content: "first prompt" },
        },
        {
          type: "message",
          id: "later",
          parentId: "first",
          message: { role: "assistant", content: "later answer" },
        },
      ]);
      const database = openOpenClawAgentDatabase({
        agentId: "main",
        path: path.join(tempDir, "openclaw-agent.sqlite"),
      });
      // Keep the ready projection, but poison a later payload: an early abort must never parse it.
      database.db
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
        expect(database.db.isTransaction).toBe(true);
        visited.push({ message, seq });
        if (failure === "visitor") {
          throw stopped;
        }
      });
      if (failure === "visitor") {
        await expect(traversal).rejects.toBe(stopped);
      } else {
        await expect(traversal).rejects.toBeInstanceOf(SyntaxError);
      }
      expect(visited).toEqual([{ message: { role: "user", content: "first prompt" }, seq: 1 }]);
      expect(database.db.isTransaction).toBe(false);
      // A surviving read cursor prevents checkpointing even after transaction rollback.
      expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
        busy: 0,
      });
    },
  );

  test("preserves Date.parse semantics for numeric-looking record timestamps", async () => {
    const scope = await writeTranscript("reader-numeric-looking-timestamps", [
      { type: "session", version: 3, id: "reader-numeric-looking-timestamps" },
      {
        type: "message",
        id: "numeric-zero",
        parentId: null,
        timestamp: "0",
        message: { role: "user", content: "zero" },
      },
      {
        type: "message",
        id: "numeric-year",
        parentId: "numeric-zero",
        timestamp: "2026",
        message: { role: "assistant", content: "year" },
      },
    ]);

    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "timestamp contract test" }),
    ).resolves.toMatchObject([
      { __openclaw: { recordTimestampMs: Date.parse("0") } },
      { __openclaw: { recordTimestampMs: Date.parse("2026") } },
    ]);
  });

  test("keeps SQLite precedence by ignoring an obsolete active JSONL during archive fallback", async () => {
    const sessionId = "reader-reset-archive-only";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    const line = (content: string) =>
      `${JSON.stringify({ type: "session", version: 1, id: sessionId })}\n${JSON.stringify({
        message: { role: "assistant", content },
      })}\n`;
    fs.writeFileSync(path.join(tempDir, `${sessionId}.jsonl`), line("obsolete live file"));
    fs.writeFileSync(
      path.join(tempDir, `${sessionId}.jsonl.reset.2026-07-12T18-00-00.000Z`),
      line("retained archive"),
    );

    for (const allowResetArchiveFallback of [false, undefined]) {
      await expect(
        readSessionMessagesPageWithStatsAsync(scope, {
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
      readSessionMessagesAsync(scope, {
        mode: "full",
        reason: "archive-only fallback test",
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject([{ content: "retained archive" }]);
    await expect(
      readRecentSessionMessagesWithStatsAsync(scope, {
        maxMessages: 1,
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject({ messages: [{ content: "retained archive" }] });
    await expect(
      readSessionMessagesPageWithStatsAsync(scope, {
        offset: 0,
        maxMessages: 1,
        allowResetArchiveFallback: true,
      }),
    ).resolves.toMatchObject({ messages: [{ content: "retained archive" }] });
  });

  test("reads SQLite-only transcript rows without a JSONL mirror", async () => {
    const sessionId = "reader-sqlite-only";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      cwd: tempDir,
      messages: [
        { message: { role: "user", content: "sqlite prompt" } },
        { message: { role: "assistant", content: "sqlite answer" } },
        { message: { role: "assistant", content: "sqlite follow-up" } },
      ],
      touchSessionEntry: false,
    });

    expect(fs.existsSync(path.join(tempDir, `${sessionId}.jsonl`))).toBe(false);
    await expect(
      readSessionMessagesAsync(scope, { mode: "full", reason: "sqlite reader facade test" }),
    ).resolves.toMatchObject([
      { content: "sqlite prompt" },
      { content: "sqlite answer" },
      { content: "sqlite follow-up" },
    ]);
    await expect(
      readSessionMessagesAsync(scope, { mode: "recent", maxMessages: 1 }),
    ).resolves.toMatchObject([{ content: "sqlite follow-up", __openclaw: { seq: 3 } }]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(3);
  });

  test("uses an explicit JSONL artifact when the store path is a placeholder", async () => {
    const sessionId = "reader-artifact-placeholder-store";
    const transcriptPath = path.join(tempDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "session", version: 1, id: sessionId })}\n${JSON.stringify({
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: { input: 12, output: 3, cost: { total: 0.001 } },
        },
      })}\n`,
      "utf-8",
    );

    await expect(
      readLatestSessionUsageFromTranscriptAsync({
        agentId: "main",
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        sessionFile: transcriptPath,
        storePath: "(multiple)",
      }),
    ).resolves.toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
    });
  });

  test("keeps a canonical session key on SQLite when the store path is a placeholder", async () => {
    const sessionId = "reader-placeholder-sqlite-key";
    const sessionKey = `agent:main:${sessionId}`;
    const defaultStorePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionId, sessionKey, storePath: defaultStorePath },
      {
        messages: [
          {
            message: {
              role: "assistant",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              usage: { input: 15, output: 4, cost: { total: 0.001 } },
            },
          },
        ],
        updateMode: "file-only",
      },
    );

    await expect(
      readLatestSessionUsageFromTranscriptAsync({
        sessionId,
        sessionKey,
        sessionFile: sessionKey,
        storePath: "(multiple)",
      }),
    ).resolves.toMatchObject({
      inputTokens: 15,
      outputTokens: 4,
    });
  });

  test("promotes SQLite message idempotency into transcript metadata", async () => {
    const sessionId = "reader-sqlite-idempotency";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "sqlite-user-message",
          message: {
            role: "user",
            content: "stable bubble",
            idempotencyKey: "initial-send:user",
          },
        },
      ],
      touchSessionEntry: false,
    });

    await expect(
      readSessionMessagesAsync(scope, {
        mode: "full",
        reason: "sqlite idempotency metadata parity test",
      }),
    ).resolves.toMatchObject([
      {
        idempotencyKey: "initial-send:user",
        __openclaw: {
          id: "sqlite-user-message",
          idempotencyKey: "initial-send:user",
          seq: 1,
        },
      },
    ]);
  });

  test("waits for an in-flight SQLite projection before counting messages", async () => {
    const sessionId = "reader-sqlite-rebuilding-count";
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "root",
          parentId: null,
          message: { role: "user", content: "cross-client prompt" },
        },
        {
          eventId: "reply",
          parentId: "root",
          message: { role: "assistant", content: "cross-client reply" },
        },
      ],
      touchSessionEntry: false,
    });
    markProjectionNeedsRebuild(sessionId);

    const visited: unknown[] = [];
    await expect(
      visitSessionMessagesAsync(scope, (message) => visited.push(message)),
    ).rejects.toBeInstanceOf(SessionTranscriptProjectionUnavailableError);
    expect(visited).toEqual([]);
    await expect(readSessionMessageCountAsync(scope)).resolves.toBe(2);
  });
});
