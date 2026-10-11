import { afterEach, describe, expect, it } from "vitest";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import type { InternalSessionEntry } from "./types.js";

const sessionKey = "agent:main:dashboard:incognito-history-facts";
const sessionId = "history-window";
const storePath = ":memory:history-facts";
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

function message(
  id: string,
  parentId: string | null,
  role: string,
  content: string | unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    type: "message" as const,
    id,
    parentId,
    timestamp: "2026-10-11T00:00:00.000Z",
    message: { role, content, ...extra },
  };
}

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
  if (!storage) {
    throw new Error("Expected memory storage capability");
  }
  const transcriptEvents = [
    { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
    ...events,
  ];
  const result = await storage.mutate(
    {
      type: "session.entry.create",
      input: { entry: { sessionId, updatedAt: 1, incognito: true, ...entry }, transcriptEvents },
    },
    authority,
  );
  expect(result.kind).toBe("committed");
  return {
    actor,
    acquire,
    storage,
    transcriptEvents,
    append: async (event: ReturnType<typeof message>) => {
      const { message: payload, ...envelope } = event;
      const outcome = await storage.mutate(
        {
          type: "session.metadata.append",
          input: {
            scope: { agentId: "main", storePath, sessionKey, sessionId },
            event: envelope,
            message: {
              messageJson: JSON.stringify(payload),
              cwd: "/synthetic",
              validateTurn: false,
            },
            options: {},
          },
        },
        authority,
      );
      expect(outcome.kind).toBe("committed");
    },
  };
}

