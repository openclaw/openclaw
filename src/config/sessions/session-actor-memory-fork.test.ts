import { afterEach, assert, describe, expect, it } from "vitest";
import type {
  SessionActor,
  SessionActorAuthority,
  SessionActorStorage,
} from "./session-actor-contract.js";
import {
  commitMemory,
  committedMemoryResult as committed,
  mutateMemory,
  readMemory,
} from "./session-actor-memory-publication.test-support.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import type { SessionActorStorageAuthority } from "./session-actor-storage-contract.js";
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
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

function storage(actor: SessionActor): SessionActorStorage {
  assert(actor.storage, "Memory actor storage is missing");
  return actor.storage;
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
  const parent = await acquire();
  await commitMemory(storage(parent), "session.entry.create", {
    entry: {
      sessionId: "parent-session",
      lifecycleRevision: "parent-lifecycle",
      updatedAt: 1,
      incognito: true,
      ...entry,
    },
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
  return { owner, acquire, parent, child, forkInput };
}

describe("memory actor fork and cut", () => {
  it("forks the latest in-process bindings and detaches copied transcript results", async () => {
    const { parent, child, forkInput } = await fixture({
      cliSessionBindings: {
        claude: { sessionId: "cli-parent", resumeCheckpointId: "old-checkpoint", forceReuse: true },
      },
    });
    const patch = mutateMemory(storage(parent), "session.entry.patch", {
      operation: {
        kind: "fields",
        patch: {
          cliSessionBindings: {
            claude: {
              sessionId: "cli-parent",
              resumeCheckpointId: "new-checkpoint",
              forceReuse: true,
            },
          },
        },
      },
    });
    const fork = mutateMemory(
      storage(child),
      "session.parentFork.commit",
      forkInput,
      forkAuthority,
    );
    committed(await patch);
    const result = committed(await fork);
    expect(result.status).toBe("forked");
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
    const copied = await readMemory(storage(child), "session.parentFork.source", {});
    expect(copied?.branchEntries).toHaveLength(4);
    copied?.branchEntries.splice(0);
    const source = await readMemory(storage(parent), "session.parentFork.source", {});
    const reread = await readMemory(storage(child), "session.parentFork.source", {});
    expect(source?.branchEntries).toHaveLength(4);
    expect(reread?.branchEntries).toHaveLength(4);
  });

  it("does not inherit CLI bindings without host fork support", async () => {
    const { child, forkInput } = await fixture({
      cliSessionBindings: {
        claude: { sessionId: "cli-parent", resumeCheckpointId: "checkpoint", forceReuse: true },
      },
    });
    const result = await commitMemory(storage(child), "session.parentFork.commit", forkInput);
    expect(result.status).toBe("forked");
    assert(result.status === "forked", "Fork failed");
    expect(result.sessionEntry.cliSessionBindings).toBeUndefined();
  });

  it("rewinds and switches branches while retaining the original window and rejecting old identity", async () => {
    const { parent, acquire } = await fixture();
    const expectedState = { sessionId: "parent-session", lifecycleRevision: "parent-lifecycle" };
    const intent = {
      canonicalSourceKey: parentKey,
      sourceKey: parentKey,
      targetKey: parentKey,
      entryId: "u2",
      expectedState,
      mode: "rewind" as const,
    };
    const rewind = await commitMemory(storage(parent), "session.messageCut", { intent });
    expect(rewind).toMatchObject({
      status: "created",
      editorText: "Edit this",
      editorAttachments: [{ mimeType: "image/png", data: "c3ludGhldGlj" }],
    });
    assert(rewind.status === "created", "Rewind failed");
    await expect(async () => readMemory(storage(parent), "session.entry.read", {})).rejects.toThrow(
      /closed/,
    );
    const active = await acquire();
    const old = await readMemory(storage(active), "session.history.hydrate", {
      sessionId: "parent-session",
    });
    expect(old.kind).toBe("full");
    if (old.kind === "full") {
      expect(old.snapshot.events).toEqual(transcript);
    }
    const branch = await readMemory(storage(active), "session.parentFork.source", {});
    expect(branch?.branchEntries).toHaveLength(2);
    expect(await commitMemory(storage(active), "session.messageCut", { intent })).toEqual({
      status: "conflict",
    });
    const switched = await commitMemory(storage(active), "session.messageCut", {
      intent: {
        ...intent,
        mode: "switch",
        entryId: "a2",
        expectedState: {
          sessionId: rewind.entry.sessionId,
          lifecycleRevision: rewind.entry.lifecycleRevision,
        },
      },
    });
    expect(switched.status).toBe("created");
    const restored = await acquire();
    expect(
      (await readMemory(storage(restored), "session.parentFork.source", {}))?.branchEntries,
    ).toHaveLength(4);
  });

  it("forks only the prefix before a user message and preserves source identity", async () => {
    const { parent, child } = await fixture({
      thinkingLevel: "high",
      cliSessionIds: { claude: "old-cli" },
      totalTokens: 50,
    });
    const result = await commitMemory(storage(child), "session.messageCut", {
      intent: {
        canonicalSourceKey: parentKey,
        sourceKey: parentKey,
        targetKey: childKey,
        entryId: "u2",
        expectedState: { sessionId: "parent-session", lifecycleRevision: "parent-lifecycle" },
        mode: "fork",
        creation: { via: "operator" },
      },
    });
    expect(result).toMatchObject({
      status: "created",
      editorText: "Edit this",
      entry: { incognito: true, thinkingLevel: "high", createdVia: "operator" },
    });
    assert(result.status === "created", "Message fork failed");
    expect(result.entry.cliSessionIds).toBeUndefined();
    expect(result.entry.totalTokens).toBeUndefined();
    expect(
      (await readMemory(storage(child), "session.parentFork.source", {}))?.branchEntries,
    ).toHaveLength(2);
    expect((await readMemory(storage(parent), "session.entry.read", {}))?.sessionId).toBe(
      "parent-session",
    );
    expect(
      (await readMemory(storage(parent), "session.parentFork.source", {}))?.branchEntries,
    ).toHaveLength(4);
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
    const result = await mutateMemory(
      storage(child),
      "session.parentFork.commit",
      forkInput,
      denied,
    );
    expect(result).toMatchObject({
      kind: "rolled-back",
      error: { message: "Source access revoked" },
    });
    expect(await readMemory(storage(child), "session.entry.read", {})).toBeUndefined();
  });
});
