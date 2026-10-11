import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "./session-actor-storage-binding.js";
import type { SessionActorStorageOutcome } from "./session-actor-storage-contract.js";
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
import {
  isSessionMember,
  listSessionMembers,
  readSessionMembersInWorker,
} from "./session-sharing-store.js";
import { listSessionSuggestions } from "./session-suggestion-store.read.js";

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
function committed<T>(outcome: SessionActorStorageOutcome<T>): T {
  if (outcome.kind !== "committed") {
    throw new Error(outcome.error.message);
  }
  return outcome.value;
}
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
    committed(
      await storage.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: { sessionId: suffix, updatedAt: 1, category: "Work" },
            cwd: "/synthetic",
          },
        },
        authority,
      ),
    );
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
  it("publishes current membership and preserves a re-added grant against stale removal", async () => {
    const { actor, scope } = await fixture();
    const observed: boolean[] = [];
    const stop = sessionChanges.subscribeFacts((change) => {
      if (change.sessionKey === scope.sessionKey && change.facts?.kind === "member") {
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
      expect(isSessionMember(scope, "viewer")).toBe(true);
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
      expect(listSessionMembers(scope)).toHaveLength(1);
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
    expect(await storage.read({ type: "session.participants.read", input: {} }, authority)).toEqual(
      [{ identity, contributionCount: 2, firstPromptedAt: 10, lastPromptedAt: 20 }],
    );
    expect(actor.snapshot(authority)?.entry).toMatchObject({
      updatedAt: 99,
      participantCount: 1,
      owner: { actor: { type: "human", id: "owner" }, assignedAt: 5 },
    });
    for (const id of ["old-profile", "canonical-profile"]) {
      committed(
        await storage.mutate(
          {
            type: "session.collaboration.participant",
            input: {
              params: { identity: { type: "profile", id }, promptedAt: 30 },
              profileAliases: ["old-profile", "canonical-profile"],
            },
          },
          authority,
        ),
      );
    }
    expect(
      await storage.read({ type: "session.participants.read", input: {} }, authority),
    ).toContainEqual({
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
    if (claim?.kind !== "claimed") {
      throw new Error("Missing dispatch claim");
    }
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
    if (retry?.kind !== "claimed") {
      throw new Error("Missing retry claim");
    }
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
            sessionId: "first",
            lifecycleRevision: null,
            eventJson: JSON.stringify({
              type: "message",
              id: "message",
              parentId: null,
              timestamp: new Date(1).toISOString(),
              message: { role: "user", content: "Hello" },
            }),
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
    expect((await setSessionReactionAsync(scope, reaction)).changed).toBe(true);
    expect((await setSessionReactionAsync(scope, reaction)).changed).toBe(false);
    const history = await storage.read({ type: "session.history.hydrate", input: {} }, authority);
    if (history.kind !== "full") {
      throw new Error("Expected full history");
    }
    committed(
      await storage.mutate(
        {
          type: "session.transcript.replaceSuffix",
          input: {
            scope: { ...scope, sessionId: "first" },
            args: [
              history.snapshot.events,
              history.snapshot.events.slice(0, -1),
              0,
              history.snapshot.version.updatedAt,
              false,
              [],
            ],
          },
        },
        authority,
      ),
    );
    expect(
      await storage.read(
        { type: "session.reactions.read", input: { sessionId: "first" } },
        authority,
      ),
    ).toEqual({});
    await expect(setSessionReactionAsync(scope, reaction)).rejects.toThrow("unknown message");
    await addSessionSuggestionInWorker(scope, {
      id: "before-reset",
      authorId: "viewer",
      text: "Old window",
    });
    const expected = await storage.read({ type: "session.entry.read", input: {} }, authority);
    committed(
      await storage.mutate(
        {
          type: "session.lifecycle.reset",
          input: { expected, nextEntry: { ...expected!, sessionId: "reset" } },
        },
        authority,
      ),
    );
    const reopened = await owner.acquire(actor.target, { assertCurrent() {}, assertReadable() {} });
    expect(
      await reopened.storage!.read({ type: "session.suggestions.read", input: {} }, authority),
    ).toEqual([]);
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
