import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActorAuthority, SessionActorStorage } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import type { SessionActorStorageOutcome } from "./session-actor-storage-contract.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory metadata opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory metadata allocated a worker");
  }),
}));

const sessionKey = "agent:main:dashboard:incognito-metadata";
const sessionId = "session-1";
const scope = { agentId: "main", storePath: "/synthetic/metadata", sessionKey, sessionId };
const authority: SessionActorAuthority = { authorize() {}, assertCurrent() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
const header =
  '{ "type": "session", "version": 3, "id": "session-1", "timestamp": "1970-01-01T00:00:00.000Z", "cwd": "/synthetic" }';

afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
  vi.useRealTimers();
});

function committed<T>(outcome: SessionActorStorageOutcome<T>) {
  if (outcome.kind !== "committed") {
    throw new Error(JSON.stringify(outcome));
  }
  return outcome.value;
}

async function hydrate(storage: SessionActorStorage, selectedId = sessionId) {
  const result = await storage.read(
    { type: "session.history.hydrate", input: { sessionId: selectedId } },
    authority,
  );
  if (result.kind !== "full") {
    throw new Error("Expected full memory history");
  }
  return result.snapshot;
}

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  const owner = createMemorySessionActorOwner({ agentId: scope.agentId, path: scope.storePath });
  owners.push(owner);
  const acquire = async () => {
    const actor = await owner.acquire(
      { database: owner.identity, sessionKey },
      { assertCurrent() {}, assertReadable() {} },
    );
    if (!actor.storage) {
      throw new Error("Missing memory storage");
    }
    return { actor, storage: actor.storage };
  };
  const { actor, storage } = await acquire();
  committed(
    await storage.mutate(
      {
        type: "session.metadata.initialize",
        input: { scope, entry: { sessionId, updatedAt: 1, incognito: true } },
      },
      authority,
    ),
  );
  const raw = async (event: string) =>
    committed(
      await storage.mutate(
        { type: "session.metadata.append", input: { scope, event, options: {} } },
        authority,
      ),
    );
  const user = async (id: string, text: string) => {
    const event = {
      type: "message" as const,
      id,
      parentId: null,
      timestamp: "1970-01-01T00:00:00.002Z",
    };
    return committed(
      await storage.mutate(
        {
          type: "session.metadata.append",
          input: {
            scope,
            event,
            options: { appendIntent: "active-branch" },
            message: {
              messageJson: JSON.stringify({ role: "user", content: text, timestamp: 2 }),
              cwd: "/synthetic",
              validateTurn: false,
            },
          },
        },
        authority,
      ),
    );
  };
  return { owner, actor, storage, raw, user, acquire };
}

