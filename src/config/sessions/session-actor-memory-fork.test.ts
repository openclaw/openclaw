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

async function fixture(entry: Partial<SessionEntry> = {}, events: readonly unknown[] = transcript) {
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
    transcriptEvents: events,
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

const degradedCompaction = {
  type: "compaction",
  id: "c1",
  parentId: "a2",
  timestamp: "2026-01-01T00:00:05.000Z",
  summary: "Summary",
  firstKeptEntryId: "a2",
  tokensBefore: 1000,
  details: { readFiles: [], modifiedFiles: [], qualityDegraded: true },
};

/** Fixture transcript extended past a lossy compaction (c1), then u3/a3. */
const degradedTranscript: readonly unknown[] = [
  ...transcript,
  degradedCompaction,
  message("u3", "c1", 6, { role: "user", content: "Third question" }),
  message("a3", "u3", 7, { role: "assistant", content: "Third answer", stopReason: "stop" }),
];

/** As above, plus a side branch (u2b) off a1 for switch-away coverage. The leaf
 * control pins the active leaf to a3: without it the last event (u2b) would be
 * the leaf, and switching to u2b would be a refused no-op. */
const degradedBranchTranscript: readonly unknown[] = [
  ...degradedTranscript,
  message("u2b", "a1", 8, { role: "user", content: "Side question" }),
  {
    type: "leaf",
    id: "active-leaf-degraded",
    parentId: "a3",
    timestamp: "2026-01-01T00:00:09.000Z",
    targetId: "a3",
  },
];

async function readParentEntry(actor: SessionActor) {
  return readMemory(storage(actor), "session.entry.read", {});
}

describe("memory actor fork and cut", () => {
  it.each([false, true])(
    "forks current bindings and child audience (preserve visibility=%s)",
    async (preserveVisibility) => {
      const { parent, child, acquire, forkInput } = await fixture({
        cliSessionBindings: {
          claude: {
            sessionId: "cli-parent",
            resumeCheckpointId: "old-checkpoint",
            forceReuse: true,
          },
        },
      });
      await commitMemory(storage(child), "session.entry.create", {
        entry: { ...forkInput.params.fallbackEntry, visibility: "draft" },
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
        { ...forkInput, ...(preserveVisibility ? { patch: { preserveVisibility: true } } : {}) },
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
      expect(result.sessionEntry.visibility).toBe(preserveVisibility ? "draft" : undefined);
      const activeChild = await acquire(childKey);
      const copied = await readMemory(storage(activeChild), "session.parentFork.source", {});
      expect(copied?.branchEntries).toHaveLength(4);
      copied?.branchEntries.splice(0);
      const source = await readMemory(storage(parent), "session.parentFork.source", {});
      const reread = await readMemory(storage(activeChild), "session.parentFork.source", {});
      expect(source?.branchEntries).toHaveLength(4);
      expect(reread?.branchEntries).toHaveLength(4);
    },
  );

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
    const boundary = {
      type: "compaction",
      id: "summary",
      parentId: "a2",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
      summary: "First question answered",
    };
    await commitMemory(storage(parent), "session.event.append", {
      scope: {
        agentId: "main",
        sessionKey: parentKey,
        storePath,
        sessionId: expectedState.sessionId,
      },
      eventJson: JSON.stringify(boundary),
    });
    const intent = {
      canonicalSourceKey: parentKey,
      sourceKey: parentKey,
      targetKey: parentKey,
      entryId: "u2",
      expectedState,
      mode: "rewind" as const,
    };
    const drained = await readMemory(storage(parent), "session.history.raw-delta", { limits: {} });
    assert(drained.kind === "page", "Raw delta page failed");
    const rewind = await commitMemory(storage(parent), "session.messageCut", { intent });
    expect(rewind).toMatchObject({
      status: "created",
      editorText: "Edit this",
      entry: { compactionCount: 0 },
      editorAttachments: [{ mimeType: "image/png", data: "c3ludGhldGlj" }],
    });
    assert(rewind.status === "created", "Rewind failed");
    // The cut keeps the transcript identity; the writer claim is what is retired.
    expect(rewind.entry.sessionId).toBe("parent-session");
    expect(rewind.entry.lifecycleRevision).not.toBe(expectedState.lifecycleRevision);
    // The control rotates the generation, as SQLite does: a pre-cut cursor is refused.
    expect(
      await readMemory(storage(parent), "session.history.raw-delta", {
        limits: { cursor: drained.cursor },
      }),
    ).toMatchObject({ kind: "reset", reason: "generation_mismatch" });
    const stale = await mutateMemory(storage(parent), "session.event.append", {
      scope: {
        agentId: "main",
        sessionKey: parentKey,
        storePath,
        sessionId: expectedState.sessionId,
        expectedOwner: { lifecycleRevision: expectedState.lifecycleRevision },
      },
      eventJson: JSON.stringify({ type: "custom", id: "stale", customType: "x", parentId: "a2" }),
    });
    assert(stale.kind === "rolled-back", "Stale writer was admitted after the cut");
    const active = await acquire();
    const old = await readMemory(storage(active), "session.history.hydrate", {
      sessionId: "parent-session",
    });
    expect(old.kind).toBe("full");
    if (old.kind === "full") {
      // The original window is retained: every seeded event plus the one control.
      expect(old.snapshot.events).toMatchObject([
        ...transcript,
        boundary,
        { type: "leaf", parentId: boundary.id, targetId: "a1" },
      ]);
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
        entryId: boundary.id,
        expectedState: {
          sessionId: rewind.entry.sessionId,
          lifecycleRevision: rewind.entry.lifecycleRevision,
        },
      },
    });
    expect(switched).toMatchObject({ status: "created", entry: { compactionCount: 1 } });
    const restored = await acquire();
    expect(
      (await readMemory(storage(restored), "session.parentFork.source", {}))?.branchEntries,
    ).toHaveLength(5);
  });

  // Rewinding to before a lossy compaction must not keep warning that the restored
  // history may be missing details: the degraded flag belongs to the selected path.
  it("rewinds before a degraded compaction and clears the degraded flag", async () => {
    const { parent, acquire } = await fixture({}, degradedTranscript);
    expect((await readParentEntry(parent))?.compactionQualityDegraded).toBe(true);
    const rewind = await commitMemory(storage(parent), "session.messageCut", {
      intent: {
        canonicalSourceKey: parentKey,
        sourceKey: parentKey,
        targetKey: parentKey,
        entryId: "u2",
        expectedState: { sessionId: "parent-session", lifecycleRevision: "parent-lifecycle" },
        mode: "rewind" as const,
      },
    });
    assert(rewind.status === "created", "Rewind failed");
    expect(rewind.entry.compactionQualityDegraded).toBeUndefined();
    const active = await acquire();
    expect((await readParentEntry(active))?.compactionQualityDegraded).toBeUndefined();
  });

  // The flag is derived from the selected path, not cleared unconditionally:
  // switching away drops it, switching back to the degraded branch restores it.
  it("restores the degraded flag when switching back to degraded history", async () => {
    const { parent, acquire } = await fixture({}, degradedBranchTranscript);
    expect((await readParentEntry(parent))?.compactionQualityDegraded).toBe(true);
    const away = await commitMemory(storage(parent), "session.messageCut", {
      intent: {
        canonicalSourceKey: parentKey,
        sourceKey: parentKey,
        targetKey: parentKey,
        entryId: "u2b",
        expectedState: { sessionId: "parent-session", lifecycleRevision: "parent-lifecycle" },
        mode: "switch" as const,
      },
    });
    assert(away.status === "created", "Switch away failed");
    expect(away.entry.compactionQualityDegraded).toBeUndefined();
    const active = await acquire();
    expect((await readParentEntry(active))?.compactionQualityDegraded).toBeUndefined();
    const back = await commitMemory(storage(active), "session.messageCut", {
      intent: {
        canonicalSourceKey: parentKey,
        sourceKey: parentKey,
        targetKey: parentKey,
        entryId: "a3",
        expectedState: {
          sessionId: away.entry.sessionId,
          lifecycleRevision: away.entry.lifecycleRevision,
        },
        mode: "switch" as const,
      },
    });
    assert(back.status === "created", "Switch back failed");
    expect(back.entry.compactionQualityDegraded).toBe(true);
    const restored = await acquire();
    expect((await readParentEntry(restored))?.compactionQualityDegraded).toBe(true);
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
