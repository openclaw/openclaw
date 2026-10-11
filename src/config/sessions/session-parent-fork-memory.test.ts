import { afterEach, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { rewindSessionToMessage } from "./session-accessor.sqlite-message-cut.js";
import {
  forkSessionEntryFromParentTarget,
  forkSessionEntryFromParentTargetWithPatch,
  forkSessionTranscriptFromParent,
  prepareSessionForkTranscript,
} from "./session-accessor.sqlite-parent-session.js";
import type { SessionActor } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import type { InternalSessionEntry } from "./types.js";

// The real adapters must never open native storage or allocate database workers.
vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory parent fork opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory parent fork allocated a worker");
  }),
}));

const parentKey = "agent:main:dashboard:incognito-parent-fork";
const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-parent-fork" };
const authority = { assertCurrent() {}, authorize() {} };
const actors: SessionActor[] = [];
afterEach(async () => {
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  memorySessionActorOwners.reset();
});

async function acquire(agentId: string, sessionKey: string) {
  const owner = memorySessionActorOwners.get({
    agentId,
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
  });
  const actor = await owner.acquire(
    { sessionKey, database: owner.identity },
    {
      assertCurrent() {},
      assertReadable() {},
    },
  );
  actors.push(actor);
  const binding: SessionActorStorageBinding = { actor, authority, agentId, path: owner.path };
  return { actor, owner, binding };
}

async function fixture(childAgent = "main") {
  const parent = await acquire("main", parentKey);
  const entry = {
    sessionId: "parent-session",
    lifecycleRevision: "parent-lifecycle",
    updatedAt: 1,
    incognito: true,
  } satisfies InternalSessionEntry;
  const events = [
    {
      type: "session",
      id: entry.sessionId,
      version: 3,
      cwd: "/synthetic",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Question" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: "First answer", stopReason: "stop" },
    },
  ];
  expect(
    await parent.actor.storage!.mutate(
      {
        type: "session.entry.create",
        input: { entry, transcriptEvents: events },
      },
      authority,
    ),
  ).toMatchObject({ kind: "committed" });
  const childKey = `agent:${childAgent}:dashboard:incognito-child-fork`;
  const child = await acquire(childAgent, childKey);
  return { parent, child, childKey, entry };
}

it.each([
  { childAgent: "main", explicit: true },
  { childAgent: "research", explicit: false },
])(
  "prepares a current $childAgent child fork through the selected memory owner",
  async ({ childAgent, explicit }) => {
    const { parent, child, childKey, entry } = await fixture(childAgent);
    const append = parent.actor.appendTranscriptEvent(
      {
        commandId: "latest-answer",
        phaseId: "preparation",
        append: {
          kind: "metadata",
          input: {
            scope: {
              agentId: "main",
              storePath: parent.owner.path,
              sessionKey: parentKey,
              sessionId: entry.sessionId,
              expectedLifecycleRevision: entry.lifecycleRevision,
            },
            event: {
              type: "message",
              id: "a2",
              parentId: "a1",
              timestamp: "2026-01-01T00:00:01.000Z",
            },
            message: {
              messageJson: JSON.stringify({
                role: "assistant",
                content: "Latest answer",
                stopReason: "stop",
              }),
              cwd: "/synthetic",
              validateTurn: false,
            },
            options: {},
          },
        },
      },
      authority,
    );
    const input = {
      parentEntry: entry,
      parentSessionKey: parentKey,
      sessionKey: childKey,
      agentId: "main",
      storePath: parent.owner.path,
      targetStorePath: child.owner.path,
      targetSessionId: "child-session",
      enforceTokenLimit: true,
      maxTokens: 10_000,
      ...(explicit ? { sessionActor: child.binding } : {}),
    };
    const prepared = explicit
      ? await prepareSessionForkTranscript(input)
      : await runWithSessionActorStorage(child.binding, () => prepareSessionForkTranscript(input));
    expect((await append).kind).toBe("committed");
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error("Expected prepared fork");
    }
    expect(prepared.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "a2",
          message: expect.objectContaining({ content: "Latest answer" }),
        }),
      ]),
    );
    expect(
      await child.actor.storage!.read({ type: "session.entry.read", input: {} }, authority),
    ).toBeUndefined();
    expect(
      await child.actor.storage!.mutate(
        {
          type: "session.entry.create",
          input: {
            entry: { sessionId: prepared.transcript.sessionId, updatedAt: 2 },
            transcriptEvents: prepared.events,
          },
        },
        authority,
      ),
    ).toMatchObject({ kind: "committed" });
    expect(
      await child.actor.storage!.read({ type: "session.history.hydrate", input: {} }, authority),
    ).toMatchObject({
      kind: "full",
      snapshot: { events: prepared.events },
    });
  },
);

