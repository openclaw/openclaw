import "./session-actor-memory-native-guards.test-support.js";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  authority,
  header as sessionHeader,
  memoryFixture,
  messageEvent,
  expectMatch,
} from "./session-actor-memory-fixture.test-support.js";
import {
  readMemory,
  commitMemory,
  mutateMemory,
} from "./session-actor-memory-publication.test-support.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";

const sessionKey = "agent:main:dashboard:incognito-metadata";
const sessionId = "session-1";
const scope = { agentId: "main", storePath: "/synthetic/metadata", sessionKey, sessionId };
const header =
  '{ "type": "session", "version": 3, "id": "session-1", "timestamp": "1970-01-01T00:00:00.000Z", "cwd": "/synthetic" }';

afterEach(() => vi.useRealTimers());

async function fixture(initialText?: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  const f = await memoryFixture(scope);
  await f.initialize({ sessionId, updatedAt: 1, incognito: true });
  const raw = f.appendRaw;
  const user = (id: string, content: string) =>
    f.appendMessage(
      messageEvent(id, null, { role: "user", content, timestamp: 2 }, "1970-01-01T00:00:00.002Z"),
      { appendIntent: "active-branch" },
    );
  if (initialText !== undefined) {
    await raw(header);
    await user("user-1", initialText);
  }
  return { ...f, raw, user };
}

it("initializes without a fabricated message and preserves prepared bytes across append/read", async () => {
  const { actor, storage, raw, hydrate } = await fixture();
  expect((await hydrate()).events).toEqual([]);
  await raw(header);
  const messageJson = '{ "role": "user", "content": "Prepared bytes", "timestamp": 2 }';
  const appended = await commitMemory(storage, "session.transcript.appendMessage", {
    scope,
    messageJson,
    cwd: "/synthetic",
  });
  expect(appended.snapshot).toMatchObject({ ok: true, value: { result: { appended: true } } });
  const read = await hydrate();
  expect(read.eventJson?.[0]).toBe(header);
  expect(read.eventJson?.[1]).toContain(`"message":${messageJson}}`);
  expect(actor.snapshot(authority)?.transcript.anchors).toHaveLength(1);
  expect(await readMemory(storage, "session.metadata.mutation", { scope })).toBeGreaterThan(1000);
  assert(read.events[1] && typeof read.events[1] === "object", "Expected message");
  Object.assign(read.events[1], { id: "changed-returned-copy" });
  expect((await hydrate()).events).not.toContainEqual(
    expect.objectContaining({ id: "changed-returned-copy" }),
  );
});

it("refuses a prepared rewrite after a phase append and preserves the original branch bytes", async () => {
  const { actor, storage, hydrate, phase } = await fixture("First");
  const before = await hydrate();
  const source = before.events.find(
    (event) => isIndexedSessionEntry(event) && event.id === "user-1",
  );
  assert(isIndexedSessionEntry(source) && source.type === "message", "Expected source message");
  const copied = { ...source, id: "copied-user", parentId: null };
  const input = {
    scope,
    appendParentId: "user-1",
    version: before.version,
    entries: [copied],
    sources: [[copied.id, source] as [string, typeof source]],
  };
  const appended = await phase("intervene", [
    { message: { role: "assistant", content: "Intervening" }, eventId: "assistant-1" },
  ]);
  expect(appended.kind).toBe("committed");
  await expectMatch(mutateMemory(storage, "session.transcript.rewrite", input), {
    kind: "rolled-back",
    error: { message: "Session transcript changed before rewrite publication" },
  });
  const current = await hydrate();
  const rewritten = await commitMemory(storage, "session.transcript.rewrite", {
    ...input,
    appendParentId: "assistant-1",
    version: current.version,
  });
  expect(rewritten.version.generation).toBe(current.version.generation);
  const after = await hydrate();
  expect(after.eventJson?.slice(0, current.events.length)).toEqual(current.eventJson);
  expect(after.events.at(-1)).toMatchObject({ id: "copied-user", message: { content: "First" } });
  expect(actor.snapshot(authority)?.transcript.anchors.map((anchor) => anchor.entryId)).toEqual([
    "copied-user",
  ]);
  const side = { ...source, id: "side-copy", parentId: "copied-user", appendMode: "side" as const };
  await commitMemory(storage, "session.transcript.rewrite", {
    scope,
    appendParentId: "copied-user",
    version: after.version,
    entries: [side],
    sources: [[side.id, source]],
  });
  expect((await hydrate()).events.at(-1)).toMatchObject({ id: "side-copy", appendMode: "side" });
  expect(actor.snapshot(authority)?.transcript.anchors.map((anchor) => anchor.entryId)).toEqual([
    "copied-user",
  ]);
});

