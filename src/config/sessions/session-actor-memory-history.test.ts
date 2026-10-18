import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import {
  authority,
  memoryFixture,
  message,
  toolCall,
  toolResult,
  expectEqual,
  expectMatch,
} from "./session-actor-memory-fixture.test-support.js";
import type {
  SessionActorMemoryHistoryQuery,
  SessionActorMemoryHistoryReads,
} from "./session-actor-memory-history-contract.js";
import { commitMemory, readMemory } from "./session-actor-memory-publication.test-support.js";
import type { InternalSessionEntry } from "./types.js";

type HistoryName = keyof SessionActorMemoryHistoryReads extends `session.history.${infer Name}`
  ? Name
  : never;

const sessionKey = "agent:main:dashboard:incognito-history";
const sessionId = "window-one";
const storePath = ":memory:history";
const ids = (events: readonly unknown[]) =>
  events.flatMap((event) => (isRecord(event) && typeof event.id === "string" ? [event.id] : []));
const messageIds = (messages: readonly unknown[]) =>
  messages.flatMap((item) =>
    isRecord(item) && isRecord(item["__openclaw"]) ? [item["__openclaw"].id] : [],
  );

async function fixture(events: unknown[], entry: Partial<InternalSessionEntry> = {}) {
  const f = await memoryFixture({ agentId: "main", storePath, sessionKey, sessionId });
  const transcriptEvents = [
    { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
    ...events,
  ];
  await f.commit("session.entry.create", {
    entry: { sessionId, updatedAt: 1, incognito: true, ...entry },
    transcriptEvents,
  });
  function read<Key extends HistoryName>(
    name: Key,
    input: SessionActorMemoryHistoryReads[`session.history.${Key}`]["input"],
  ) {
    return f.read(`session.history.${name}`, input);
  }
  return { ...f, read, transcriptEvents, append: f.appendMessage };
}

it("keeps raw progress distinct from the active branch and publishes phase writes before reads", async () => {
  const { read, phase } = await fixture([
    message("user", null, "user", "Question"),
    message("old", "user", "assistant", "Old branch"),
  ]);
  const raw = await read("raw-delta", { limits: {} });
  const visible = await read("visible-delta", { limits: {} });
  assert(raw.kind === "page" && visible.kind === "page", "Expected initial pages");
  expect(ids(raw.events.map((row) => row.event))).toEqual([sessionId, "user", "old"]);
  expect(visible.events.map((row) => row.seq)).toEqual([1, 2]);
  const [write, page] = await Promise.all([
    phase(
      "branch",
      [
        {
          message: { role: "assistant", content: "New branch" },
          eventId: "new",
          parentId: "user",
        },
      ],
      "/synthetic/transcript",
    ),
    read("recent", { options: { maxMessages: 10 } }),
  ]);
  expect(write.kind).toBe("committed");
  expect(messageIds(page.messages)).toEqual(["user", "new"]);
  await expectMatch(read("visible-delta", { limits: { cursor: visible.cursor } }), {
    kind: "reset",
    reason: "anchor_missing",
  });
  const next = await read("raw-delta", { limits: { cursor: raw.cursor } });
  expect(next).toMatchObject({
    kind: "page",
    events: [{ seq: 3, event: { id: "new" } }],
    hasMore: false,
  });
});

it("preserves reset-relative history, historical anchors, and detached reads", async () => {
  const { read, append } = await fixture([
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
  expect(await read("count", {})).toBe(2);
  const current = await read("recent", { options: { maxMessages: 10, captureReadWindow: true } });
  expect(messageIds(current.messages)).toEqual(["reset", "current"]);
  const historical = await read("around-id", {
    options: {
      messageId: "reset",
      closedResetInterval: true,
      direction: "older",
      maxMessages: 10,
    },
  });
  expect(messageIds(historical.messages)).toEqual(["old-user", "old-answer"]);
  await expectEqual(
    read("by-id", {
      messageId: "old-answer",
      options: { currentOnly: true, maxBytes: 10000 },
    }),
    { found: false, oversized: false },
  );
  await expectMatch(read("by-id", { messageId: "old-answer" }), { found: true, seq: 2 });
  if (isRecord(current.messages[1])) {
    current.messages[1].content = "caller mutation";
  }
  await append(message("new-answer", "current", "assistant", "Latest"));
  const after = await read("page", {
    options: { offset: 0, maxMessages: 10, expectedReadWindow: current.readWindow },
  });
  expect(after.windowReset).toBeUndefined();
  expect(after.messages).toContainEqual(expect.objectContaining({ content: "Current" }));
});

it("sizes pages before copying and makes progress past oversized history", async () => {
  const large = message("large", "small", "assistant", "x".repeat(20000));
  const { read } = await fixture([message("small", null, "user", "Small"), large]);
  const byId = (messageId: string) =>
    read("by-id", { messageId, options: { currentOnly: true, maxBytes: 1024 } });
  await expectEqual(byId("missing"), { found: false, oversized: false });
  await expectEqual(byId("large"), {
    found: true,
    oversized: true,
    seq: 2,
    serializedBytes: Buffer.byteLength(JSON.stringify(large)),
  });
  await expectMatch(byId("small"), {
    found: true,
    oversized: false,
    message: { content: "Small" },
  });
  const page = await read("page", { options: { offset: 0, maxMessages: 2, maxBytes: 1024 } });
  expect(page).toMatchObject({
    messages: [],
    omittedOversized: true,
    olderOffset: 1,
    totalMessages: 2,
  });
  const older = await read("page", {
    options: { offset: page.olderOffset!, maxMessages: 2, maxBytes: 1024 },
  });
  expect(messageIds(older.messages)).toEqual(["small"]);
  const raw = await read("raw-delta", { limits: { maxEvents: 2 } });
  assert(raw.kind === "page", "Expected raw page");
  await expectMatch(read("raw-delta", { limits: { cursor: raw.cursor, maxBytes: 1024 } }), {
    kind: "page",
    events: [],
    hasMore: true,
    requiredBytes: expect.any(Number),
  });
  await expect(read("hydrate", { maxEventBytes: 1024 })).rejects.toThrow("too large to export");
});

it("refuses oversized default history reads while retaining full-message and media budgets", async () => {
  const content = "x".repeat(8 * 1024 * 1024);
  const { read, storage } = await fixture([message("large", null, "user", content)]);
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
  await expectMatch(
    read("around-id", {
      options: {
        messageId: "missing",
        maxMessages: 1,
        maxBytes: 1024,
        expectedReadWindow: { source: "stale", latestResetRawSeq: null },
      },
    }),
    {
      messages: [],
      found: true,
      windowReset: true,
      omittedOversized: true,
      hasOverreadContext: false,
    },
  );
  const exact = await read("by-id", { messageId: "large" });
  expect(exact.found && !exact.oversized && isRecord(exact.message) && exact.message.content).toBe(
    content,
  );
  const media = await read("page", {
    options: { offset: 0, maxMessages: 1, maxBytes: 16 * 1024 * 1024 },
  });
  expect(messageIds(media.messages)).toEqual(["large"]);
});

it("bounds recent history and refuses unbounded pages whose combined raw payload exceeds the cap", async () => {
  const content = "x".repeat(3 * 1024 * 1024);
  const { read, storage } = await fixture([
    message("first", null, "user", content),
    message("second", "first", "assistant", content),
    message("third", "second", "user", content),
  ]);
  const recent = await read("recent", {
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
  await commitMemory(storage, "session.lifecycle.reset", {
    expected,
    nextEntry: { sessionId: "window-two", incognito: true, updatedAt: 2 },
  });
  const next = await acquire();
  assert(next.storage, "Expected memory storage");
  const old = await readMemory(next.storage, "session.history.hydrate", { sessionId });
  expect(ids(old.snapshot.events)).toEqual([sessionId, "old"]);
  expect((await readMemory(next.storage, "session.history.hydrate", {})).snapshot.events).toEqual(
    [],
  );
  await commitMemory(next.storage, "session.lifecycle.delete", {});
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
  const { read, actor } = await fixture(events);
  const context = await read("context", { limits: { maxBytes: 4096, maxEvents: 8 } });
  expect(JSON.stringify(context.events)).not.toContain("old-body-");
  expect(JSON.stringify(context.events)).not.toContain("private-prompt");
  const unbounded = await read("context", {});
  expect(JSON.stringify(unbounded.events)).not.toContain("old-body-");
  const full = await read("hydrate", {});
  assert(full.kind === "full", "Expected full hydration");
  expect(full.snapshot.events.slice(1)).toEqual(events);
  expect(full.snapshot.eventJson?.slice(1)).toEqual(events.map((event) => JSON.stringify(event)));
  const anchor = actor
    .snapshot(authority)!
    .transcript.anchors.find((candidate) => candidate.entryId === "new")!;
  const admitted = await read("hydrate", {
    admission: { ...anchor, role: "user", logicalTurnId: "turn" },
  });
  expect(ids(admitted.snapshot.events)).not.toContain("new");
});

it("selects the first usable task with the supplied command metadata", async () => {
  const { read } = await fixture([
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
  await expectMatch(read("title", { skillCommands }), {
    fields: { firstUserMessage: "/api routing needs repair" },
  });
  await expectMatch(read("title", {}), {
    fields: { firstUserMessage: "Later ordinary task" },
  });
});

it("publishes branch, title, preview and match facts after an in-process write", async () => {
  const { read, append } = await fixture([
    message("user", null, "user", "Question"),
    message("old-answer", "user", "assistant", "Old branch", {
      idempotencyKey: "old-result",
      __openclaw: { runId: "old-run" },
    }),
  ]);
  await expectEqual(read("title", {}), {
    kind: "session-title-fields",
    fields: { firstUserMessage: "Question", lastMessagePreview: "Old branch" },
  });
  const [, title] = await Promise.all([
    append(
      message("new-answer", "user", "assistant", "**New** branch", {
        __openclaw: { runId: "new-run" },
      }),
    ),
    read("title", {}),
  ]);
  expect(title.fields).toEqual({ firstUserMessage: "Question", lastMessagePreview: "New branch" });
  await expectEqual(read("preview", { maxItems: 2, maxChars: 80 }), {
    kind: "session-preview",
    items: [
      { role: "user", text: "Question" },
      { role: "assistant", text: "**New** branch" },
    ],
  });
  await expectMatch(read("branches", {}), {
    status: "ok",
    branches: [
      { leafEntryId: "new-answer", headline: "New branch", messageCount: 2, active: true },
      { leafEntryId: "old-answer", headline: "Old branch", messageCount: 2, active: false },
    ],
  });
  await expectEqual(read("match", { match: { kind: "active-assistant", runId: "old-run" } }), {
    kind: "transcript-match",
    result: undefined,
  });
  await expectMatch(read("match", { match: { kind: "idempotency", key: "old-result" } }), {
    result: { event: { id: "old-answer" } },
  });
  const latest = await read("latest-active-message", {});
  expect(latest).toMatchObject({ event: { id: "new-answer" }, eventSeq: 3, seq: 2 });
  const version = await read("maintenance", { request: { operation: "version" } });
  expect(version.appendParentId).toBe("new-answer");
  assert(version.version, "Expected transcript version");
  await expectMatch(
    read("current-turn-entry", {
      entryId: "new-answer",
      version: version.version,
      includeEntry: true,
    }),
    { anchor: { entryId: "new-answer", rawSeq: 3 }, event: { id: "new-answer" } },
  );
  await expectMatch(read("watermark", {}), { watermark: { maxSeq: 3 } });
  expect(await read("message-presence", {})).toBe(true);
});

it("keeps history across compaction while accounting uses the retained context window", async () => {
  const keptUser = message("kept-user", "old", "user", "Keep this");
  const keptAssistant = toolCall("kept-assistant", "kept-user");
  const keptResult = toolResult("kept-result", "kept-assistant", "Found");
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
  const { read } = await fixture([
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
  const history = await read("bounded-tail", {
    options: { maxBytes: 100_000, maxMessages: 20, offset: 0 },
  });
  expect(history.events.map(({ event }) => event)).toEqual([
    keptUser,
    keptAssistant,
    fresh,
    answer,
  ]);
  expect(history.snapshot.boundarySeq).toBe(5);
  const accounting = await read("accounting", {
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
  const recent = await read("recent-active-events", { maxEvents: 2 });
  expect(recent).toEqual([compaction, answer]);
});

it("bounds detached tails without hiding an oversized gap or changing physical stats", async () => {
  const first = message("first", null, "user", "Short question");
  const large = message("large", "first", "assistant", "x".repeat(4000));
  const last = message("last", "large", "assistant", "Short answer");
  const { read, transcriptEvents } = await fixture([first, large, last]);
  const page = await read("bounded-tail", {
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
  await expectMatch(read("latest-assistant", {}), { id: "last", text: "Short answer" });
  await expectMatch(read("stats", {}), {
    eventCount: 4,
    maxSeq: 3,
    sizeBytes: Buffer.byteLength(transcriptEvents.map((event) => JSON.stringify(event)).join("\n")),
  });
});

it("updates usage and turn taint at the next input and preserves unavailable usage barriers", async () => {
  const tool = toolResult("tool", "usage", "Network result", {
    __openclaw: { resultContentSource: "network" },
  });
  const { storage, append } = await fixture([
    message("user", null, "user", "Question"),
    toolCall("usage", "user", { usage: { input: 30, output: 5, totalTokens: 35 } }),
    tool,
  ]);
  const query = {
    type: "session.history.accounting" as const,
    input: { options: { includeByteSize: false, includeUsage: true, includeTurnTaint: true } },
  };
  await expectEqual(storage.read(query, authority), {
    turnTainted: true,
    usage: { promptTokens: 30, outputTokens: 5, trailingMessages: [tool.message] },
  });
  await append(message("next-user", "tool", "user", "Next question"));
  await expectMatch(storage.read(query, authority), {
    turnTainted: false,
    usage: { promptTokens: 30, outputTokens: 5 },
  });
  await append(
    message("unavailable", "next-user", "assistant", "Usage unavailable", {
      usage: { input: 0, output: 0, contextUsage: { state: "unavailable" } },
    }),
  );
  await expectEqual(storage.read(query, authority), { turnTainted: false, usage: undefined });
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
  const { read } = await fixture([user, opaque, answer]);
  const projected = { type: "custom", id: "opaque", parentId: "user", customType: "tool-state" };
  const suffix = (retainedCustomDataIds: string[]) =>
    read("maintenance", {
      request: {
        operation: "suffix",
        startSeq: 2,
        maxBytes: 1000,
        maxEvents: 2,
        retainedCustomDataIds,
      },
    });
  await expectEqual(suffix(["opaque"]), {
    kind: "transcript-maintenance",
    events: [projected, answer],
  });
  await expect(suffix([])).rejects.toThrow("byte limit");
  await expectEqual(read("maintenance", { request: { operation: "previous", beforeSeq: 3 } }), {
    kind: "transcript-maintenance",
    previous: opaque,
  });
  await expectEqual(
    read("maintenance", { request: { operation: "identity", eventId: "opaque" } }),
    { kind: "transcript-maintenance", seq: 2 },
  );
});

it("checks current permission and writer authority before returning replay anchors", async () => {
  const { read, storage, acquire } = await fixture([message("user", null, "user", "Question")], {
    permissionMode: "full",
    lifecycleRevision: "life-1",
    activeWriterRunId: "writer-1",
  });
  const captured = await read("anchors", {
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
  await commitMemory(storage, "session.entry.patch", {
    operation: {
      kind: "fields",
      patch: { permissionMode: "workspace", activeWriterRunId: "writer-2" },
    },
  });
  await expectMatch(
    read("anchors", {
      entryIds: ["user"],
      contextAuthority: { permissionMode: "full" },
      contextValidation: { through: anchor },
    }),
    {
      anchors: [],
      contextAuthority: { entry: { permissionMode: "workspace", activeWriterRunId: "writer-2" } },
    },
  );
  await expect(
    read("anchors", {
      entryIds: ["user"],
      replayValidation: { allowInitial: false, expectedWriterRunId: "writer-1" },
    }),
  ).rejects.toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
  await expect(
    read("anchors", {
      entryIds: ["user"],
      contextValidation: {
        through: anchor,
        expectedAuthority: { permissionMode: "full", lifecycleRevision: "life-1" },
      },
    }),
  ).rejects.toThrow("changed lifecycle or permissions");
  const beforeReset = await readMemory(storage, "session.entry.read", {});
  await commitMemory(storage, "session.lifecycle.reset", {
    expected: beforeReset,
    nextEntry: { sessionId: "next-window", incognito: true, updatedAt: 2, permissionMode: "full" },
  });
  const retiredWindow = {
    type: "session.history.anchors" as const,
    input: { sessionId, entryIds: ["user"], contextAuthority: true as const },
  };
  await expect(async () => storage.read(retiredWindow, authority)).rejects.toThrow("closed");
  const current = await acquire();
  await expectMatch(current.storage!.read(retiredWindow, authority), {
    anchors: [],
    contextAuthority: { entry: { sessionId: "next-window" } },
  });
});

it("returns raw tail identities while attaching only selected-run active messages", async () => {
  const answer = message("answer", "user", "assistant", "Current answer", {
    __openclaw: { runId: "target" },
  });
  const { read } = await fixture([
    message("user", null, "user", "Question"),
    message("retired", "user", "assistant", "Abandoned branch", {
      __openclaw: { runId: "target" },
    }),
    answer,
    message("other", "answer", "assistant", "Other run", { __openclaw: { runId: "other" } }),
    message("followup", "other", "user", "Next question"),
  ]);
  const facts = await read("anchors", {
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
  await expectMatch(
    read("anchors", {
      entryIds: ["user", "followup"],
      replayValidation: {
        allowInitial: false,
        admission: { ...admitted, role: "user", logicalTurnId: "turn-2" },
      },
    }),
    { replayValidated: "current", anchors: [{ entryId: "user" }] },
  );
});
