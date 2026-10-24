import { channel } from "node:diagnostics_channel";
import { renameSync } from "node:fs";
import { backup } from "node:sqlite";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadonlySessionHistoryReader } from "../../gateway/session-history-readonly-reader.js";
import { disposeNodeSqliteDependents } from "../../infra/kysely-sync-cache-state.js";
import { OpenClawAgentDatabaseReadOnlyScope } from "../../state/openclaw-agent-db-readonly-scope.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { readSessionTranscriptHistoryEventPage } from "./session-accessor.sqlite-history-events.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.test-support.js";
import {
  historyEventId,
  historyMessage,
  readSessionTranscriptHistoryEventById,
  readSessionTranscriptHistoryEventCount,
  useHistoryEventScope,
} from "./session-accessor.sqlite-history.test-support.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { rewriteTranscriptEventRowsExact } from "./session-accessor.sqlite-transcript-write.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEvents,
} from "./session-accessor.sqlite-transcript-write.test-support.js";

afterAll(clearRuntimeConfigSnapshot);

function turn(id: string, parentId: string | null = "root", content = id) {
  return { eventId: id, parentId, message: { role: "user", content } };
}

function resetEvent(id: string, parentId: string, firstKeptEntryId?: string) {
  return {
    type: "reset",
    id,
    parentId,
    reason: "new",
    ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
  };
}

function expectHistory(
  page: ReturnType<typeof historyPage>,
  ids: string[],
  seqs: number[],
  fields: Record<string, unknown>,
) {
  expect(page).toMatchObject({
    ...fields,
    events: ids.map((id, index) => ({ event: { id }, seq: seqs[index] })),
  });
}

function historyPage(
  scope: Parameters<typeof readSessionTranscriptHistoryEventPage>[0],
  options: Partial<Parameters<typeof readSessionTranscriptHistoryEventPage>[1]> = {},
) {
  return readSessionTranscriptHistoryEventPage(scope, { maxMessages: 1, offset: 0, ...options });
}

