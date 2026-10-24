import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, describe, expect, it } from "vitest";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import type { SessionActorMemoryHistoryQuery } from "./session-actor-memory-history-contract.js";
import { mutateMemory, readMemory } from "./session-actor-memory-publication.test-support.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import type { InternalSessionEntry } from "./types.js";

const sessionKey = "agent:main:dashboard:incognito-history";
const sessionId = "window-one";
const storePath = ":memory:history";
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});
const message = (
  id: string,
  parentId: string | null,
  role: string,
  content: string | unknown[],
  extra: Record<string, unknown> = {},
) => ({
  type: "message" as const,
  id,
  parentId,
  timestamp: "2026-10-11T00:00:00.000Z",
  message: { role, content, ...extra },
});
const ids = (events: readonly unknown[]) =>
  events.flatMap((event) => (isRecord(event) && typeof event.id === "string" ? [event.id] : []));
const messageIds = (messages: readonly unknown[]) =>
  messages.flatMap((item) =>
    isRecord(item) && isRecord(item["__openclaw"]) ? [item["__openclaw"].id] : [],
  );

async function fixture(events: unknown[], entry: Partial<InternalSessionEntry> = {}) {
  const owner = createMemorySessionActorOwner({ agentId: "main", path: storePath });
  owners.push(owner);
  const acquire = () =>
    owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
  const actor = await acquire();
  const storage = actor.storage;
  assert(storage, "Expected memory storage capability");
  const transcriptEvents = [
    { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
    ...events,
  ];
  const result = await mutateMemory(storage, "session.entry.create", {
    entry: { sessionId, updatedAt: 1, incognito: true, ...entry },
    transcriptEvents,
  });
  expect(result.kind).toBe("committed");
  return {
    owner,
    actor,
    acquire,
    storage,
    transcriptEvents,
    append: async (event: ReturnType<typeof message>) => {
      const { message: payload, ...envelope } = event;
      const outcome = await mutateMemory(storage, "session.metadata.append", {
        scope: { agentId: "main", storePath, sessionKey, sessionId },
        event: envelope,
        message: {
          messageJson: JSON.stringify(payload),
          cwd: "/synthetic",
          validateTurn: false,
        },
        options: {},
      });
      expect(outcome.kind).toBe("committed");
    },
  };
}

describe("memory actor history", () => {
  it("selects retained message owners across memory branches and keeps an empty selection empty", async () => {
    const { storage } = await fixture([
      message("root", null, "user", "Question"),
      message("old", "root", "assistant", "Off-path attachment"),
      message("unrelated", "root", "assistant", "Unrelated content"),
      message("current", "unrelated", "assistant", "Current attachment"),
    ]);
    for (const selected of [["old", "current"], []]) {
      const page = await readMemory(storage, "session.history.source", {
        options: { mode: "page", includeOffPathMessages: true, messageIds: selected },
      });
      expect(
        messageIds(page.messages).toSorted((a, b) => String(a).localeCompare(String(b))),
      ).toEqual(selected.toSorted((a, b) => a.localeCompare(b)));
      expect(page.nextCursor).toBeUndefined();
    }
  });

  it("keeps raw progress distinct from the active branch and publishes phase writes before reads", async () => {
    const { actor, storage } = await fixture([
      message("user", null, "user", "Question"),
      message("old", "user", "assistant", "Old branch"),
    ]);
    const raw = await readMemory(storage, "session.history.raw-delta", { limits: {} });
    const visible = await readMemory(storage, "session.history.visible-delta", { limits: {} });
    assert(raw.kind === "page" && visible.kind === "page", "Expected initial pages");
    expect(ids(raw.events.map((row) => row.event))).toEqual([sessionId, "user", "old"]);
    expect(visible.events.map((row) => row.seq)).toEqual([1, 2]);
    const [write, page] = await Promise.all([
      actor.appendToolResult(
        {
          commandId: "branch",
          phaseId: "turn",
          turn: {
            agentId: "main",
            sessionKey,
            options: {
              expectedSessionId: sessionId,
              sessionFile: "/synthetic/transcript",
              messages: [
                {
                  message: { role: "assistant", content: "New branch" },
                  eventId: "new",
                  parentId: "user",
                },
              ],
            },
          },
        },
        authority,
      ),
      readMemory(storage, "session.history.recent", { options: { maxMessages: 10 } }),
    ]);
    expect(write.kind).toBe("committed");
    expect(messageIds(page.messages)).toEqual(["user", "new"]);
    expect(
      await readMemory(storage, "session.history.visible-delta", {
        limits: { cursor: visible.cursor },
      }),
    ).toMatchObject({ kind: "reset", reason: "anchor_missing" });
    const next = await readMemory(storage, "session.history.raw-delta", {
      limits: { cursor: raw.cursor },
    });
    expect(next).toMatchObject({
      kind: "page",
      events: [{ seq: 3, event: { id: "new" } }],
      hasMore: false,
    });
  });

  it("preserves reset-relative history, historical anchors, and detached reads", async () => {
    const { storage, append } = await fixture([
      message("old-user", null, "user", "Before reset"),
      message("old-answer", "old-user", "assistant", "Old answer"),
      {
        type: "reset",
        id: "reset",
        parentId: "old-answer",
        reason: "new",
        timestamp: "2026-10-11T00:00:01.000Z",
      },
      message("current", "reset", "user", "Current"),
    ]);
    expect(await readMemory(storage, "session.history.count", {})).toBe(2);
    const current = await readMemory(storage, "session.history.recent", {
      options: { maxMessages: 10, captureReadWindow: true },
    });
    expect(messageIds(current.messages)).toEqual(["reset", "current"]);
    const historical = await readMemory(storage, "session.history.around-id", {
      options: {
        messageId: "reset",
        closedResetInterval: true,
        direction: "older",
        maxMessages: 10,
      },
    });
    expect(messageIds(historical.messages)).toEqual(["old-user", "old-answer"]);
    expect(
      await readMemory(storage, "session.history.by-id", {
        messageId: "old-answer",
        options: { currentOnly: true, maxBytes: 10000 },
      }),
    ).toEqual({ found: false, oversized: false });
    expect(
      await readMemory(storage, "session.history.by-id", { messageId: "old-answer" }),
    ).toMatchObject({ found: true, seq: 2 });
    if (isRecord(current.messages[1])) {
      current.messages[1].content = "caller mutation";
    }
    await append(message("new-answer", "current", "assistant", "Latest"));
    const after = await readMemory(storage, "session.history.page", {
      options: { offset: 0, maxMessages: 10, expectedReadWindow: current.readWindow },
    });
    expect(after.windowReset).toBeUndefined();
    expect(after.messages).toContainEqual(expect.objectContaining({ content: "Current" }));
  });

  it("sizes pages before copying and makes progress past oversized history", async () => {
    const large = message("large", "small", "assistant", "x".repeat(20000));
    const { storage } = await fixture([message("small", null, "user", "Small"), large]);
    expect(
      await readMemory(storage, "session.history.by-id", {
        messageId: "missing",
        options: { currentOnly: true, maxBytes: 1024 },
      }),
    ).toEqual({ found: false, oversized: false });
    expect(
      await readMemory(storage, "session.history.by-id", {
        messageId: "large",
        options: { currentOnly: true, maxBytes: 1024 },
      }),
    ).toEqual({
      found: true,
      oversized: true,
      seq: 2,
      serializedBytes: Buffer.byteLength(JSON.stringify(large)),
    });
    expect(
      await readMemory(storage, "session.history.by-id", {
        messageId: "small",
        options: { currentOnly: true, maxBytes: 1024 },
      }),
    ).toMatchObject({ found: true, oversized: false, message: { content: "Small" } });
    const page = await readMemory(storage, "session.history.page", {
      options: { offset: 0, maxMessages: 2, maxBytes: 1024 },
    });
    expect(page).toMatchObject({
      messages: [],
      omittedOversized: true,
      olderOffset: 1,
      totalMessages: 2,
    });
    const older = await readMemory(storage, "session.history.page", {
      options: { offset: page.olderOffset!, maxMessages: 2, maxBytes: 1024 },
    });
    expect(messageIds(older.messages)).toEqual(["small"]);
    const raw = await readMemory(storage, "session.history.raw-delta", {
      limits: { maxEvents: 2 },
    });
    assert(raw.kind === "page", "Expected raw page");
    expect(
      await readMemory(storage, "session.history.raw-delta", {
        limits: { cursor: raw.cursor, maxBytes: 1024 },
      }),
    ).toMatchObject({ kind: "page", events: [], hasMore: true, requiredBytes: expect.any(Number) });
    await expect(
      readMemory(storage, "session.history.hydrate", { maxEventBytes: 1024 }),
    ).rejects.toThrow("too large to export");
  });

  it("refuses oversized default history reads while retaining full-message and media budgets", async () => {
    const content = "x".repeat(8 * 1024 * 1024);
    const { storage } = await fixture([message("large", null, "user", content)]);
    const reads: SessionActorMemoryHistoryQuery[] = [
      {
        type: "session.history.recent",
        input: { options: { maxMessages: 1, maxBytes: 16 * 1024 * 1024 } },
      },
      { type: "session.history.page", input: { options: { offset: 0, maxMessages: 1 } } },
      {
        type: "session.history.around-id",
        input: { options: { messageId: "large", maxMessages: 1 } },
      },
    ];
    for (const query of reads) {
      expect(() => storage.readCurrent(query, authority)).toThrow(
        "Transcript history message exceeds the 8388608-byte page limit",
      );
    }
    expect(
      await readMemory(storage, "session.history.around-id", {
        options: {
          messageId: "missing",
          maxMessages: 1,
          maxBytes: 1024,
          expectedReadWindow: { source: "stale", latestResetRawSeq: null },
        },
      }),
    ).toMatchObject({
      messages: [],
      found: true,
      windowReset: true,
      omittedOversized: true,
      hasOverreadContext: false,
    });
    const exact = await readMemory(storage, "session.history.by-id", { messageId: "large" });
    expect(
      exact.found && !exact.oversized && isRecord(exact.message) && exact.message.content,
    ).toBe(content);
    const media = await readMemory(storage, "session.history.page", {
      options: { offset: 0, maxMessages: 1, maxBytes: 16 * 1024 * 1024 },
    });
    expect(messageIds(media.messages)).toEqual(["large"]);
  });

  it("bounds recent history and refuses unbounded pages whose combined raw payload exceeds the cap", async () => {
    const content = "x".repeat(3 * 1024 * 1024);
    const { storage } = await fixture([
      message("first", null, "user", content),
      message("second", "first", "assistant", content),
      message("third", "second", "user", content),
    ]);
    const recent = await readMemory(storage, "session.history.recent", {
      options: { maxMessages: 3, maxBytes: 16 * 1024 * 1024 },
    });
    expect(messageIds(recent.messages)).toEqual(["second", "third"]);
    const reads: SessionActorMemoryHistoryQuery[] = [
      { type: "session.history.page", input: { options: { offset: 0, maxMessages: 3 } } },
      {
        type: "session.history.around-id",
        input: { options: { messageId: "second", maxMessages: 3 } },
      },
    ];
    for (const query of reads) {
      expect(() => storage.readCurrent(query, authority)).toThrow(
        "Transcript history page exceeds the 8388608-byte limit; request a smaller limit",
      );
    }
  });

  it("retains historical sessionId windows across rotation and removes them with the logical session", async () => {
    const { storage, acquire } = await fixture([message("old", null, "user", "Preserved history")]);
    const expected = await readMemory(storage, "session.entry.read", {});
    expect(
      (
        await mutateMemory(storage, "session.lifecycle.reset", {
          expected,
          nextEntry: { sessionId: "window-two", incognito: true, updatedAt: 2 },
        })
      ).kind,
    ).toBe("committed");
    const next = await acquire();
    assert(next.storage, "Expected memory storage");
    const old = await readMemory(next.storage, "session.history.hydrate", { sessionId });
    expect(ids(old.snapshot.events)).toEqual([sessionId, "old"]);
    expect((await readMemory(next.storage, "session.history.hydrate", {})).snapshot.events).toEqual(
      [],
    );
    expect((await mutateMemory(next.storage, "session.lifecycle.delete", {})).kind).toBe(
      "committed",
    );
    const fresh = await acquire();
    await expect(
      readMemory(fresh.storage!, "session.history.hydrate", { sessionId }),
    ).resolves.toMatchObject({
      kind: "full",
      snapshot: { events: [], eventJson: [], eventSeqs: [] },
    });
  });

  it("keeps full hydration exact while model context excludes obsolete payloads and private fields", async () => {
    const events = [
      message("old", null, "user", "old-body-".repeat(4000)),
      {
        type: "compaction",
        id: "compact",
        parentId: "old",
        firstKeptEntryId: "new",
        summary: "Earlier summary",
        tokensBefore: 100,
        timestamp: "2026-10-11T00:00:01.000Z",
      },
      message("new", "compact", "user", "Current", {
        __openclaw: { upstreamUserText: "private-prompt", runId: "run" },
      }),
    ];
    const { storage, actor } = await fixture(events);
    const context = await readMemory(storage, "session.history.context", {
      limits: { maxBytes: 4096, maxEvents: 8 },
    });
    expect(JSON.stringify(context.events)).not.toContain("old-body-");
    expect(JSON.stringify(context.events)).not.toContain("private-prompt");
    const unbounded = await readMemory(storage, "session.history.context", {});
    expect(JSON.stringify(unbounded.events)).not.toContain("old-body-");
    const full = await readMemory(storage, "session.history.hydrate", {});
    expect(full.kind).toBe("full");
    assert(full.kind === "full", "Expected full hydration");
    expect(full.snapshot.events.slice(1)).toEqual(events);
    expect(full.snapshot.eventJson?.slice(1)).toEqual(events.map((event) => JSON.stringify(event)));
    const anchor = actor
      .snapshot(authority)!
      .transcript.anchors.find((candidate) => candidate.entryId === "new")!;
    const admitted = await readMemory(storage, "session.history.hydrate", {
      admission: { ...anchor, role: "user", logicalTurnId: "turn" },
    });
    expect(ids(admitted.snapshot.events)).not.toContain("new");
  });
});

describe("memory actor history facts", () => {
  it("selects the first usable task with the supplied command metadata", async () => {
    const { storage } = await fixture([
      message("control", null, "user", "/status"),
      message(
        "skill",
        "control",
        "user",
        "[Mon 2026-08-10 12:00 UTC] /topic_proof /api routing needs repair",
      ),
      message("plain", "skill", "user", "Later ordinary task"),
    ]);
    const skillCommands = [
      { name: "topic_proof", skillName: "topic-proof", description: "Review a task" },
    ];
    expect(await readMemory(storage, "session.history.title", { skillCommands })).toMatchObject({
      fields: { firstUserMessage: "/api routing needs repair" },
    });
    expect(await readMemory(storage, "session.history.title", {})).toMatchObject({
      fields: { firstUserMessage: "Later ordinary task" },
    });
  });

  it("publishes branch, title, preview and match facts after an in-process write", async () => {
    const { storage, append } = await fixture([
      message("user", null, "user", "Question"),
      message("old-answer", "user", "assistant", "Old branch", {
        idempotencyKey: "old-result",
        __openclaw: { runId: "old-run" },
      }),
    ]);
    expect(await readMemory(storage, "session.history.title", {})).toEqual({
      kind: "session-title-fields",
      fields: { firstUserMessage: "Question", lastMessagePreview: "Old branch" },
    });
    const [, title] = await Promise.all([
      append(
        message("new-answer", "user", "assistant", "**New** branch", {
          __openclaw: { runId: "new-run" },
        }),
      ),
      readMemory(storage, "session.history.title", {}),
    ]);
    expect(title.fields).toEqual({
      firstUserMessage: "Question",
      lastMessagePreview: "New branch",
    });
    expect(
      await readMemory(storage, "session.history.preview", { maxItems: 2, maxChars: 80 }),
    ).toEqual({
      kind: "session-preview",
      items: [
        { role: "user", text: "Question" },
        { role: "assistant", text: "**New** branch" },
      ],
    });
    expect(await readMemory(storage, "session.history.branches", {})).toMatchObject({
      status: "ok",
      branches: [
        { leafEntryId: "new-answer", headline: "New branch", messageCount: 2, active: true },
        { leafEntryId: "old-answer", headline: "Old branch", messageCount: 2, active: false },
      ],
    });
    expect(
      await readMemory(storage, "session.history.match", {
        match: { kind: "active-assistant", runId: "old-run" },
      }),
    ).toEqual({ kind: "transcript-match", result: undefined });
    expect(
      await readMemory(storage, "session.history.match", {
        match: { kind: "idempotency", key: "old-result" },
      }),
    ).toMatchObject({ result: { event: { id: "old-answer" } } });
    const latest = await readMemory(storage, "session.history.latest-active-message", {});
    expect(latest).toMatchObject({ event: { id: "new-answer" }, eventSeq: 3, seq: 2 });
    const version = await readMemory(storage, "session.history.maintenance", {
      request: { operation: "version" },
    });
    expect(version.appendParentId).toBe("new-answer");
    assert(version.version, "Expected transcript version");
    expect(
      await readMemory(storage, "session.history.current-turn-entry", {
        entryId: "new-answer",
        version: version.version,
        includeEntry: true,
      }),
    ).toMatchObject({ anchor: { entryId: "new-answer", rawSeq: 3 }, event: { id: "new-answer" } });
    expect(await readMemory(storage, "session.history.watermark", {})).toMatchObject({
      watermark: { maxSeq: 3 },
    });
    expect(await readMemory(storage, "session.history.message-presence", {})).toBe(true);
  });

  it("keeps history across compaction while accounting uses the retained context window", async () => {
    const keptUser = message("kept-user", "old", "user", "Keep this");
    const keptAssistant = message("kept-assistant", "kept-user", "assistant", [
      { type: "toolCall", id: "call", name: "lookup", arguments: {} },
    ]);
    const keptResult = message(
      "kept-result",
      "kept-assistant",
      "toolResult",
      [{ type: "text", text: "Found" }],
      { toolCallId: "call", toolName: "lookup", isError: false },
    );
    const fresh = message("fresh", "reset", "user", "Fresh question");
    const compaction = {
      type: "compaction",
      id: "compact",
      parentId: "fresh",
      timestamp: "2026-10-11T00:00:00.000Z",
      firstKeptEntryId: "fresh",
      summary: "Earlier context",
      tokensBefore: 100,
    };
    const answer = message("answer", "compact", "assistant", "Answer");
    const { storage } = await fixture([
      message("old", null, "user", "Drop this"),
      keptUser,
      keptAssistant,
      keptResult,
      {
        type: "reset",
        id: "reset",
        parentId: "kept-result",
        reason: "new",
        firstKeptEntryId: "kept-user",
      },
      fresh,
      compaction,
      answer,
    ]);
    const history = await readMemory(storage, "session.history.bounded-tail", {
      options: { maxBytes: 100_000, maxMessages: 20, offset: 0 },
    });
    expect(history.events.map(({ event }) => event)).toEqual([
      keptUser,
      keptAssistant,
      fresh,
      answer,
    ]);
    expect(history.snapshot.boundarySeq).toBe(5);
    const accounting = await readMemory(storage, "session.history.accounting", {
      options: { includeByteSize: true, includeUsage: true },
    });
    expect(accounting).toEqual({
      byteSize: [fresh, compaction, answer].reduce(
        (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)) + 1,
        0,
      ),
      eventCount: 3,
      usage: undefined,
    });
    const recent = await readMemory(storage, "session.history.recent-active-events", {
      maxEvents: 2,
    });
    expect(recent).toEqual([compaction, answer]);
  });

  it("bounds detached tails without hiding an oversized gap or changing physical stats", async () => {
    const first = message("first", null, "user", "Short question");
    const large = message("large", "first", "assistant", "x".repeat(4000));
    const last = message("last", "large", "assistant", "Short answer");
    const { storage, transcriptEvents } = await fixture([first, large, last]);
    const page = await readMemory(storage, "session.history.bounded-tail", {
      options: {
        maxBytes: 1000,
        maxMessages: 3,
        offset: 0,
        oversizedMessageCheck: { roles: ["assistant"] },
      },
    });
    expect(page).toMatchObject({
      hasOversizedMessages: true,
      scannedMessages: 3,
      newestContiguousEventCount: 1,
      totalMessages: 3,
    });
    expect(page.events).toEqual([
      { event: first, eventSeq: 1, seq: 1 },
      { event: last, eventSeq: 3, seq: 3 },
    ]);
    expect(page.serializedBytes).toBe(
      Buffer.byteLength(JSON.stringify(first)) + Buffer.byteLength(JSON.stringify(last)) + 2,
    );
    page.events.length = 0;
    expect(await readMemory(storage, "session.history.latest-assistant", {})).toMatchObject({
      id: "last",
      text: "Short answer",
    });
    expect(await readMemory(storage, "session.history.stats", {})).toMatchObject({
      eventCount: 4,
      maxSeq: 3,
      sizeBytes: Buffer.byteLength(
        transcriptEvents.map((event) => JSON.stringify(event)).join("\n"),
      ),
    });
  });

  it("updates usage and turn taint at the next input and preserves unavailable usage barriers", async () => {
    const tool = message(
      "tool",
      "usage",
      "toolResult",
      [{ type: "text", text: "Network result" }],
      {
        toolCallId: "call",
        toolName: "lookup",
        isError: false,
        __openclaw: { resultContentSource: "network" },
      },
    );
    const { storage, append } = await fixture([
      message("user", null, "user", "Question"),
      message(
        "usage",
        "user",
        "assistant",
        [{ type: "toolCall", id: "call", name: "lookup", arguments: {} }],
        { usage: { input: 30, output: 5, totalTokens: 35 } },
      ),
      tool,
    ]);
    const query = {
      type: "session.history.accounting" as const,
      input: { options: { includeByteSize: false, includeUsage: true, includeTurnTaint: true } },
    };
    expect(await storage.read(query, authority)).toEqual({
      turnTainted: true,
      usage: { promptTokens: 30, outputTokens: 5, trailingMessages: [tool.message] },
    });
    await append(message("next-user", "tool", "user", "Next question"));
    expect(await storage.read(query, authority)).toMatchObject({
      turnTainted: false,
      usage: { promptTokens: 30, outputTokens: 5 },
    });
    await append(
      message("unavailable", "next-user", "assistant", "Usage unavailable", {
        usage: { input: 0, output: 0, contextUsage: { state: "unavailable" } },
      }),
    );
    expect(await storage.read(query, authority)).toEqual({ turnTainted: false, usage: undefined });
  });

  it("projects opaque suffix data before bounds and keeps the original event intact", async () => {
    const user = message("user", null, "user", "Question");
    const opaque = {
      type: "custom",
      id: "opaque",
      parentId: "user",
      customType: "tool-state",
      data: "x".repeat(5000),
    };
    const answer = message("answer", "opaque", "assistant", "Answer");
    const { storage } = await fixture([user, opaque, answer]);
    const projected = { type: "custom", id: "opaque", parentId: "user", customType: "tool-state" };
    expect(
      await readMemory(storage, "session.history.maintenance", {
        request: {
          operation: "suffix",
          startSeq: 2,
          maxBytes: 1000,
          maxEvents: 2,
          retainedCustomDataIds: ["opaque"],
        },
      }),
    ).toEqual({ kind: "transcript-maintenance", events: [projected, answer] });
    await expect(
      readMemory(storage, "session.history.maintenance", {
        request: {
          operation: "suffix",
          startSeq: 2,
          maxBytes: 1000,
          maxEvents: 2,
          retainedCustomDataIds: [],
        },
      }),
    ).rejects.toThrow("byte limit");
    expect(
      await readMemory(storage, "session.history.maintenance", {
        request: { operation: "previous", beforeSeq: 3 },
      }),
    ).toEqual({ kind: "transcript-maintenance", previous: opaque });
    expect(
      await readMemory(storage, "session.history.maintenance", {
        request: { operation: "identity", eventId: "opaque" },
      }),
    ).toEqual({ kind: "transcript-maintenance", seq: 2 });
  });
  it("checks current permission and writer authority before returning replay anchors", async () => {
    const { storage, acquire } = await fixture([message("user", null, "user", "Question")], {
      permissionMode: "full",
      lifecycleRevision: "life-1",
      activeWriterRunId: "writer-1",
    });
    const captured = await readMemory(storage, "session.history.anchors", {
      entryIds: ["user"],
      includeSession: true,
      includeHeader: true,
      includeWatermark: true,
      includeMessagePresence: true,
      includeMetadata: true,
      contextAuthority: { permissionMode: "full" },
      replayValidation: {
        allowInitial: false,
        expectedLifecycleRevision: "life-1",
        expectedWriterRunId: "writer-1",
      },
    });
    expect(captured).toMatchObject({
      replayValidated: "current",
      anchors: [{ entryId: "user" }],
      session: { sessionId, lifecycleRevision: "life-1" },
      header: { type: "session", id: sessionId },
      watermark: { maxSeq: 1 },
      messagePresence: true,
      metadata: { present: true },
    });
    const anchor = captured.anchors[0];
    assert(anchor, "Expected input anchor");
    expect(
      (
        await mutateMemory(storage, "session.entry.patch", {
          operation: {
            kind: "fields",
            patch: { permissionMode: "workspace", activeWriterRunId: "writer-2" },
          },
        })
      ).kind,
    ).toBe("committed");
    expect(
      await readMemory(storage, "session.history.anchors", {
        entryIds: ["user"],
        contextAuthority: { permissionMode: "full" },
        contextValidation: { through: anchor },
      }),
    ).toMatchObject({
      anchors: [],
      contextAuthority: { entry: { permissionMode: "workspace", activeWriterRunId: "writer-2" } },
    });
    await expect(
      readMemory(storage, "session.history.anchors", {
        entryIds: ["user"],
        replayValidation: { allowInitial: false, expectedWriterRunId: "writer-1" },
      }),
    ).rejects.toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
    await expect(
      readMemory(storage, "session.history.anchors", {
        entryIds: ["user"],
        contextValidation: {
          through: anchor,
          expectedAuthority: { permissionMode: "full", lifecycleRevision: "life-1" },
        },
      }),
    ).rejects.toThrow("changed lifecycle or permissions");
    const beforeReset = await readMemory(storage, "session.entry.read", {});
    expect(
      (
        await mutateMemory(storage, "session.lifecycle.reset", {
          expected: beforeReset,
          nextEntry: {
            sessionId: "next-window",
            incognito: true,
            updatedAt: 2,
            permissionMode: "full",
          },
        })
      ).kind,
    ).toBe("committed");
    const retiredWindow = {
      type: "session.history.anchors" as const,
      input: { sessionId, entryIds: ["user"], contextAuthority: true as const },
    };
    await expect(async () => storage.read(retiredWindow, authority)).rejects.toThrow("closed");
    const current = await acquire();
    expect(await current.storage!.read(retiredWindow, authority)).toMatchObject({
      anchors: [],
      contextAuthority: { entry: { sessionId: "next-window" } },
    });
  });

  it("returns raw tail identities while attaching only selected-run active messages", async () => {
    const answer = message("answer", "user", "assistant", "Current answer", {
      __openclaw: { runId: "target" },
    });
    const { storage } = await fixture([
      message("user", null, "user", "Question"),
      message("retired", "user", "assistant", "Abandoned branch", {
        __openclaw: { runId: "target" },
      }),
      answer,
      message("other", "answer", "assistant", "Other run", { __openclaw: { runId: "other" } }),
      message("followup", "other", "user", "Next question"),
    ]);
    const facts = await readMemory(storage, "session.history.anchors", {
      entryIds: ["user"],
      afterSeq: 1,
      includeMessagesForRunId: "target",
    });
    expect(facts.anchors.map((anchor) => anchor.entryId)).toEqual(["user", "answer", "followup"]);
    expect(facts.tail?.lastSeq).toBe(5);
    expect(facts.tail?.entries).toEqual([
      { entryId: "retired", role: "assistant", runId: "target" },
      {
        entryId: "answer",
        role: "assistant",
        runId: "target",
        anchor: expect.objectContaining({ entryId: "answer" }),
        message: answer.message,
      },
      { entryId: "other", role: "assistant", runId: "other" },
      {
        entryId: "followup",
        role: "user",
        anchor: expect.objectContaining({ entryId: "followup" }),
      },
    ]);
    const admitted = facts.anchors.find((anchor) => anchor.entryId === "followup");
    assert(admitted, "Expected followup input anchor");
    expect(
      await readMemory(storage, "session.history.anchors", {
        entryIds: ["user", "followup"],
        replayValidation: {
          allowInitial: false,
          admission: { ...admitted, role: "user", logicalTurnId: "turn-2" },
        },
      }),
    ).toMatchObject({ replayValidated: "current", anchors: [{ entryId: "user" }] });
  });
});