describe("memory actor metadata storage", () => {
  it("initializes without a fabricated message and preserves prepared bytes across append/read", async () => {
    const { actor, storage, raw } = await fixture();
    expect((await hydrate(storage)).events).toEqual([]);
    await raw(header);
    const messageJson = '{ "role": "user", "content": "Prepared bytes", "timestamp": 2 }';
    const appended = committed(
      await storage.mutate(
        {
          type: "session.transcript.appendMessage",
          input: { scope, messageJson, cwd: "/synthetic" },
        },
        authority,
      ),
    );
    expect(appended.snapshot).toMatchObject({ ok: true, value: { result: { appended: true } } });
    const read = await hydrate(storage);
    expect(read.eventJson?.[0]).toBe(header);
    expect(read.eventJson?.[1]).toContain(`"message":${messageJson}}`);
    expect(actor.snapshot(authority)?.transcript.anchors).toHaveLength(1);
    expect(
      await storage.read({ type: "session.metadata.mutation", input: { scope } }, authority),
    ).toBeGreaterThan(1000);
    if (!read.events[1] || typeof read.events[1] !== "object") {
      throw new Error("Expected message");
    }
    Object.assign(read.events[1], { id: "changed-returned-copy" });
    expect((await hydrate(storage)).events).not.toContainEqual(
      expect.objectContaining({ id: "changed-returned-copy" }),
    );
  });

  it("refuses a prepared rewrite after a phase append and preserves the original branch bytes", async () => {
    const { actor, storage, raw, user } = await fixture();
    await raw(header);
    await user("user-1", "First");
    const before = await hydrate(storage);
    const source = before.events.find(
      (event) => isIndexedSessionEntry(event) && event.id === "user-1",
    );
    if (!isIndexedSessionEntry(source) || source.type !== "message") {
      throw new Error("Expected source message");
    }
    const copied = { ...source, id: "copied-user", parentId: null };
    const input = {
      scope,
      appendParentId: "user-1",
      version: before.version,
      entries: [copied],
      sources: [[copied.id, source] as [string, typeof source]],
    };
    const appended = await actor.appendToolResult(
      {
        commandId: "intervene",
        phaseId: "turn",
        turn: {
          agentId: scope.agentId,
          sessionKey,
          options: {
            expectedSessionId: sessionId,
            messages: [
              { message: { role: "assistant", content: "Intervening" }, eventId: "assistant-1" },
            ],
          },
        },
      },
      authority,
    );
    expect(appended.kind).toBe("committed");
    expect(
      await storage.mutate({ type: "session.transcript.rewrite", input }, authority),
    ).toMatchObject({
      kind: "rolled-back",
      error: { message: "Session transcript changed before rewrite publication" },
    });
    const current = await hydrate(storage);
    const rewritten = committed(
      await storage.mutate(
        {
          type: "session.transcript.rewrite",
          input: { ...input, appendParentId: "assistant-1", version: current.version },
        },
        authority,
      ),
    );
    expect(rewritten.version.generation).toBe(current.version.generation);
    const after = await hydrate(storage);
    expect(after.eventJson?.slice(0, current.events.length)).toEqual(current.eventJson);
    expect(after.events.at(-1)).toMatchObject({ id: "copied-user", message: { content: "First" } });
    expect(actor.snapshot(authority)?.transcript.anchors.map((anchor) => anchor.entryId)).toEqual([
      "copied-user",
    ]);
    const side = {
      ...source,
      id: "side-copy",
      parentId: "copied-user",
      appendMode: "side" as const,
    };
    committed(
      await storage.mutate(
        {
          type: "session.transcript.rewrite",
          input: {
            scope,
            appendParentId: "copied-user",
            version: after.version,
            entries: [side],
            sources: [[side.id, source]],
          },
        },
        authority,
      ),
    );
    expect((await hydrate(storage)).events.at(-1)).toMatchObject({
      id: "side-copy",
      appendMode: "side",
    });
    expect(actor.snapshot(authority)?.transcript.anchors.map((anchor) => anchor.entryId)).toEqual([
      "copied-user",
    ]);
  });

  it("replaces only an exact suffix, preserves opaque custom data, and invalidates old cursors", async () => {
    const { storage, raw, user } = await fixture();
    await raw(header);
    await user("user-1", "Keep");
    await raw(
      JSON.stringify({
        type: "custom",
        id: "opaque",
        parentId: "user-1",
        timestamp: "1970-01-01T00:00:00.003Z",
        customType: "opaque",
        data: { text: "x".repeat(20_000) },
      }),
    );
    await user("user-2", "Remove");
    const before = await hydrate(storage);
    const custom = before.events.find(
      (event) => isIndexedSessionEntry(event) && event.id === "opaque",
    );
    if (!isIndexedSessionEntry(custom) || custom.type !== "custom") {
      throw new Error("Expected custom entry");
    }
    const { data: _data, ...navigation } = custom;
    const expected = [navigation, before.events.at(-1)];
    const next = [{ ...navigation, parentId: null }];
    const result = committed(
      await storage.mutate(
        {
          type: "session.transcript.replaceSuffix",
          input: { scope, args: [expected, next, 2, before.version.updatedAt, true, ["opaque"]] },
        },
        authority,
      ),
    );
    expect(result.replaced).toBe(true);
    expect(result.version?.generation).not.toBe(before.version.generation);
    const after = await hydrate(storage);
    expect(after.eventJson?.slice(0, 2)).toEqual(before.eventJson?.slice(0, 2));
    expect(after.events.at(-1)).toMatchObject({
      id: "opaque",
      parentId: null,
      data: { text: "x".repeat(20_000) },
    });
    expect(
      await storage.mutate(
        {
          type: "session.transcript.replaceSuffix",
          input: {
            scope,
            args: [after.events, after.events.slice(0, -1), 0, before.version.updatedAt, false, []],
          },
        },
        authority,
      ),
    ).toMatchObject({ kind: "rolled-back" });
    expect((await hydrate(storage)).eventJson).toEqual(after.eventJson);
  });

  it("retains an old window across branch replacement and commits compaction accounting atomically", async () => {
    const { storage, raw, user, acquire } = await fixture();
    await raw(header);
    await user("user-1", "Old window");
    const before = await hydrate(storage);
    const branchId = "branched-session";
    const branchHeader = {
      type: "session",
      version: 3,
      id: branchId,
      timestamp: "1970-01-01T00:00:00.000Z",
      cwd: "/synthetic",
    };
    const branched = committed(
      await storage.mutate(
        {
          type: "session.transcript.branch",
          input: {
            scope,
            expectedLifecycleRevision: undefined,
            branch: { sessionId: branchId, events: [branchHeader] },
          },
        },
        authority,
      ),
    );
    expect(branched.identity.current.get(sessionKey)?.sessionId).toBe(branchId);
    const next = await acquire();
    expect((await hydrate(next.storage, sessionId)).eventJson).toEqual(before.eventJson);
    const branchScope = { ...scope, sessionId: branchId };
    const latch = { sessionId: branchId, activeBytes: 10_000, maxBytes: 4096 };
    const compacted = committed(
      await next.storage.mutate(
        {
          type: "session.transcript.compactionBoundary",
          input: {
            scope: branchScope,
            prepared: {
              scope: branchScope,
              event: {
                type: "compaction",
                id: "compact-1",
                parentId: null,
                timestamp: "1970-01-01T00:00:00.004Z",
                summary: "Summary",
                firstKeptEntryId: "",
                tokensBefore: 1000,
                details: { readFiles: [], modifiedFiles: [], qualityDegraded: true },
              },
            },
            transcriptByteCompactionLatch: latch,
          },
        },
        authority,
      ),
    );
    expect(compacted.committed.result.id).toBe("compact-1");
    expect(next.actor.snapshot(authority)?.entry).toMatchObject({
      compactionCount: 1,
      compactionQualityDegraded: true,
      totalTokensFresh: false,
      transcriptByteCompactionLatch: latch,
    });
    expect((await hydrate(next.storage, branchId)).events.at(-1)).toMatchObject({
      id: "compact-1",
      summary: "Summary",
    });
    expect(
      await next.storage.mutate(
        {
          type: "session.transcript.compactionBoundary",
          input: {
            scope: branchScope,
            prepared: { scope: branchScope, event: compacted.committed.result },
            transcriptByteCompactionLatch: latch,
          },
        },
        authority,
      ),
    ).toMatchObject({ kind: "rolled-back" });
    expect(next.actor.snapshot(authority)?.entry?.compactionCount).toBe(1);
  });
});
