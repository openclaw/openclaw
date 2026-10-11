import { afterEach, describe, expect, it } from "vitest";
import type {
  SessionActor,
  SessionActorAuthority,
  SessionActorStorage,
} from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import type { SessionActorStorageOutcome } from "./session-actor-storage-contract.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const parentKey = "agent:main:dashboard:incognito-fork-parent";
const childKey = "agent:main:dashboard:incognito-fork-child";
const storePath = "/synthetic/incognito-forks";
const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

function storage(actor: SessionActor): SessionActorStorage {
  if (!actor.storage) {
    throw new Error("Memory actor storage is missing");
  }
  return actor.storage;
}

function committed<T>(outcome: SessionActorStorageOutcome<T>): T {
  expect(outcome.kind).toBe("committed");
  if (outcome.kind !== "committed") {
    throw new Error(outcome.error.message);
  }
  expect(outcome.failure).toBeUndefined();
  return outcome.value;
}

const transcript = [
  {
    type: "session",
    id: "parent-session",
    version: 3,
    cwd: "/synthetic",
    timestamp: "2026-01-01T00:00:00.000Z",
  },
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: "First question" },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "assistant", content: "First answer", stopReason: "stop" },
  },
  {
    type: "message",
    id: "u2",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:03.000Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "Edit this" },
        { type: "image", mimeType: "image/png", data: "c3ludGhldGlj" },
      ],
    },
  },
  {
    type: "message",
    id: "a2",
    parentId: "u2",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: { role: "assistant", content: "Second answer", stopReason: "stop" },
  },
];

async function fixture(entry: Partial<SessionEntry> = {}) {
  const owner = createMemorySessionActorOwner({ agentId: "main", path: storePath });
  owners.push(owner);
  const acquire = (sessionKey = parentKey) =>
    owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const parent = await acquire();
  committed(
    await storage(parent).mutate(
      {
        type: "session.entry.create",
        input: {
          entry: {
            sessionId: "parent-session",
            lifecycleRevision: "parent-lifecycle",
            updatedAt: 1,
            incognito: true,
            ...entry,
          },
          transcriptEvents: transcript,
        },
      },
      authority,
    ),
  );
  const child = await acquire(childKey);
  const forkInput = {
    kind: "entry" as const,
    params: {
      parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
      sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
      fallbackEntry: { sessionId: "child-seed", updatedAt: 1, incognito: true },
    },
    supportsCliFork: (provider: string) => provider === "claude",
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
    const patch = storage(parent).mutate(
      {
        type: "session.entry.patch",
        input: {
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
        },
      },
      authority,
    );
    const fork = storage(child).mutate(
      { type: "session.parentFork.commit", input: forkInput },
      authority,
    );
    committed(await patch);
    const result = committed(await fork);
    expect(result.status).toBe("forked");
    if (result.status !== "forked") {
      throw new Error("Fork failed");
    }
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
    const copied = await storage(child).read(
      { type: "session.parentFork.source", input: {} },
      authority,
    );
    expect(copied?.branchEntries).toHaveLength(4);
    copied?.branchEntries.splice(0);
    const source = await storage(parent).read(
      { type: "session.parentFork.source", input: {} },
      authority,
    );
    const reread = await storage(child).read(
      { type: "session.parentFork.source", input: {} },
      authority,
    );
    expect(source?.branchEntries).toHaveLength(4);
    expect(reread?.branchEntries).toHaveLength(4);
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
    const rewind = committed(
      await storage(parent).mutate({ type: "session.messageCut", input: { intent } }, authority),
    );
    expect(rewind).toMatchObject({
      status: "created",
      editorText: "Edit this",
      editorAttachments: [{ mimeType: "image/png", data: "c3ludGhldGlj" }],
    });
    if (rewind.status !== "created") {
      throw new Error("Rewind failed");
    }
    await expect(
      storage(parent).read({ type: "session.entry.read", input: {} }, authority),
    ).rejects.toThrow(/closed/);
    const active = await acquire();
    const old = await storage(active).read(
      { type: "session.history.hydrate", input: { sessionId: "parent-session" } },
      authority,
    );
    expect(old.kind).toBe("full");
    if (old.kind === "full") {
      expect(old.snapshot.events).toEqual(transcript);
    }
    const branch = await storage(active).read(
      { type: "session.parentFork.source", input: {} },
      authority,
    );
    expect(branch?.branchEntries).toHaveLength(2);
    expect(
      committed(
        await storage(active).mutate({ type: "session.messageCut", input: { intent } }, authority),
      ),
    ).toEqual({ status: "conflict" });
    const switched = committed(
      await storage(active).mutate(
        {
          type: "session.messageCut",
          input: {
            intent: {
              ...intent,
              mode: "switch",
              entryId: "a2",
              expectedState: {
                sessionId: rewind.entry.sessionId,
                lifecycleRevision: rewind.entry.lifecycleRevision,
              },
            },
          },
        },
        authority,
      ),
    );
    expect(switched.status).toBe("created");
    const restored = await acquire();
    expect(
      (await storage(restored).read({ type: "session.parentFork.source", input: {} }, authority))
        ?.branchEntries,
    ).toHaveLength(4);
  });

  it("forks only the prefix before a user message and preserves source identity", async () => {
    const { parent, child } = await fixture({
      thinkingLevel: "high",
      cliSessionIds: { claude: "old-cli" },
      totalTokens: 50,
    });
    const result = committed(
      await storage(child).mutate(
        {
          type: "session.messageCut",
          input: {
            intent: {
              canonicalSourceKey: parentKey,
              sourceKey: parentKey,
              targetKey: childKey,
              entryId: "u2",
              expectedState: { sessionId: "parent-session", lifecycleRevision: "parent-lifecycle" },
              mode: "fork",
              creation: { via: "operator" },
            },
          },
        },
        authority,
      ),
    );
    expect(result).toMatchObject({
      status: "created",
      editorText: "Edit this",
      entry: { incognito: true, thinkingLevel: "high", createdVia: "operator" },
    });
    if (result.status !== "created") {
      throw new Error("Message fork failed");
    }
    expect(result.entry.cliSessionIds).toBeUndefined();
    expect(result.entry.totalTokens).toBeUndefined();
    expect(
      (await storage(child).read({ type: "session.parentFork.source", input: {} }, authority))
        ?.branchEntries,
    ).toHaveLength(2);
    expect(
      (await storage(parent).read({ type: "session.entry.read", input: {} }, authority))?.sessionId,
    ).toBe("parent-session");
    expect(
      (await storage(parent).read({ type: "session.parentFork.source", input: {} }, authority))
        ?.branchEntries,
    ).toHaveLength(4);
  });

  it("does not publish a child when authority refuses the source copy", async () => {
    const { child, forkInput } = await fixture();
    const denied: SessionActorAuthority = {
      assertCurrent() {},
      authorize(_stage, facts) {
        if (facts.target.sessionKey === parentKey) {
          throw new Error("Source access revoked");
        }
      },
    };
    const result = await storage(child).mutate(
      { type: "session.parentFork.commit", input: forkInput },
      denied,
    );
    expect(result).toMatchObject({
      kind: "rolled-back",
      error: { message: "Source access revoked" },
    });
    expect(
      await storage(child).read({ type: "session.entry.read", input: {} }, authority),
    ).toBeUndefined();
  });
});
