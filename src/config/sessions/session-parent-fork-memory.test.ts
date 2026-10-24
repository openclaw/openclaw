import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { rewindSessionToMessage } from "./session-accessor.sqlite-message-cut.js";
import {
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
import type { SessionActorStorageWrites } from "./session-actor-storage-contract.js";

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
const answer = (content = "First answer") => ({ role: "assistant", content, stopReason: "stop" });
const history = (events: unknown) => ({ kind: "full", snapshot: { events } });
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
    { assertCurrent() {}, assertReadable() {} },
  );
  actors.push(actor);
  const binding: SessionActorStorageBinding = { actor, authority, agentId, path: owner.path };
  return {
    actor,
    owner,
    binding,
    scope: { agentId, sessionKey, storePath: owner.path },
    readEntry: () => actor.storage!.read({ type: "session.entry.read", input: {} }, authority),
    readHistory: (sessionId?: string) =>
      actor.storage!.read({ type: "session.history.hydrate", input: { sessionId } }, authority),
    create: (input: SessionActorStorageWrites["session.entry.create"]["input"]) =>
      actor.storage!.mutate({ type: "session.entry.create", input }, authority),
    run: <T>(fn: () => T) => runWithSessionActorStorage(binding, fn),
  };
}

async function fixture(childAgent = "main") {
  const parent = await acquire("main", parentKey);
  const entry = {
    sessionId: "parent-session",
    lifecycleRevision: "parent-lifecycle",
    updatedAt: 1,
    incognito: true as const,
  };
  const events = [
    {
      type: "session",
      id: entry.sessionId,
      version: 3,
      cwd: "/synthetic",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Question" } },
    { type: "message", id: "a1", parentId: "u1", message: answer() },
  ];
  expect(await parent.create({ entry, transcriptEvents: events })).toMatchObject({
    kind: "committed",
  });
  const childKey = `agent:${childAgent}:dashboard:incognito-child-fork`;
  const child = await acquire(childAgent, childKey);
  const forkInput = {
    ...parent.scope,
    parentEntry: entry,
    parentSessionKey: parentKey,
    sessionKey: childKey,
    targetStorePath: child.owner.path,
  };
  return { parent, child, childKey, entry, forkInput };
}

it.each(["main", "research"])(
  "prepares current %s forks through the selected memory owner",
  async (childAgent) => {
    const explicit = childAgent === "main";
    const { parent, child, entry, forkInput } = await fixture(childAgent);
    const append = parent.actor.appendTranscriptEvent(
      {
        commandId: "latest-answer",
        phaseId: "preparation",
        append: {
          kind: "metadata",
          input: {
            scope: {
              ...parent.scope,
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
              messageJson: JSON.stringify(answer("Latest answer")),
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
      ...forkInput,
      targetSessionId: "child-session",
      enforceTokenLimit: true,
      maxTokens: 10_000,
      ...(explicit ? { sessionActor: child.binding } : {}),
    };
    const prepared = explicit
      ? await prepareSessionForkTranscript(input)
      : await child.run(() => prepareSessionForkTranscript(input));
    expect((await append).kind).toBe("committed");
    assert(prepared.status === "prepared");
    expect(prepared.events).toContainEqual(
      expect.objectContaining({
        id: "a2",
        message: expect.objectContaining({ content: "Latest answer" }),
      }),
    );
    expect(await child.readEntry()).toBeUndefined();
    expect(
      await child.create({
        entry: { sessionId: prepared.transcript.sessionId, updatedAt: 2 },
        transcriptEvents: prepared.events,
      }),
    ).toMatchObject({ kind: "committed" });
    expect(await child.readHistory()).toMatchObject(history(prepared.events));
  },
);

it("rewinds current memory state while preserving explicit conflicts", async () => {
  const { parent, entry } = await fixture();
  const params = { ...parent.scope, entryId: "u1" };
  expect(
    await parent.run(() =>
      rewindSessionToMessage(params, {
        sessionId: "replaced-session",
        lifecycleRevision: entry.lifecycleRevision,
      }),
    ),
  ).toEqual({ status: "conflict" });
  expect(await parent.run(() => rewindSessionToMessage(params))).toMatchObject({
    status: "created",
    editorText: "Question",
    entry: { incognito: true },
  });
});

it("does not create a missing cross-agent source while preparing a child", async () => {
  const child = await acquire("research", "agent:research:dashboard:incognito-orphan-fork");
  const prepared = await child.run(() =>
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

it.each(["main", "research"])("adopts transcript-only forks in %s memory", async (childAgent) => {
  const { child, childKey, forkInput } = await fixture(childAgent);
  const fork = await forkSessionTranscriptFromParent({
    ...forkInput,
    targetSessionId: "pending-child-transcript",
  });
  expect(fork.status).toBe("created");
  expect(child.owner.readSession(childKey, authority)?.entry).toBeUndefined();
  const pending = await child.readHistory("pending-child-transcript");
  expect(pending).toMatchObject(
    history(expect.arrayContaining([expect.objectContaining({ id: "a1" })])),
  );
  await upsertSessionEntryCore(child.scope, {
    sessionId: "pending-child-transcript",
    updatedAt: 2,
  });
  expect(await child.readHistory()).toMatchObject(
    history(pending.kind === "full" ? pending.snapshot.events : []),
  );
});

it("forks current memory state with a data-only entry patch", async () => {
  const { parent, childKey } = await fixture();
  const result = await forkSessionEntryFromParentTargetWithPatch(
    {
      storePath: parent.owner.path,
      agentId: "main",
      parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
      sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
      fallbackEntry: { sessionId: "child-seed", updatedAt: 2 },
    },
    { forked: { label: "Copied child" } },
  );
  assert(result.status === "forked");
  expect(result.sessionEntry.label).toBe("Copied child");
  expect(parent.owner.readSession(childKey, authority)?.entry?.sessionId).toBe(
    result.fork.sessionId,
  );
});