it("replaces only an exact suffix, preserves opaque custom data, and invalidates old cursors", async () => {
  const { storage, raw, user, hydrate } = await fixture("Keep");
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
  const before = await hydrate();
  const custom = before.events.find(
    (event) => isIndexedSessionEntry(event) && event.id === "opaque",
  );
  assert(isIndexedSessionEntry(custom) && custom.type === "custom", "Expected custom entry");
  const { data: _data, ...navigation } = custom;
  const expected = [navigation, before.events.at(-1)];
  const next = [{ ...navigation, parentId: null }];
  const result = await commitMemory(storage, "session.transcript.replaceSuffix", {
    scope,
    args: [expected, next, 2, before.version.updatedAt, true, ["opaque"]],
  });
  expect(result.replaced).toBe(true);
  expect(result.version?.generation).not.toBe(before.version.generation);
  const after = await hydrate();
  expect(after.eventJson?.slice(0, 2)).toEqual(before.eventJson?.slice(0, 2));
  expect(after.events.at(-1)).toMatchObject({
    id: "opaque",
    parentId: null,
    data: { text: "x".repeat(20_000) },
  });
  await expectMatch(
    mutateMemory(storage, "session.transcript.replaceSuffix", {
      scope,
      args: [after.events, after.events.slice(0, -1), 0, before.version.updatedAt, false, []],
    }),
    { kind: "rolled-back" },
  );
  expect((await hydrate()).eventJson).toEqual(after.eventJson);
});

it("retains an old window across branch replacement and commits compaction accounting atomically", async () => {
  const { storage, acquire, hydrate } = await fixture("Old window");
  const before = await hydrate();
  const branchId = "branched-session";
  const branchHeader = sessionHeader(branchId, "1970-01-01T00:00:00.000Z");
  const branched = await commitMemory(storage, "session.transcript.branch", {
    scope,
    expectedLifecycleRevision: undefined,
    branch: { sessionId: branchId, events: [branchHeader] },
  });
  expect(branched.identity.current.get(sessionKey)?.sessionId).toBe(branchId);
  const next = await acquire();
  expect((await next.hydrate(sessionId)).eventJson).toEqual(before.eventJson);
  const branchScope = { ...scope, sessionId: branchId };
  const latch = { sessionId: branchId, activeBytes: 10_000, maxBytes: 4096 };
  const compacted = await commitMemory(next.storage, "session.transcript.compactionBoundary", {
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
  });
  expect(compacted.committed.result.id).toBe("compact-1");
  expect(next.actor.snapshot(authority)?.entry).toMatchObject({
    compactionCount: 1,
    compactionQualityDegraded: true,
    totalTokensFresh: false,
    transcriptByteCompactionLatch: latch,
  });
  expect((await next.hydrate(branchId)).events.at(-1)).toMatchObject({
    id: "compact-1",
    summary: "Summary",
  });
  await expectMatch(
    mutateMemory(next.storage, "session.transcript.compactionBoundary", {
      scope: branchScope,
      prepared: { scope: branchScope, event: compacted.committed.result },
      transcriptByteCompactionLatch: latch,
    }),
    { kind: "rolled-back" },
  );
  expect(next.actor.snapshot(authority)?.entry?.compactionCount).toBe(1);
});
