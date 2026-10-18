import { assert, expect, it } from "vitest";
import {
  authority,
  header,
  memoryFixture,
  messageEvent,
  expectEqual,
} from "./session-actor-memory-fixture.test-support.js";
import type { SessionActorMemoryForkWrites } from "./session-actor-memory-fork-contract.js";
import {
  committedMemoryResult as committed,
  mutateMemory,
} from "./session-actor-memory-publication.test-support.js";
import type { SessionActorStorageAuthority } from "./session-actor-storage-contract.js";
import type { SessionMessageCutIntent } from "./session-message-cut.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const parentKey = "agent:main:dashboard:incognito-fork-parent";
const childKey = "agent:main:dashboard:incognito-fork-child";
const storePath = "/synthetic/incognito-forks";
const forkAuthority: SessionActorStorageAuthority = {
  ...authority,
  parentFork: { supportsCliFork: (provider) => provider === "claude" },
};
const expectedState = { sessionId: "parent-session", lifecycleRevision: "parent-lifecycle" };
const cutIntent: SessionMessageCutIntent = {
  canonicalSourceKey: parentKey,
  sourceKey: parentKey,
  targetKey: parentKey,
  entryId: "u2",
  expectedState,
  mode: "rewind",
};
const cliBindings = (resumeCheckpointId: string) => ({
  claude: { sessionId: "cli-parent", resumeCheckpointId, forceReuse: true },
});
const message = (id: string, parentId: string | null, second: number, body: object) =>
  messageEvent(id, parentId, body, `2026-01-01T00:00:0${second}.000Z`);
const transcript = [
  header("parent-session", "2026-01-01T00:00:00.000Z"),
  message("u1", null, 1, { role: "user", content: "First question" }),
  message("a1", "u1", 2, { role: "assistant", content: "First answer", stopReason: "stop" }),
  message("u2", "a1", 3, {
    role: "user",
    content: [
      { type: "text", text: "Edit this" },
      { type: "image", mimeType: "image/png", data: "c3ludGhldGlj" },
    ],
  }),
  message("a2", "u2", 4, { role: "assistant", content: "Second answer", stopReason: "stop" }),
];

async function fixture(entry: Partial<SessionEntry> = {}) {
  const base = await memoryFixture({
    agentId: "main",
    storePath,
    sessionKey: parentKey,
    sessionId: expectedState.sessionId,
  });
  const wrap = (f: Pick<typeof base, "read" | "commit" | "storage" | "hydrate">) => ({
    ...f,
    fork: (
      input: SessionActorMemoryForkWrites["session.parentFork.commit"]["input"],
      auth: SessionActorStorageAuthority = authority,
    ) => mutateMemory(f.storage, "session.parentFork.commit", input, auth),
    source: () => f.read("session.parentFork.source", {}),
    cut: (intent: SessionMessageCutIntent) => f.commit("session.messageCut", { intent }),
  });
  const acquire = async (key = parentKey) => wrap(await base.acquire(key));
  const parent = wrap(base);
  await parent.commit("session.entry.create", {
    entry: { ...expectedState, updatedAt: 1, incognito: true, ...entry },
    transcriptEvents: transcript,
  });
  const child = await acquire(childKey);
  const forkInput = {
    kind: "entry" as const,
    params: {
      parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
      sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
      fallbackEntry: { sessionId: "child-seed", updatedAt: 1, incognito: true as const },
    },
  };
  return { acquire, parent, child, forkInput };
}