describe("SQLite transcript history cache", () => {
  const fixtureScope = useHistoryEventScope();
  beforeEach(() => setRuntimeConfigSnapshot({}));
  const limits = { maxMessages: 20, maxLines: 20, maxBytes: 64 * 1024 };
  const read = () => readRecentSessionTranscriptHistoryEvents(fixtureScope, limits);
  const persist = (...messages: ReturnType<typeof turn>[]) =>
    persistSessionTranscriptTurn(fixtureScope, { messages, touchSessionEntry: false });
  const transact = <T>(run: () => T) => runOpenClawAgentWriteTransaction(run, fixtureScope);
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
    await persist(turn("root", null));
  }

  it("keeps worker history cursors scoped to the logical agent on a shared store", async () => {
    await seedRoot();
    const database = openOpenClawAgentDatabase(fixtureScope);
    const target = { agentId: database.agentId, path: database.path };
    const createReader = (agentId: string) =>
      createReadonlySessionHistoryReader({
        database: target,
        transcript: {
          ...fixtureScope,
          agentId,
          sessionFile: fixtureScope.sessionKey,
          storePath: database.path,
        },
      });
    const firstReader = createReader("main");
    const secondReader = createReader("other");
    const owner = new OpenClawAgentDatabaseReadOnlyScope();
    const options = { maxMessages: 1, offset: 0, captureReadWindow: true };
    try {
      owner.run(target, () => {
        const first = firstReader.readHistoryEventPage(options);
        expect(first.readWindow?.source).toBeTypeOf("string");
        const second = secondReader.readHistoryEventPage({
          ...options,
          expectedReadWindow: first.readWindow,
        });
        expect(second.windowReset).toBe(true);
        expect(second.displaySource).not.toBe(first.displaySource);
        expect(second.events.map(historyEventId)).toEqual(["root"]);
        const returned = firstReader.readHistoryEventPage({
          ...options,
          expectedReadWindow: first.readWindow,
        });
        expect(returned).not.toHaveProperty("windowReset");
        expect(returned.readWindow).toEqual(first.readWindow);
        expect(returned.events).toEqual(first.events);
      });
    } finally {
      owner.close();
    }
  });

  it("reuses recent payloads with fresh result ownership until append or rewrite", async () => {
    const original = historyMessage("original", null, [
      { type: "text", text: "cache-window-original" },
    ]);
    const events = [
      { type: "session", version: 3, id: fixtureScope.sessionId },
      original,
      historyMessage("initial", "original", "reply", "assistant"),
    ];
    await replaceTranscriptEvents(fixtureScope, events);
    const first = read();
    const parse = vi.spyOn(JSON, "parse");
    const second = read();
    expect(parse.mock.calls.filter(([json]) => json.includes("cache-window-original"))).toEqual([]);
    channel("openclaw.memory.critical").publish(undefined);
    expect(read()).toEqual(first);
    expect(
      parse.mock.calls.filter(([json]) => json.includes("cache-window-original")),
    ).toHaveLength(1);
    parse.mockClear();
    expect(read()).toEqual(first);
    expect(parse.mock.calls.filter(([json]) => json.includes("cache-window-original"))).toEqual([]);
    parse.mockRestore();
    for (const page of [first, second]) {
      const message = asOptionalRecord(page.events[0]?.event)?.message;
      if (!isRecord(message) || !Array.isArray(message.content) || !isRecord(message.content[0])) {
        throw new Error("expected the original message content");
      }
      message.content[0].text = "caller mutation";
      expect(asOptionalRecord(read().events[0]?.event)?.message).toEqual(original.message);
    }
    await persist(turn("appended", "initial", "next"));
    expect(read().events.map(historyEventId)).toEqual(["original", "initial", "appended"]);
    const rewritten = historyMessage("appended", "initial", "rewritten");
    const replacement = [...events, rewritten];
    await replaceTranscriptEvents(fixtureScope, replacement);
    expect(asOptionalRecord(read().events.at(-1)?.event)?.message).toEqual(rewritten.message);
    expect(
      readRecentSessionTranscriptHistoryEvents(fixtureScope, {
        ...limits,
        maxMessages: 1,
      }).events.map(historyEventId, readSessionTranscriptHistoryEventCount),
    ).toEqual(["appended"]);
  });

  it.each(["close", "replace"] as const)(
    "retires only the disposed database's recent payloads on %s",
    async (reason) => {
      const other = { ...fixtureScope, agentId: "other", sessionKey: "agent:other:history" };
      const marker = "dispose-history-payload";
      for (const scope of [fixtureScope, other]) {
        await replaceTranscriptEvents(scope, [historyMessage("root", null, marker)]);
        readRecentSessionTranscriptHistoryEvents(scope, limits);
      }
      const database = openOpenClawAgentDatabase(fixtureScope);
      // The database closer retires its dependents before native close; replacement uses it too.
      disposeNodeSqliteDependents(requireNativeSqliteDatabase(database.db), reason);
      const parse = vi.spyOn(JSON, "parse");
      const payloadReads = () => parse.mock.calls.filter(([json]) => json.includes(marker));
      expect(readRecentSessionTranscriptHistoryEvents(other, limits).events).toHaveLength(1);
      expect(payloadReads()).toHaveLength(0);
      expect(read().events).toHaveLength(1);
      expect(payloadReads()).toHaveLength(1);
      parse.mockClear();
      expect(read().events).toHaveLength(1);
      expect(payloadReads()).toHaveLength(0);
    },
  );

  it("refreshes metadata-only rewrites without changing history positions or ignoring byte caps", async () => {
    const event = historyMessage("question", null, "question");
    await replaceTranscriptEvents(fixtureScope, [event]);
    expect(read().events).toMatchObject([{ seq: 1, event }]);
    const database = openOpenClawAgentDatabase(fixtureScope);
    const generation = readTranscriptGenerationInTransaction(database, fixtureScope.sessionId)!;
    const changed = {
      ...event,
      message: { ...event.message, __openclaw: { steerTargetRunId: "new-running-turn" } },
    };
    expect(
      await rewriteTranscriptEventRowsExact(fixtureScope, {
        expectedGeneration: generation,
        rows: [{ seq: 0, event: changed, expectedEventJson: JSON.stringify(event) }],
      }),
    ).toEqual({ generation });
    expect(read().events).toMatchObject([{ seq: 1, event: changed }]);
    expect(
      readSessionTranscriptHistoryEventById(fixtureScope, event.id, {
        currentOnly: true,
        maxBytes: Buffer.byteLength(JSON.stringify(event)) + 1,
      }),
    ).toBeUndefined();
  });

  it.each(["rollback", "savepoint rollback"] as const)(
    "retains only committed recent windows after a nested writer %s",
    async (outcome) => {
      await seedRoot();
      expect(read().events.map(historyEventId)).toEqual(["root"]);
      const appendPending = () => {
        expect(appendTranscriptMessageSync(fixtureScope, turn("pending", "root"))).toMatchObject({
          ok: true,
          value: { appended: true },
        });
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
      const transaction = () =>
        transact(() => {
          if (outcome !== "savepoint rollback") {
            appendPending();
            return;
          }
          expect(() => transact(appendPending)).toThrow("rollback pending history");
          expect(
            appendTranscriptMessageSync(fixtureScope, turn("committed", "root")),
          ).toMatchObject({ ok: true, value: { appended: true } });
        });
      if (outcome === "rollback") {
        expect(transaction).toThrow("rollback pending history");
        // Reuse the rolled-back physical sequence before any intervening history read.
        await persist(turn("committed"));
      } else {
        transaction();
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
    expect(() =>
      transact(() => {
        expect(
          appendTranscriptEventSync(fixtureScope, resetEvent("pending-reset", "root")),
        ).toMatchObject({ ok: true, value: true });
        expect(readHeadPage().events.map(historyEventId)).toEqual(["pending-reset"]);
        throw new Error("rollback reset");
      }),
    ).toThrow("rollback reset");
    await appendTranscriptMessage(fixtureScope, turn("committed", "root"));
    const page = readHeadPage();
    expectHistory(page, ["root", "committed"], [1, 2], {
      displaySource: initial.displaySource,
      totalMessages: 2,
    });
  });

  it("invalidates reset windows when a backup fork replaces the physical database", async () => {
    await seedRoot();
    const database = openOpenClawAgentDatabase(fixtureScope);
    const replacementPath = `${database.path}.replacement.sqlite`;
    await backup(requireNativeSqliteDatabase(database.db), replacementPath);
    await appendTranscriptEvent(fixtureScope, resetEvent("old-reset", "root"));
    await appendTranscriptMessage(
      { ...fixtureScope, storePath: replacementPath },
      turn("replacement", "root"),
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
      expectHistory(replaced, ["root", "replacement"], [1, 2], {
        displaySource: original.displaySource,
        deltaCursor: original.deltaCursor,
        totalMessages: 2,
      });
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
    const first = historyPage(scope, { captureReadWindow: true });
    await appendTranscriptEvent(scope, resetEvent("reset", "row-3", "row-2"));
    const page = historyPage(scope, {
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
    const original = historyPage(scope, { maxMessages: 2 });
    expect(original).not.toHaveProperty("readWindow");
    const captured = historyPage(scope, { captureReadWindow: true });
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
    await replaceTranscriptEvents(scope, [historyMessage("old", null, "old")]);
    const previous = historyPage(scope, { captureReadWindow: true });
    if (change === "reset") {
      await appendTranscriptEvent(scope, resetEvent("reset", "old"));
      await appendTranscriptMessage(scope, {
        eventId: "current",
        message: { role: "user", content: "current" },
      });
    } else {
      await replaceTranscriptEvents(scope, [historyMessage("current", null, "current")]);
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
      historyPage(scope, {
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
    const expected = [0, 1, 2, 3, 5, 6, 7, 8, 9].map((index) => `row-${index}`);
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
      historyMessage("seed", null, "seed"),
      { type: "compaction", id: "summary", parentId: "seed", summary: "sibling summary" },
    ]);
    expect(readSessionTranscriptHistoryEventCount(sibling)).toBe(2);
    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(expected.length);
    for (const offset of [0, 2, 4, 6].filter((pageOffset) => pageOffset < expected.length)) {
      const page = readSessionTranscriptHistoryEventPage(scope, { maxMessages: 3, offset });
      const end = expected.length - offset;
      const start = Math.max(0, end - 3);
      expectHistory(
        page,
        expected.slice(start, end),
        Array.from({ length: end - start }, (_, index) => start + index + 1),
        { totalMessages: expected.length },
      );
    }
    await appendTranscriptMessage(scope, {
      eventId: "new-tail",
      parentId: `row-${layout.length - 1}`,
      message: { role: "assistant", content: "fresh" },
    });
    const fresh = historyPage(scope, { maxMessages: 3 });
    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(expected.length + 1);
    expect(readSessionTranscriptHistoryEventCount(sibling)).toBe(2);
    expectHistory(
      fresh,
      [...expected.slice(-2), "new-tail"],
      [expected.length - 1, expected.length, expected.length + 1],
      { totalMessages: expected.length + 1 },
    );
  });
});
