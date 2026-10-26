import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  commitMemory,
  readMemory,
  failSessionActorMemoryPublication,
} from "./session-actor-memory-publication.test-support.js";
import { acquireSessionActorStorage } from "./session-actor-storage-binding.js";
import { updateSessionGroupCategoriesInWorker } from "./session-group-categories.js";
import {
  addSessionSuggestionInWorker,
  assignSessionOwnerInWorker,
  claimSessionSuggestionDispatchInWorker,
  finalizeSessionSuggestionClaimInWorker,
  releaseSessionSuggestionDispatchInWorker,
} from "./session-metadata-write.async.js";
import { setSessionReactionAsync } from "./session-reaction-store.js";
import {
  addSessionMemberInWorker,
  recordSessionParticipantInWorker,
  removeSessionMemberInWorker,
} from "./session-sharing-store.async.js";
import { readSessionMembersInWorker } from "./session-sharing-store.js";
import { listSessionSuggestions } from "./session-suggestion-store.read.js";
import type { SessionEntry } from "./types.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory collaboration opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory collaboration allocated a worker");
  }),
}));

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-collaboration" };
const agentId = "main";
const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
afterEach(() => memorySessionActorOwners.reset());
async function fixture() {
  const acquire = async (suffix: string) => {
    const sessionKey = `agent:main:dashboard:incognito-${suffix}`;
    const scope = { sessionKey, agentId, storePath, env };
    const binding = (await acquireSessionActorStorage(scope, {
      authority,
      lifetime: { assertCurrent() {}, assertReadable() {} },
      create: true,
    }))!;
    const actor = binding.actor;
    const storage = actor.storage;
    await commitMemory(storage, "session.entry.create", {
      entry: { sessionId: suffix, updatedAt: 1, category: "Work" },
      cwd: "/synthetic",
    });
    return {
      actor,
      storage,
      scope,
    };
  };
  const first = await acquire("first");
  return { owner: memorySessionActorOwners.read({ agentId, path: storePath })!, acquire, ...first };
}

