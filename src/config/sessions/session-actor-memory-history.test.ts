import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";

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
  content: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "message",
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

async function fixture(events: unknown[]) {
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
    throw new Error("Expected memory storage");
  }
  expect(
    (
      await storage.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: { sessionId, incognito: true, updatedAt: 1 },
            transcriptEvents: [
              { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
              ...events,
            ],
          },
        },
        authority,
      )
    ).kind,
  ).toBe("committed");
  const append = async (event: unknown) => {
    expect(
      (
        await storage.mutate(
          {
            type: "session.metadata.append",
            input: {
              scope: { agentId: "main", sessionKey, sessionId, storePath },
              event: JSON.stringify(event),
              options: {},
            },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
  };
  return { owner, actor, storage, append, acquire };
}

describe("memory actor history", () => {
  it("keeps raw progress distinct from the active branch and publishes phase writes before reads", async () => {
    const { actor, storage } = await fixture([
      message("user", null, "user", "Question"),
      message("old", "user", "assistant", "Old branch"),
    ]);
    const raw = await storage.read(
      { type: "session.history.raw-delta", input: { limits: {} } },
      authority,
    );
    const visible = await storage.read(
      { type: "session.history.visible-delta", input: { limits: {} } },
      authority,
    );
    if (raw.kind !== "page" || visible.kind !== "page") {
      throw new Error("Expected initial pages");
    }
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
      storage.read(
        { type: "session.history.recent", input: { options: { maxMessages: 10 } } },
        authority,
      ),
    ]);
    expect(write.kind).toBe("committed");
    expect(messageIds(page.messages)).toEqual(["user", "new"]);
    expect(
      await storage.read(
        { type: "session.history.visible-delta", input: { limits: { cursor: visible.cursor } } },
        authority,
      ),
    ).toMatchObject({ kind: "reset", reason: "anchor_missing" });
    const next = await storage.read(
      { type: "session.history.raw-delta", input: { limits: { cursor: raw.cursor } } },
      authority,
    );
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
    expect(await storage.read({ type: "session.history.count", input: {} }, authority)).toBe(2);
    const current = await storage.read(
      {
        type: "session.history.recent",
        input: { options: { maxMessages: 10, captureReadWindow: true } },
      },
      authority,
    );
    expect(messageIds(current.messages)).toEqual(["reset", "current"]);
    const historical = await storage.read(
      {
        type: "session.history.around-id",
        input: {
          options: {
            messageId: "reset",
            closedResetInterval: true,
            direction: "older",
            maxMessages: 10,
          },
        },
      },
      authority,
    );
    expect(messageIds(historical.messages)).toEqual(["old-user", "old-answer"]);
    expect(
      await storage.read(
        {
          type: "session.history.by-id",
          input: { messageId: "old-answer", options: { currentOnly: true, maxBytes: 10000 } },
        },
        authority,
      ),
    ).toEqual({ found: false, oversized: false });
    expect(
      await storage.read(
        { type: "session.history.by-id", input: { messageId: "old-answer" } },
        authority,
      ),
    ).toMatchObject({ found: true, seq: 2 });
    if (isRecord(current.messages[1])) {
      current.messages[1].content = "caller mutation";
    }
    await append(message("new-answer", "current", "assistant", "Latest"));
    const after = await storage.read(
      {
        type: "session.history.page",
        input: { options: { offset: 0, maxMessages: 10, expectedReadWindow: current.readWindow } },
      },
      authority,
    );
    expect(after.windowReset).toBeUndefined();
    expect(after.messages).toContainEqual(expect.objectContaining({ content: "Current" }));
  });

  it("sizes pages before copying and makes progress past oversized history", async () => {
    const large = message("large", "small", "assistant", "x".repeat(20000));
    const { storage } = await fixture([message("small", null, "user", "Small"), large]);
    expect(
      await storage.read(
        {
          type: "session.history.by-id",
          input: { messageId: "missing", options: { currentOnly: true, maxBytes: 1024 } },
        },
        authority,
      ),
    ).toEqual({ found: false, oversized: false });
    expect(
      await storage.read(
        {
          type: "session.history.by-id",
          input: { messageId: "large", options: { currentOnly: true, maxBytes: 1024 } },
        },
        authority,
      ),
    ).toEqual({
      found: true,
      oversized: true,
      seq: 2,
      serializedBytes: Buffer.byteLength(JSON.stringify(large)),
    });
    expect(
      await storage.read(
        {
          type: "session.history.by-id",
          input: { messageId: "small", options: { currentOnly: true, maxBytes: 1024 } },
        },
        authority,
      ),
    ).toMatchObject({ found: true, oversized: false, message: { content: "Small" } });
    const page = await storage.read(
      {
        type: "session.history.page",
        input: { options: { offset: 0, maxMessages: 2, maxBytes: 1024 } },
      },
      authority,
    );
    expect(page).toMatchObject({
      messages: [],
      omittedOversized: true,
      olderOffset: 1,
      totalMessages: 2,
    });
    const older = await storage.read(
      {
        type: "session.history.page",
        input: { options: { offset: page.olderOffset!, maxMessages: 2, maxBytes: 1024 } },
      },
      authority,
    );
    expect(messageIds(older.messages)).toEqual(["small"]);
    const raw = await storage.read(
      { type: "session.history.raw-delta", input: { limits: { maxEvents: 2 } } },
      authority,
    );
    if (raw.kind !== "page") {
      throw new Error("Expected raw page");
    }
    expect(
      await storage.read(
        {
          type: "session.history.raw-delta",
          input: { limits: { cursor: raw.cursor, maxBytes: 1024 } },
        },
        authority,
      ),
    ).toMatchObject({ kind: "page", events: [], hasMore: true, requiredBytes: expect.any(Number) });
    await expect(
      storage.read({ type: "session.history.hydrate", input: { maxEventBytes: 1024 } }, authority),
    ).rejects.toThrow("too large to export");
  });

  it("retains historical sessionId windows across rotation and removes them with the logical session", async () => {
    const { storage, acquire } = await fixture([message("old", null, "user", "Preserved history")]);
    const expected = await storage.read({ type: "session.entry.read", input: {} }, authority);
    expect(
      (
        await storage.mutate(
          {
            type: "session.lifecycle.reset",
            input: {
              expected,
              nextEntry: { sessionId: "window-two", incognito: true, updatedAt: 2 },
            },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    const next = await acquire();
    if (!next.storage) {
      throw new Error("Expected memory storage");
    }
    const old = await next.storage.read(
      { type: "session.history.hydrate", input: { sessionId } },
      authority,
    );
    expect(ids(old.snapshot.events)).toEqual([sessionId, "old"]);
    expect(
      (await next.storage.read({ type: "session.history.hydrate", input: {} }, authority)).snapshot
        .events,
    ).toEqual([]);
    expect(
      (await next.storage.mutate({ type: "session.lifecycle.delete", input: {} }, authority)).kind,
    ).toBe("committed");
    const fresh = await acquire();
    await expect(
      fresh.storage!.read({ type: "session.history.hydrate", input: { sessionId } }, authority),
    ).rejects.toThrow("unavailable");
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
    const context = await storage.read(
      { type: "session.history.context", input: { limits: { maxBytes: 4096, maxEvents: 8 } } },
      authority,
    );
    expect(JSON.stringify(context.events)).not.toContain("old-body-");
    expect(JSON.stringify(context.events)).not.toContain("private-prompt");
    const unbounded = await storage.read({ type: "session.history.context", input: {} }, authority);
    expect(JSON.stringify(unbounded.events)).not.toContain("old-body-");
    const full = await storage.read({ type: "session.history.hydrate", input: {} }, authority);
    expect(full.kind).toBe("full");
    if (full.kind !== "full") {
      throw new Error("Expected full hydration");
    }
    expect(full.snapshot.events.slice(1)).toEqual(events);
    expect(full.snapshot.eventJson?.slice(1)).toEqual(events.map((event) => JSON.stringify(event)));
    const anchor = actor
      .snapshot(authority)!
      .transcript.anchors.find((candidate) => candidate.entryId === "new")!;
    const admitted = await storage.read(
      {
        type: "session.history.hydrate",
        input: { admission: { ...anchor, role: "user", logicalTurnId: "turn" } },
      },
      authority,
    );
    expect(ids(admitted.snapshot.events)).not.toContain("new");
  });
});