it("forks the latest in-process bindings and detaches copied transcript results", async () => {
  const { parent, child, forkInput } = await fixture({
    cliSessionBindings: cliBindings("old-checkpoint"),
  });
  const patch = parent.commit("session.entry.patch", {
    operation: {
      kind: "fields",
      patch: { cliSessionBindings: cliBindings("new-checkpoint") },
    },
  });
  const fork = child.fork(forkInput, forkAuthority);
  await patch;
  const result = committed(await fork);
  assert(result.status === "forked", "Fork failed");
  expect(result.sessionEntry).toMatchObject({
    incognito: true,
    forkSource: { sessionKey: parentKey, sessionId: "parent-session" },
    cliSessionBindings: {
      claude: {
        sessionId: "cli-parent",
        resumeCheckpointId: "new-checkpoint",
        forkNextResume: true,
      },
    },
  });
  expect(result.sessionEntry.cliSessionBindings?.claude?.forceReuse).toBeUndefined();
  const copied = await child.source();
  expect(copied?.branchEntries).toHaveLength(4);
  copied?.branchEntries.splice(0);
  const source = await parent.source();
  const reread = await child.source();
  expect(source?.branchEntries).toHaveLength(4);
  expect(reread?.branchEntries).toHaveLength(4);
});

it("does not inherit CLI bindings without host fork support", async () => {
  const { child, forkInput } = await fixture({ cliSessionBindings: cliBindings("checkpoint") });
  const result = committed(await child.fork(forkInput));
  assert(result.status === "forked", "Fork failed");
  expect(result.sessionEntry.cliSessionBindings).toBeUndefined();
});

it("rewinds and switches branches while retaining the original window and rejecting old identity", async () => {
  const { parent, acquire } = await fixture();
  const rewind = await parent.cut(cutIntent);
  expect(rewind).toMatchObject({
    status: "created",
    editorText: "Edit this",
    editorAttachments: [{ mimeType: "image/png", data: "c3ludGhldGlj" }],
  });
  assert(rewind.status === "created", "Rewind failed");
  await expect(async () => parent.read("session.entry.read", {})).rejects.toThrow(/closed/);
  const active = await acquire();
  const old = await active.hydrate("parent-session");
  expect(old.events).toEqual(transcript);
  const branch = await active.source();
  expect(branch?.branchEntries).toHaveLength(2);
  await expectEqual(active.cut(cutIntent), { status: "conflict" });
  const switched = await active.cut({
    ...cutIntent,
    mode: "switch",
    entryId: "a2",
    expectedState: {
      sessionId: rewind.entry.sessionId,
      lifecycleRevision: rewind.entry.lifecycleRevision,
    },
  });
  expect(switched.status).toBe("created");
  const restored = await acquire();
  expect((await restored.source())?.branchEntries).toHaveLength(4);
});

it("forks only the prefix before a user message and preserves source identity", async () => {
  const { parent, child } = await fixture({
    thinkingLevel: "high",
    cliSessionIds: { claude: "old-cli" },
    totalTokens: 50,
  });
  const result = await child.cut({
    ...cutIntent,
    targetKey: childKey,
    mode: "fork",
    creation: { via: "operator" },
  });
  expect(result).toMatchObject({
    status: "created",
    editorText: "Edit this",
    entry: { incognito: true, thinkingLevel: "high", createdVia: "operator" },
  });
  assert(result.status === "created", "Message fork failed");
  expect(result.entry.cliSessionIds).toBeUndefined();
  expect(result.entry.totalTokens).toBeUndefined();
  expect((await child.source())?.branchEntries).toHaveLength(2);
  expect((await parent.read("session.entry.read", {}))?.sessionId).toBe("parent-session");
  expect((await parent.source())?.branchEntries).toHaveLength(4);
});

it("does not publish a child when authority refuses the source copy", async () => {
  const { child, forkInput } = await fixture();
  const denied: SessionActorStorageAuthority = {
    ...forkAuthority,
    authorize(_stage, facts) {
      if (facts.target.sessionKey === parentKey) {
        throw new Error("Source access revoked");
      }
    },
  };
  const result = await child.fork(forkInput, denied);
  expect(result).toMatchObject({
    kind: "rolled-back",
    error: { message: "Source access revoked" },
  });
  expect(await child.read("session.entry.read", {})).toBeUndefined();
});
