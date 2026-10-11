import { renameSync } from "node:fs";
import { backup } from "node:sqlite";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
  withTranscriptWriteTransaction,
} from "./session-accessor.js";
import {
  readRecentSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventPage,
} from "./session-accessor.sqlite-history-events.js";
import {
  historyEventId,
  readSessionTranscriptHistoryEventCount,
  useHistoryEventScope,
} from "./session-accessor.sqlite-history.test-support.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEvents,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

describe("SQLite transcript history cache", () => {
  const fixtureScope = useHistoryEventScope();
  const limits = { maxMessages: 20, maxLines: 20, maxBytes: 64 * 1024 };
  const read = () => readRecentSessionTranscriptHistoryEvents(fixtureScope, limits);
  const readHeadPage = () =>
    readSessionTranscriptHistoryEventPage(fixtureScope, {
      offset: 0,
      maxMessages: limits.maxMessages,
      recentAtHead: limits,
    });

  async function seedRoot() {
    replaceSessionEntrySync(fixtureScope, {
      sessionId: fixtureScope.sessionId,
      updatedAt: Date.now(),
    });
    await persistSessionTranscriptTurn(fixtureScope, {
      messages: [transcriptMessage("root", null, { role: "user", content: "root" })],
      touchSessionEntry: false,
    });
  }

  it("reuses recent payloads with fresh result ownership until append or rewrite", async () => {
    const events = [
      { type: "session", version: 3, id: fixtureScope.sessionId },
      {
        type: "message",
        id: "original",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "cache-window-original" }],
        },
      },
      {
        type: "message",
        id: "initial",
        parentId: "original",
        message: { role: "assistant", content: "reply" },
      },
    ];
    await replaceTranscriptEvents(fixtureScope, events);
    const first = read();
    const parse = vi.spyOn(JSON, "parse");
    const second = read();
    expect(parse.mock.calls.filter(([json]) => json.includes("cache-window-original"))).toEqual([]);
    parse.mockRestore();
    for (const page of [first, second]) {
      const message = asOptionalRecord(page.events[0]?.event)?.message;
      if (!isRecord(message) || !Array.isArray(message.content) || !isRecord(message.content[0])) {
        throw new Error("expected the original message content");
      }
      message.content[0].text = "caller mutation";
      expect(asOptionalRecord(read().events[0]?.event)?.message).toEqual(events[1]?.message);
    }
    await persistSessionTranscriptTurn(fixtureScope, {
      messages: [transcriptMessage("appended", "initial", { role: "user", content: "next" })],
      touchSessionEntry: false,
    });
    expect(read().events.map(historyEventId)).toEqual(["original", "initial", "appended"]);
    const replacement = [
      ...events,
      {
        type: "message",
        id: "appended",
        parentId: "initial",
        message: { role: "user", content: "rewritten" },
      },
    ];
    await replaceTranscriptEvents(fixtureScope, replacement);
    expect(asOptionalRecord(read().events.at(-1)?.event)?.message).toEqual(
      replacement.at(-1)?.message,
    );
    expect(
      readRecentSessionTranscriptHistoryEvents(fixtureScope, {
        ...limits,
        maxMessages: 1,
      }).events.map(historyEventId, readSessionTranscriptHistoryEventCount),
    ).toEqual(["appended"]);
  });

  it.each(["rollback", "savepoint rollback"] as const)(
    "retains only committed recent windows after a nested writer %s",
    async (outcome) => {
      await seedRoot();
      expect(read().events.map(historyEventId)).toEqual(["root"]);
      const appendPending = () => {
        expect(
          appendTranscriptMessageSync(
            fixtureScope,
            transcriptMessage("pending", "root", { role: "user", content: "pending" }),
          ),
        ).toMatchObject({ ok: true, value: { appended: true } });
        const page = read();
        expect(page.events.map(historyEventId)).toEqual(["root", "pending"]);
        const message = asOptionalRecord(page.events.at(-1)?.event)?.message;
        if (!isRecord(message)) {
          throw new Error("expected pending message");
        }
        message.content = "caller mutation before commit";
        page.events.length = 0;
        throw new Error("rollback pending history");
      };
      const transaction = withTranscriptWriteTransaction(fixtureScope, () => {
        if (outcome !== "savepoint rollback") {
          appendPending();
          return;
        }
        expect(() =>
          runOpenClawAgentWriteTransaction(appendPending, {
            agentId: fixtureScope.agentId,
            env: fixtureScope.env,
          }),
        ).toThrow("rollback pending history");
        expect(
          appendTranscriptMessageSync(
            fixtureScope,
            transcriptMessage("committed", "root", { role: "user", content: "committed" }),
          ),
        ).toMatchObject({ ok: true, value: { appended: true } });
      });
      if (outcome === "rollback") {
        await expect(transaction).rejects.toThrow("rollback pending history");
        // Reuse the rolled-back physical sequence before any intervening history read.
        await persistSessionTranscriptTurn(fixtureScope, {
          messages: [
            transcriptMessage("committed", "root", { role: "user", content: "committed" }),
          ],
          touchSessionEntry: false,
        });
      } else {
        await transaction;
      }
      const page = read();
      expect(page.events.map(historyEventId)).toEqual(["root", "committed"]);
      expect(asOptionalRecord(page.events.at(-1)?.event)?.message).toMatchObject({
        content: "committed",
      });
    },
  );

  it("does not retain a rolled-back reset in uncached history pages", async () => {
    await seedRoot();
    const initial = readHeadPage();
    await expect(
      withTranscriptWriteTransaction(fixtureScope, () => {
        expect(
          appendTranscriptEventSync(fixtureScope, {
            type: "reset",
            id: "pending-reset",
            parentId: "root",
            reason: "new",
          }),
        ).toMatchObject({ ok: true, value: true });
        expect(readHeadPage().events.map(historyEventId)).toEqual(["pending-reset"]);
        throw new Error("rollback reset");
      }),
    ).rejects.toThrow("rollback reset");
    await appendTranscriptMessage(
      fixtureScope,
      transcriptMessage("committed", "root", { role: "user", content: "committed" }),
    );
    const page = readHeadPage();
    expect(page.displaySource).toBe(initial.displaySource);
    expect(page.totalMessages).toBe(2);
    expect(page.events.map(historyEventId)).toEqual(["root", "committed"]);
    expect(page.events.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("invalidates reset windows when a backup fork replaces the physical database", async () => {
    await seedRoot();
    const database = openOpenClawAgentDatabase({
      agentId: fixtureScope.agentId,
      env: fixtureScope.env,
    });
    const replacementPath = `${database.path}.replacement.sqlite`;
    await backup(database.db, replacementPath);
    await appendTranscriptEvent(fixtureScope, {
      type: "reset",
      id: "old-reset",
      parentId: "root",
      reason: "new",
    });
    await appendTranscriptMessage(
      { ...fixtureScope, storePath: replacementPath },
      transcriptMessage("replacement", "root", { role: "user", content: "replacement" }),
    );
    await closeOpenClawAgentDatabasesAsync(fixtureScope.env.OPENCLAW_STATE_DIR);
    const readerScope = new OpenClawAgentDatabaseReadOnlyScope();
    const target = { agentId: fixtureScope.agentId, path: database.path };
    const readOnly = () =>
      readerScope.run(target, () =>
        readRecentSessionTranscriptHistoryEvents(
          { ...fixtureScope, storePath: database.path },
          { ...limits, readOnly: true },
        ),
      );
    try {
      const original = readOnly();
      expect(original.events.map(historyEventId)).toEqual(["old-reset"]);
      // Close before renaming so the same replacement proof runs on Windows.
      readerScope.close();
      renameSync(database.path, `${database.path}.previous`);
      renameSync(replacementPath, database.path);
      const replaced = readOnly();
      expect(replaced.displaySource).toBe(original.displaySource);
      expect(replaced.deltaCursor).toBe(original.deltaCursor);
      expect(replaced.totalMessages).toBe(2);
      expect(replaced.events.map(historyEventId)).toEqual(["root", "replacement"]);
      expect(replaced.events.map((row) => row.seq)).toEqual([1, 2]);
    } finally {
      readerScope.close();
    }
  });

  function createScope(sessionId: string) {
    return { ...fixtureScope, sessionId, sessionKey: `agent:main:${sessionId}` };
  }

  it("rebases a retained anchor into the current reset window", async () => {
    const scope = createScope("kept-window");
    await replaceTranscriptEvents(
      scope,
      [1, 2, 3].map((seq) => ({
        type: "message",
        id: `row-${seq}`,
        parentId: seq === 1 ? null : `row-${seq - 1}`,
        message: { role: "user", content: `row ${seq}` },
      })),
    );
    const first = readSessionTranscriptHistoryEventPage(scope, {
      maxMessages: 1,
      offset: 0,
      captureReadWindow: true,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset",
      parentId: "row-3",
      firstKeptEntryId: "row-2",
      reason: "new",
    });
    const page = readSessionTranscriptHistoryEventPage(scope, {
      maxMessages: 1,
      offset: 0,
      beforeSeq: 3,
      expectedReadWindow: first.readWindow,
    });
    expect(page).toMatchObject({
      windowReset: true,
      events: [{ seq: 1, event: { id: "row-2" } }],
      readWindow: { anchor: { seq: 1 } },
    });
  });

  it("continues an ID-less history window across harmless appends", async () => {
    const scope = createScope("history-events-test");
    const originalEvents = [
      { message: { role: "user", content: "older legacy row" } },
      { message: { role: "assistant", content: "newer legacy row" } },
    ];
    await replaceTranscriptEvents(scope, originalEvents);
    const original = readSessionTranscriptHistoryEventPage(scope, { maxMessages: 2, offset: 0 });
    expect(original).not.toHaveProperty("readWindow");
    const captured = readSessionTranscriptHistoryEventPage(scope, {
      maxMessages: 1,
      offset: 0,
      captureReadWindow: true,
    });
    const readWindow = captured.readWindow;
    expect(readWindow).toEqual({
      source: original.displaySource,
      latestResetRawSeq: null,
      anchor: { rawSeq: 1, seq: 2 },
    });
    if (!readWindow) {
      throw new Error("missing captured transcript window");
    }

    await appendTranscriptEvent(scope, {
      message: { role: "assistant", content: "appended legacy row" },
    });
    const continued = readSessionTranscriptHistoryEventPage(scope, {
      beforeSeq: 3,
      offset: 0,
      maxMessages: 2,
      recentAtHead: { maxBytes: 64 * 1024, maxLines: 3, maxMessages: 3 },
      expectedReadWindow: readWindow,
    });
    expect(continued.events).toEqual(original.events);
    expect(continued.totalMessages).toBe(3);
    expect(continued).not.toHaveProperty("readWindow");
    expect(
      readSessionTranscriptHistoryEventPage(scope, {
        beforeSeq: 3,
        offset: 1,
        maxMessages: 1,
        expectedReadWindow: readWindow,
      }).events,
    ).toEqual(original.events.slice(0, 1));
  });

  it.each(["reset", "replacement"])("recovers a stale history window after %s", async (change) => {
    const scope = createScope("stale-window");
    await replaceTranscriptEvents(scope, [
      { type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
    ]);
    const previous = readSessionTranscriptHistoryEventPage(scope, {
      maxMessages: 1,
      offset: 0,
      captureReadWindow: true,
    });
    if (change === "reset") {
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: "reset",
        parentId: "old",
        reason: "new",
      });
      await appendTranscriptMessage(scope, {
        eventId: "current",
        message: { role: "user", content: "current" },
      });
    } else {
      await replaceTranscriptEvents(scope, [
        {
          type: "message",
          id: "current",
          parentId: null,
          message: { role: "user", content: "current" },
        },
      ]);
    }
    const page = readSessionTranscriptHistoryEventPage(scope, {
      maxMessages: 1,
      offset: 10,
      beforeSeq: 1,
      expectedReadWindow: previous.readWindow,
    });
    expect(page).toMatchObject({ windowReset: true, events: [{ event: { id: "current" } }] });
    expect(page.readWindow).toBeDefined();
    expect(page.readWindow).not.toEqual(previous.readWindow);
    expect(
      readSessionTranscriptHistoryEventPage(scope, {
        maxMessages: 1,
        offset: 0,
        expectedReadWindow: page.readWindow,
      }).events,
    ).toEqual(page.events);
  });

  it("keeps leading, interior, and trailing marker-gap ordinals across an append", async () => {
    const scope = createScope("marker-gap");
    const layout = [
      "notice",
      "message",
      "notice",
      "notice",
      "hidden",
      "message",
      "notice",
      "message",
      "notice",
      "notice",
    ];
    const expected = [
      "row-0",
      "row-1",
      "row-2",
      "row-3",
      "row-5",
      "row-6",
      "row-7",
      "row-8",
      "row-9",
    ];
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      ...layout.map((kind, index) => ({
        id: `row-${index}`,
        parentId: index === 0 ? null : `row-${index - 1}`,
        ...(kind === "message"
          ? { type: "message", message: { role: "user", content: `row ${index}` } }
          : {
              type: "custom_message",
              customType: "notice",
              display: kind !== "hidden",
              content: `row ${index}`,
            }),
      })),
    ]);
    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(expected.length);
    const sibling = { ...scope, sessionId: "sibling", sessionKey: "agent:main:sibling" };
    await replaceTranscriptEvents(sibling, [
      { type: "message", id: "seed", parentId: null, message: { role: "user", content: "seed" } },
      { type: "compaction", id: "summary", parentId: "seed", summary: "sibling summary" },
    ]);
    expect(readSessionTranscriptHistoryEventCount(sibling)).toBe(2);
    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(expected.length);
    for (const offset of [0, 2, 4, 6].filter((pageOffset) => pageOffset < expected.length)) {
      const page = readSessionTranscriptHistoryEventPage(scope, { maxMessages: 3, offset });
      const end = expected.length - offset;
      const start = Math.max(0, end - 3);
      expect(page.totalMessages).toBe(expected.length);
      expect(page.events.map(({ event }) => event)).toEqual(
        expected.slice(start, end).map((id) => expect.objectContaining({ id })),
      );
      expect(page.events.map(({ seq }) => seq)).toEqual(
        Array.from({ length: end - start }, (_, index) => start + index + 1),
      );
    }
    await appendTranscriptMessage(scope, {
      eventId: "new-tail",
      parentId: `row-${layout.length - 1}`,
      message: { role: "assistant", content: "fresh" },
    });
    const fresh = readSessionTranscriptHistoryEventPage(scope, { maxMessages: 3, offset: 0 });
    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(expected.length + 1);
    expect(readSessionTranscriptHistoryEventCount(sibling)).toBe(2);
    expect(fresh.totalMessages).toBe(expected.length + 1);
    expect(fresh.events.map(({ event }) => event)).toEqual(
      [...expected.slice(-2), "new-tail"].map((id) => expect.objectContaining({ id })),
    );
    expect(fresh.events.map(({ seq }) => seq)).toEqual([
      expected.length - 1,
      expected.length,
      expected.length + 1,
    ]);
  });
});