it("rewinds current memory state while preserving explicit conflicts", async () => {
  const { parent, entry } = await fixture();
  const params = {
    agentId: "main",
    sessionKey: parentKey,
    storePath: parent.owner.path,
    entryId: "u1",
  };
  expect(
    await runWithSessionActorStorage(parent.binding, () =>
      rewindSessionToMessage(params, {
        sessionId: "replaced-session",
        lifecycleRevision: entry.lifecycleRevision,
      }),
    ),
  ).toEqual({ status: "conflict" });
  const result = await runWithSessionActorStorage(parent.binding, () =>
    rewindSessionToMessage(params),
  );
  expect(result).toMatchObject({
    status: "created",
    editorText: "Question",
    entry: { incognito: true },
  });
});

it("does not create a missing cross-agent source while preparing a child", async () => {
  const child = await acquire("research", "agent:research:dashboard:incognito-orphan-fork");
  const prepared = await runWithSessionActorStorage(child.binding, () =>
    prepareSessionForkTranscript({
      agentId: "main",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      parentSessionKey: parentKey,
      parentEntry: { sessionId: "missing", updatedAt: 1 },
      sessionKey: child.actor.target.sessionKey,
    }),
  );
  expect(prepared).toEqual({ status: "missing-parent" });
  expect(memorySessionActorOwners.list().map((owner) => owner.agentId)).toEqual(["research"]);
});

it.each(["main", "research"])(
  "adopts a transcript-only fork in the %s memory owner",
  async (childAgent) => {
    const { parent, child, childKey, entry } = await fixture(childAgent);
    const fork = await forkSessionTranscriptFromParent({
      parentEntry: entry,
      parentSessionKey: parentKey,
      sessionKey: childKey,
      agentId: "main",
      storePath: parent.owner.path,
      targetStorePath: child.owner.path,
      targetSessionId: "pending-child-transcript",
    });
    expect(fork.status).toBe("created");
    expect(child.owner.readSession(childKey, authority)?.entry).toBeUndefined();
    const pending = await child.actor.storage!.read(
      { type: "session.history.hydrate", input: { sessionId: "pending-child-transcript" } },
      authority,
    );
    expect(pending).toMatchObject({
      kind: "full",
      snapshot: { events: expect.arrayContaining([expect.objectContaining({ id: "a1" })]) },
    });
    await upsertSessionEntryCore(
      { agentId: childAgent, sessionKey: childKey, storePath: child.owner.path },
      { sessionId: "pending-child-transcript", updatedAt: 2 },
    );
    expect(
      await child.actor.storage!.read({ type: "session.history.hydrate", input: {} }, authority),
    ).toMatchObject({
      kind: "full",
      snapshot: { events: pending.kind === "full" ? pending.snapshot.events : [] },
    });
  },
);

it.each(["callback", "typed"])(
  "forks current memory state through the %s entry API",
  async (mode) => {
    const { parent, childKey } = await fixture();
    const params = {
      storePath: parent.owner.path,
      agentId: "main",
      parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
      sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
      fallbackEntry: { sessionId: "child-seed", updatedAt: 2 },
    };
    const result =
      mode === "callback"
        ? await forkSessionEntryFromParentTarget({
            ...params,
            patch: ({ fork }) => ({ label: fork.sessionId }),
          })
        : await forkSessionEntryFromParentTargetWithPatch(params, {
            forked: { label: "Copied child" },
          });
    expect(result.status).toBe("forked");
    if (result.status !== "forked") {
      throw new Error("Expected child fork");
    }
    expect(result.sessionEntry.label).toBe(
      mode === "callback" ? result.fork.sessionId : "Copied child",
    );
    expect(parent.owner.readSession(childKey, authority)?.entry?.sessionId).toBe(
      result.fork.sessionId,
    );
  },
);