describe("memory actor history facts", () => {
  it("publishes branch, title, preview and match facts after an in-process write", async () => {
    const { storage, append } = await fixture([
      message("user", null, "user", "Question"),
      message("old-answer", "user", "assistant", "Old branch", {
        idempotencyKey: "old-result",
        __openclaw: { runId: "old-run" },
      }),
    ]);
    expect(await storage.read({ type: "session.history.title", input: {} }, authority)).toEqual({
      kind: "session-title-fields",
      fields: { firstUserMessage: "Question", lastMessagePreview: "Old branch" },
    });
    const [, title] = await Promise.all([
      append(
        message("new-answer", "user", "assistant", "**New** branch", {
          __openclaw: { runId: "new-run" },
        }),
      ),
      storage.read({ type: "session.history.title", input: {} }, authority),
    ]);
    expect(title.fields).toEqual({
      firstUserMessage: "Question",
      lastMessagePreview: "New branch",
    });
    expect(
      await storage.read(
        { type: "session.history.preview", input: { maxItems: 2, maxChars: 80 } },
        authority,
      ),
    ).toEqual({
      kind: "session-preview",
      items: [
        { role: "user", text: "Question" },
        { role: "assistant", text: "**New** branch" },
      ],
    });
    expect(
      await storage.read({ type: "session.history.branches", input: {} }, authority),
    ).toMatchObject({
      status: "ok",
      branches: [
        { leafEntryId: "new-answer", headline: "**New** branch", messageCount: 2, active: true },
        { leafEntryId: "old-answer", headline: "Old branch", messageCount: 2, active: false },
      ],
    });
    expect(
      await storage.read(
        {
          type: "session.history.match",
          input: { match: { kind: "active-assistant", runId: "old-run" } },
        },
        authority,
      ),
    ).toEqual({ kind: "transcript-match", result: undefined });
    expect(
      await storage.read(
        {
          type: "session.history.match",
          input: { match: { kind: "idempotency", key: "old-result" } },
        },
        authority,
      ),
    ).toMatchObject({ result: { event: { id: "old-answer" } } });
    const latest = await storage.read(
      { type: "session.history.latest-active-message", input: {} },
      authority,
    );
    expect(latest).toMatchObject({ event: { id: "new-answer" }, eventSeq: 3, seq: 2 });
    const version = await storage.read(
      { type: "session.history.maintenance", input: { request: { operation: "version" } } },
      authority,
    );
    expect(version.appendParentId).toBe("new-answer");
    if (!version.version) {
      throw new Error("Expected transcript version");
    }
    expect(
      await storage.read(
        {
          type: "session.history.current-turn-entry",
          input: { entryId: "new-answer", version: version.version, includeEntry: true },
        },
        authority,
      ),
    ).toMatchObject({ anchor: { entryId: "new-answer", rawSeq: 3 }, event: { id: "new-answer" } });
    expect(
      await storage.read({ type: "session.history.watermark", input: {} }, authority),
    ).toMatchObject({ watermark: { maxSeq: 3 } });
    expect(
      await storage.read({ type: "session.history.message-presence", input: {} }, authority),
    ).toBe(true);
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
    const history = await storage.read(
      {
        type: "session.history.bounded-tail",
        input: { options: { maxBytes: 100_000, maxMessages: 20, offset: 0 } },
      },
      authority,
    );
    expect(history.events.map(({ event }) => event)).toEqual([
      keptUser,
      keptAssistant,
      fresh,
      answer,
    ]);
    expect(history.snapshot.boundarySeq).toBe(5);
    const accounting = await storage.read(
      {
        type: "session.history.accounting",
        input: { options: { includeByteSize: true, includeUsage: true } },
      },
      authority,
    );
    expect(accounting).toEqual({
      byteSize: [fresh, compaction, answer].reduce(
        (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)) + 1,
        0,
      ),
      eventCount: 3,
      usage: undefined,
    });
    const recent = await storage.read(
      { type: "session.history.recent-active-events", input: { maxEvents: 2 } },
      authority,
    );
    expect(recent).toEqual([compaction, answer]);
  });

  it("bounds detached tails without hiding an oversized gap or changing physical stats", async () => {
    const first = message("first", null, "user", "Short question");
    const large = message("large", "first", "assistant", "x".repeat(4000));
    const last = message("last", "large", "assistant", "Short answer");
    const { storage, transcriptEvents } = await fixture([first, large, last]);
    const page = await storage.read(
      {
        type: "session.history.bounded-tail",
        input: {
          options: {
            maxBytes: 1000,
            maxMessages: 3,
            offset: 0,
            oversizedMessageCheck: { roles: ["assistant"] },
          },
        },
      },
      authority,
    );
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
    expect(
      await storage.read({ type: "session.history.latest-assistant", input: {} }, authority),
    ).toMatchObject({ id: "last", text: "Short answer" });
    expect(
      await storage.read({ type: "session.history.stats", input: {} }, authority),
    ).toMatchObject({
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
      await storage.read(
        {
          type: "session.history.maintenance",
          input: {
            request: {
              operation: "suffix",
              startSeq: 2,
              maxBytes: 1000,
              maxEvents: 2,
              retainedCustomDataIds: ["opaque"],
            },
          },
        },
        authority,
      ),
    ).toEqual({ kind: "transcript-maintenance", events: [projected, answer] });
    await expect(
      storage.read(
        {
          type: "session.history.maintenance",
          input: {
            request: {
              operation: "suffix",
              startSeq: 2,
              maxBytes: 1000,
              maxEvents: 2,
              retainedCustomDataIds: [],
            },
          },
        },
        authority,
      ),
    ).rejects.toThrow("byte limit");
    expect(
      await storage.read(
        {
          type: "session.history.maintenance",
          input: { request: { operation: "previous", beforeSeq: 3 } },
        },
        authority,
      ),
    ).toEqual({ kind: "transcript-maintenance", previous: opaque });
    expect(
      await storage.read(
        {
          type: "session.history.maintenance",
          input: { request: { operation: "identity", eventId: "opaque" } },
        },
        authority,
      ),
    ).toEqual({ kind: "transcript-maintenance", seq: 2 });
  });
  it("checks current permission and writer authority before returning replay anchors", async () => {
    const { storage, acquire } = await fixture([message("user", null, "user", "Question")], {
      permissionMode: "full",
      lifecycleRevision: "life-1",
      activeWriterRunId: "writer-1",
    });
    const captured = await storage.read(
      {
        type: "session.history.anchors",
        input: {
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
        },
      },
      authority,
    );
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
    if (!anchor) {
      throw new Error("Expected input anchor");
    }
    expect(
      (
        await storage.mutate(
          {
            type: "session.entry.patch",
            input: {
              operation: {
                kind: "fields",
                patch: { permissionMode: "workspace", activeWriterRunId: "writer-2" },
              },
            },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    expect(
      await storage.read(
        {
          type: "session.history.anchors",
          input: {
            entryIds: ["user"],
            contextAuthority: { permissionMode: "full" },
            contextValidation: { through: anchor },
          },
        },
        authority,
      ),
    ).toMatchObject({
      anchors: [],
      contextAuthority: { entry: { permissionMode: "workspace", activeWriterRunId: "writer-2" } },
    });
    await expect(
      storage.read(
        {
          type: "session.history.anchors",
          input: {
            entryIds: ["user"],
            replayValidation: { allowInitial: false, expectedWriterRunId: "writer-1" },
          },
        },
        authority,
      ),
    ).rejects.toMatchObject({ name: "SessionTranscriptWriterClaimReboundError" });
    await expect(
      storage.read(
        {
          type: "session.history.anchors",
          input: {
            entryIds: ["user"],
            contextValidation: {
              through: anchor,
              expectedAuthority: { permissionMode: "full", lifecycleRevision: "life-1" },
            },
          },
        },
        authority,
      ),
    ).rejects.toThrow("changed lifecycle or permissions");
    const beforeReset = await storage.read({ type: "session.entry.read", input: {} }, authority);
    expect(
      (
        await storage.mutate(
          {
            type: "session.lifecycle.reset",
            input: {
              expected: beforeReset,
              nextEntry: {
                sessionId: "next-window",
                incognito: true,
                updatedAt: 2,
                permissionMode: "full",
              },
            },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    const retiredWindow = {
      type: "session.history.anchors" as const,
      input: { sessionId, entryIds: ["user"], contextAuthority: true as const },
    };
    await expect(storage.read(retiredWindow, authority)).rejects.toThrow("closed");
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
    const facts = await storage.read(
      {
        type: "session.history.anchors",
        input: {
          entryIds: ["user"],
          afterSeq: 1,
          includeMessagesForRunId: "target",
        },
      },
      authority,
    );
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
    if (!admitted) {
      throw new Error("Expected followup input anchor");
    }
    expect(
      await storage.read(
        {
          type: "session.history.anchors",
          input: {
            entryIds: ["user", "followup"],
            replayValidation: {
              allowInitial: false,
              admission: { ...admitted, role: "user", logicalTurnId: "turn-2" },
            },
          },
        },
        authority,
      ),
    ).toMatchObject({ replayValidated: "current", anchors: [{ entryId: "user" }] });
  });
});
