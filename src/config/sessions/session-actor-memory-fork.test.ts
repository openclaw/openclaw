import { afterEach, assert, describe, expect, it } from "vitest";
import type { SessionActor, SessionActorAuthority } from "./session-actor-contract.js";
import type { SessionActorMemoryForkWrites } from "./session-actor-memory-fork-contract.js";
import {
  commitMemory,
  committedMemoryResult as committed,
  memoryStorage,
  mutateMemory,
  readMemory,
} from "./session-actor-memory-publication.test-support.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import type { SessionActorStorageAuthority } from "./session-actor-storage-contract.js";
import type { SessionMessageCutIntent } from "./session-message-cut.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const parentKey = "agent:main:dashboard:incognito-fork-parent";
const childKey = "agent:main:dashboard:incognito-fork-child";
const storePath = "/synthetic/incognito-forks";
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const forkAuthority: SessionActorStorageAuthority = {
  ...authority,
  parentFork: { supportsCliFork: (provider) => provider === "claude" },
};
const lifetime = { assertCurrent() {}, assertReadable() {} };
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
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

function storage(actor: SessionActor) {
  assert(actor.storage, "Memory actor storage is missing");
  const raw = actor.storage;
  return {
    ...memoryStorage(raw),
    fork: (
      input: SessionActorMemoryForkWrites["session.parentFork.commit"]["input"],
      auth = authority,
    ) => mutateMemory(raw, "session.parentFork.commit", input, auth),
    source: () => readMemory(raw, "session.parentFork.source", {}),
    cut: (intent: SessionMessageCutIntent) => commitMemory(raw, "session.messageCut", { intent }),
  };
}

const message = (id: string, parentId: string | null, second: number, body: object) => ({
  type: "message",
  id,
  parentId,
  timestamp: `2026-01-01T00:00:0${second}.000Z`,
  message: body,
});
const transcript = [
  {
    type: "session",
    id: "parent-session",
    version: 3,
    cwd: "/synthetic",
    timestamp: "2026-01-01T00:00:00.000Z",
  },
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
  const owner = createMemorySessionActorOwner({ agentId: "main", path: storePath });
  owners.push(owner);
  const acquire = (sessionKey = parentKey) =>
    owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const parent = storage(await acquire());
  await parent.commit("session.entry.create", {
    entry: {
      ...expectedState,
      updatedAt: 1,
      incognito: true,
      ...entry,
    },
    transcriptEvents: transcript,
  });
  const child = storage(await acquire(childKey));
  const forkInput = {
    kind: "entry" as const,
    params: {
      parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
      sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
      fallbackEntry: { sessionId: "child-seed", updatedAt: 1, incognito: true as const },
    },
  };
  return { owner, acquire, parent, child, forkInput };
}

describe("memory actor fork and cut", () => {
  it("forks the latest in-process bindings and detaches copied transcript results", async () => {
    const { parent, child, forkInput } = await fixture({
      cliSessionBindings: cliBindings("old-checkpoint"),
    });
    const patch = parent.commit("session.entry.patch", {
      operation: {
        kind: "fields",
        patch: {
          cliSessionBindings: cliBindings("new-checkpoint"),
        },
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
    const active = storage(await acquire());
    const old = await active.read("session.history.hydrate", {
      sessionId: "parent-session",
    });
    assert(old.kind === "full", "Expected full history");
    expect(old.snapshot.events).toEqual(transcript);
    const branch = await active.source();
    expect(branch?.branchEntries).toHaveLength(2);
    expect(await active.cut(cutIntent)).toEqual({ status: "conflict" });
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
    const restored = storage(await acquire());
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
});