describe("memory collaboration through the public adapters", () => {
  it("does not create an absent memory session for reactions or category reads", async () => {
    const scope = { agentId, storePath, env, sessionKey: "agent:main:dashboard:incognito-absent" };
    await expect(
      setSessionReactionAsync(scope, {
        expectedSessionId: "missing",
        messageId: "missing",
        emoji: "👍",
        identityId: "viewer",
      }),
    ).rejects.toThrow("session changed before reaction mutation");
    expect(await updateSessionGroupCategoriesInWorker({ scope, from: "Work" })).toBe(0);
    expect(memorySessionActorOwners.list()).toEqual([]);
  });
  it("publishes stable communication facts for activity and changed facts for policy", async () => {
    const { actor, storage, scope } = await fixture();
    const bindings: Array<string | undefined> = [];
    const stop = sessionChanges.subscribeFacts((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === scope.sessionKey &&
        change.facts?.kind === "replacement"
      ) {
        bindings.push(change.facts.communicationBinding);
      }
    });
    const replace = async (patch: Partial<SessionEntry>) => {
      const before = actor.snapshot(authority)?.entry;
      assert(before, "Expected the current memory entry");
      await commitMemory(storage, "session.entry.replace", {
        expected: before,
        entry: { ...before, ...patch },
      });
    };
    try {
      await replace({ updatedAt: 2 });
      await replace({ updatedAt: 3 });
      await replace({ communication: { receive: "never" } });
      expect(bindings).toHaveLength(3);
      expect(bindings[0]).toEqual(expect.any(String));
      expect(bindings[1]).toBe(bindings[0]);
      expect(bindings[2]).not.toBe(bindings[1]);
    } finally {
      stop();
    }
  });
  it("publishes current membership and preserves a re-added grant against stale removal", async () => {
    const { actor, scope } = await fixture();
    const observed: boolean[] = [];
    const stop = sessionChanges.subscribeFacts((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === scope.sessionKey &&
        change.facts?.kind === "member"
      ) {
        observed.push(
          actor.snapshot(authority)!.members.some((member) => member.identityId === "viewer"),
        );
      }
    });
    try {
      const grant = await addSessionMemberInWorker(scope, {
        identityId: "viewer",
        addedBy: "owner",
        addedAt: 10,
      });
      expect(grant.inserted).toBe(true);
      expect((await readSessionMembersInWorker(scope)).members).toEqual([
        { identityId: "viewer", addedBy: "owner", addedAt: 10 },
      ]);
      await removeSessionMemberInWorker(scope, "viewer", grant.member);
      await addSessionMemberInWorker(scope, {
        identityId: "viewer",
        addedBy: "owner",
        addedAt: 20,
      });
      expect(await removeSessionMemberInWorker(scope, "viewer", grant.member)).toBeNull();
      const snapshot = await readSessionMembersInWorker(scope);
      expect(snapshot.members).toEqual([{ identityId: "viewer", addedBy: "owner", addedAt: 20 }]);
      snapshot.members.length = 0;
      expect((await readSessionMembersInWorker(scope)).members).toHaveLength(1);
    } finally {
      stop();
    }
    expect(observed).toEqual([true, false, true]);
  });

  it("serializes participant increments and owner assignment with ordinary turn patches", async () => {
    const { actor, storage, scope } = await fixture();
    const identity = { type: "agent" as const, id: "reviewer" };
    await Promise.all([
      recordSessionParticipantInWorker(scope, { identity, promptedAt: 20 }),
      recordSessionParticipantInWorker(scope, { identity, promptedAt: 10 }),
      actor.patch(
        {
          commandId: "activity",
          phaseId: "turn",
          reducers: [{ kind: "activity", updatedAt: 99 }],
        },
        authority,
      ),
      assignSessionOwnerInWorker(scope, {
        owner: { type: "human", id: "owner" },
        assignedBy: { type: "human", id: "admin" },
        assignedAt: 5,
        expectedSessionId: "first",
      }),
    ]);
    expect(await readMemory(storage, "session.participants.read", {})).toEqual([
      { identity, contributionCount: 2, firstPromptedAt: 10, lastPromptedAt: 20 },
    ]);
    expect(actor.snapshot(authority)?.entry).toMatchObject({
      updatedAt: 99,
      participantCount: 1,
      owner: { actor: { type: "human", id: "owner" }, assignedAt: 5 },
    });
    for (const id of ["old-profile", "canonical-profile"]) {
      await commitMemory(storage, "session.collaboration.participant", {
        params: { identity: { type: "profile", id }, promptedAt: 30 },
        profileAliases: ["old-profile", "canonical-profile"],
      });
    }
    expect(await readMemory(storage, "session.participants.read", {})).toContainEqual({
      identity: { type: "profile", id: "old-profile" },
      contributionCount: 2,
      firstPromptedAt: 30,
      lastPromptedAt: 30,
    });
  });

  it("keeps suggestion IDs unique and preserves live dispatch custody and its chosen resolution", async () => {
    const { scope, acquire } = await fixture();
    const sibling = await acquire("second");
    await addSessionSuggestionInWorker(scope, {
      id: "suggestion",
      authorId: "viewer",
      text: "Try this",
      createdAt: 1,
    });
    await expect(
      addSessionSuggestionInWorker(sibling.scope, {
        id: "suggestion",
        authorId: "other",
        text: "Duplicate",
      }),
    ).rejects.toThrow("UNIQUE constraint");
    const claim = await claimSessionSuggestionDispatchInWorker(scope, {
      id: "suggestion",
      resolution: "send",
      now: 10,
    });
    expect(claim?.kind).toBe("claimed");
    assert(claim?.kind === "claimed", "Missing dispatch claim");
    expect(
      await claimSessionSuggestionDispatchInWorker(scope, {
        id: "suggestion",
        resolution: "queue",
        now: 11,
      }),
    ).toEqual({ kind: "busy" });
    expect(
      await claimSessionSuggestionDispatchInWorker(scope, {
        id: "suggestion",
        resolution: "queue",
        now: 40_000,
      }),
    ).toEqual({ kind: "mismatch", resolution: "send" });
    expect(
      await finalizeSessionSuggestionClaimInWorker(scope, {
        id: "suggestion",
        token: "wrong",
        state: "accepted",
      }),
    ).toBeNull();
    expect(
      await releaseSessionSuggestionDispatchInWorker(scope, {
        id: "suggestion",
        token: claim.token,
      }),
    ).toBe(true);
    const retry = await claimSessionSuggestionDispatchInWorker(scope, {
      id: "suggestion",
      resolution: "edit",
      now: 50_000,
    });
    assert(retry?.kind === "claimed", "Missing retry claim");
    await finalizeSessionSuggestionClaimInWorker(scope, {
      id: "suggestion",
      token: retry.token,
      state: "accepted",
    });
    expect(await listSessionSuggestions(scope, { pendingOnly: true })).toEqual([]);
    expect(await listSessionSuggestions(scope)).toEqual([
      { id: "suggestion", authorId: "viewer", text: "Try this", createdAt: 1, state: "accepted" },
    ]);
  });

  it("removes reactions with their deleted transcript identities and clears suggestions at reset", async () => {
    const { actor, storage, scope, owner } = await fixture();
    expect(
      (
        await actor.appendTranscriptEvent(
          {
            commandId: "message",
            phaseId: "turn",
            append: {
              kind: "metadata",
              input: {
                scope: { ...scope, sessionId: "first" },
                event: {
                  type: "message",
                  id: "message",
                  parentId: null,
                  timestamp: new Date(1).toISOString(),
                },
                message: {
                  messageJson: JSON.stringify({ role: "user", content: "Hello" }),
                  cwd: "/synthetic",
                  validateTurn: false,
                },
                options: {},
              },
            },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    const reaction = {
      expectedSessionId: "first",
      messageId: "message",
      emoji: "👍",
      identityId: "viewer",
    };
    const stop = failSessionActorMemoryPublication(scope.sessionKey);
    try {
      await expect(setSessionReactionAsync(scope, reaction)).rejects.toMatchObject({
        name: "SessionActorStorageCommittedError",
      });
    } finally {
      stop();
    }
    expect((await setSessionReactionAsync(scope, reaction)).changed).toBe(false);
    const history = await readMemory(storage, "session.history.hydrate", {});
    assert(history.kind === "full", "Expected full history");
    await commitMemory(storage, "session.transcript.replaceSuffix", {
      scope: { ...scope, sessionId: "first" },
      args: [
        history.snapshot.events,
        history.snapshot.events.slice(0, -1),
        0,
        history.snapshot.version.updatedAt,
        false,
        [],
      ],
    });
    expect(await readMemory(storage, "session.reactions.read", { sessionId: "first" })).toEqual({});
    await expect(setSessionReactionAsync(scope, reaction)).rejects.toThrow("unknown message");
    await addSessionSuggestionInWorker(scope, {
      id: "before-reset",
      authorId: "viewer",
      text: "Old window",
    });
    const expected = await readMemory(storage, "session.entry.read", {});
    await commitMemory(storage, "session.lifecycle.reset", {
      expected,
      nextEntry: { ...expected!, sessionId: "reset" },
    });
    const reopened = await owner.acquire(actor.target, { assertCurrent() {}, assertReadable() {} });
    expect(await readMemory(reopened.storage!, "session.suggestions.read", {})).toEqual([]);
  });

  it("changes a category cohort atomically and authorizes every affected session", async () => {
    const { scope, storage, acquire } = await fixture();
    const sibling = await acquire("second");
    await expect(
      updateSessionGroupCategoriesInWorker({
        scope,
        from: "Work",
        assertTargetCurrent(target) {
          if (target.sessionKey === sibling.scope.sessionKey) {
            throw new Error("sibling access revoked");
          }
        },
      }),
    ).rejects.toThrow("sibling access revoked");
    for (const current of [storage, sibling.storage]) {
      expect(
        await current.read({ type: "session.entry.read", input: {} }, authority),
      ).toMatchObject({ category: "Work" });
    }
    expect(await updateSessionGroupCategoriesInWorker({ scope, from: "Work" })).toBe(2);
    for (const current of [storage, sibling.storage]) {
      expect(
        (await current.read({ type: "session.entry.read", input: {} }, authority))?.category,
      ).toBeUndefined();
    }
  });
});
