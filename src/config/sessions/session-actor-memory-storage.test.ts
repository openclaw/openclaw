import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionActor, SessionActorStorage } from "./session-actor-contract.js";
import { authority, memoryOwnerFixture } from "./session-actor-memory-family.test-support.js";
import {
  mutateMemory as mutate,
  readMemory as read,
} from "./session-actor-memory-publication.test-support.js";
import type { SessionActorStorageWrites } from "./session-actor-storage-contract.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory storage opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory storage allocated a worker");
  }),
}));

const sessionKey = "agent:main:dashboard:incognito-storage";
const siblingKey = "agent:main:dashboard:incognito-sibling";
const openFixture = memoryOwnerFixture({ agentId: "main", path: "/synthetic/incognito" });

function storage(actor: SessionActor): SessionActorStorage {
  assert(actor.storage, "Memory actor has no storage capability");
  return actor.storage;
}
async function fixture(seed = false) {
  const current = await openFixture(sessionKey);
  if (seed) {
    await create(current.store);
  }
  return current;
}
function create(
  store: SessionActorStorage,
  entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 },
) {
  return mutate(store, "session.entry.create", { entry, cwd: "/synthetic" });
}

const entry = (store: SessionActorStorage) => read(store, "session.entry.read", {});
const patch = (store: SessionActorStorage, label: string) =>
  mutate(store, "session.entry.patch", {
    operation: { kind: "fields", patch: { label } },
    preserveActivity: true,
  });
const reclaim = (
  store: SessionActorStorage,
  input: SessionActorStorageWrites["session.lifecycle.reclaim"]["input"],
) => mutate(store, "session.lifecycle.reclaim", input);
const archive = (store: SessionActorStorage, expected: SessionEntry) =>
  reclaim(store, {
    entries: [],
    archives: [{ sessionKey, expected, entry: { ...expected, archivedAt: 10 } }],
  });
const reset = (
  store: SessionActorStorage,
  expected: SessionEntry | undefined,
  resetBoundary?: SessionActorStorageWrites["session.lifecycle.reset"]["input"]["resetBoundary"],
) =>
  mutate(store, "session.lifecycle.reset", {
    expected,
    nextEntry: { ...expected!, sessionId: "session-2" },
    resetBoundary,
  });
const activity = (actor: SessionActor) =>
  actor.patch(
    { commandId: "activity", phaseId: "turn", reducers: [{ kind: "activity", updatedAt: 50 }] },
    authority,
  );
const expectCommitted = async (outcome: unknown, value?: object) =>
  expect(await outcome).toMatchObject({ kind: "committed", ...(value ? { value } : {}) });
const expectRollback = (outcome: unknown, error: object) =>
  expect(outcome).toMatchObject({ kind: "rolled-back", error });
const readById = (store: SessionActorStorage, sessionId = "session-1") =>
  read(store, "session.entry.readById", { sessionId });
const pendingHistory = (store: SessionActorStorage, sessionId: string) =>
  read(store, "session.pendingInput.history", { sessionKey, sessionId });
const fields = (changes: Partial<SessionEntry>) => ({
  operation: { kind: "fields" as const, patch: changes },
});

describe("actor-owned memory storage", () => {
  it("holds later work behind companion rollback and rechecks policy after preparation", async () => {
    const { store } = await fixture(true);
    const prepared = createDeferred();
    const releasePreparation = createDeferred();
    const restoring = createDeferred();
    const releaseRestoration = createDeferred();
    let allowed = true;
    const deletion = store.mutate(
      { type: "session.lifecycle.delete", input: { expectedSessionId: "session-1" } },
      {
        assertCurrent() {},
        authorize() {
          if (!allowed) {
            throw new Error("Deletion permission revoked");
          }
        },
      },
      {
        async beforeCommit() {
          prepared.resolve();
          await releasePreparation.promise;
        },
        async settled(outcome) {
          expect(outcome.kind).toBe("rolled-back");
          restoring.resolve();
          await releaseRestoration.promise;
        },
      },
    );
    await prepared.promise;
    let readFinished = false;
    const following = entry(store).then((value) => {
      readFinished = true;
      return value;
    });
    allowed = false;
    releasePreparation.resolve();
    await restoring.promise;
    expect(readFinished).toBe(false);
    releaseRestoration.resolve();
    expectRollback(await deletion, { message: "Deletion permission revoked" });
    expect(await following).toMatchObject({ sessionId: "session-1" });
  });

  it("creates without a user turn and serializes typed patches with phase writes across handles", async () => {
    const { actor, store, acquire } = await fixture();
    await expectCommitted(create(store), { incognito: true });
    expect(await read(store, "session.history.hydrate", {})).toMatchObject({
      kind: "full",
      snapshot: { events: [{ type: "session", id: "session-1" }] },
    });
    const second = await acquire();
    const phaseWrite = activity(actor);
    const patched = patch(storage(second), "Current");
    const queuedRead = entry(store);
    await expectCommitted(phaseWrite);
    await expectCommitted(patched);
    expect(await queuedRead).toMatchObject({ updatedAt: 50, label: "Current", incognito: true });
    await Promise.all([actor.release(), second.release()]);
    const reopened = await acquire();
    expect(await entry(storage(reopened))).toMatchObject({ label: "Current" });
  });

  it("rejects a prepared overwrite after an intervening write without losing either field", async () => {
    const { actor, store } = await fixture(true);
    const expected = await entry(store);
    await activity(actor);
    const result = await mutate(store, "session.entry.replace", {
      expected,
      entry: { ...expected!, label: "Stale" },
    });
    expectRollback(result, { name: "SqliteSessionMutationConflictError" });
    expect(await entry(store)).toMatchObject({ updatedAt: 50 });
    expect(actor.snapshot(authority)?.entry?.label).toBeUndefined();
  });

  it.each(["entry", "transcript"] as const)(
    "keeps a cleanup candidate after an in-process %s write",
    async (change) => {
      const { actor, store } = await fixture(true);
      const expected = await entry(store);
      assert(expected, "Expected seeded entry");
      if (change === "entry") {
        await expectCommitted(patch(store, "Keep this update"));
      } else {
        await expectCommitted(
          mutate(store, "session.transcript.appendMessage", {
            scope: {
              agentId: "main",
              storePath: "/synthetic/incognito",
              sessionKey,
              sessionId: expected.sessionId,
            },
            messageJson: JSON.stringify({ role: "user", content: "Keep this message" }),
            cwd: "/synthetic",
          }),
        );
        // Appends leave the entry unchanged; cleanup must inspect the current transcript.
        expect(await entry(store)).toEqual(expected);
      }
      await expectCommitted(
        reclaim(store, {
          entries: [{ sessionKey, expected, requiresMissingTranscript: true }],
        }),
        { removedSessionKeys: [], beforeCount: 1, afterCount: 1 },
      );
      expect(actor.snapshot(authority)?.entry).toMatchObject({ sessionId: expected.sessionId });
      if (change === "entry") {
        expect(actor.snapshot(authority)?.entry?.label).toBe("Keep this update");
      } else {
        expect(await read(store, "session.history.message-presence", {})).toBe(true);
      }
    },
  );

  it("archives a current entry without overwriting a newer entry from a stale plan", async () => {
    const { actor, store } = await fixture(true);
    const expected = await entry(store);
    assert(expected, "Expected seeded entry");
    await expectCommitted(patch(store, "Newer label"));
    await expectCommitted(archive(store, expected), {
      archivedSessionKeys: [],
      beforeCount: 1,
      afterCount: 1,
    });
    expect(actor.snapshot(authority)?.entry).toMatchObject({ label: "Newer label" });
    expect(actor.snapshot(authority)?.entry?.archivedAt).toBeUndefined();
    const current = (await entry(store))!;
    await expectCommitted(archive(store, current), {
      archivedSessionKeys: [sessionKey],
      beforeCount: 1,
      afterCount: 1,
    });
    expect(actor.snapshot(authority)?.entry).toMatchObject({
      label: "Newer label",
      archivedAt: 10,
    });
  });

  it("retains reset windows, closes old handles, and deletes all owned history", async () => {
    const { actor, store, acquire } = await fixture(true);
    await actor.appendTranscriptEvent(
      {
        commandId: "custom",
        phaseId: "turn",
        sessionId: "session-1",
        lifecycleRevision: null,
        eventJson: JSON.stringify({
          type: "custom",
          customType: "test",
          id: "custom",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          data: { value: "retained" },
        }),
      },
      authority,
    );
    const expected = await entry(store);
    await expectCommitted(
      reset(store, expected, {
        context: "clear",
        reason: "reset",
        cwd: "/synthetic",
        boundaryId: "reset-1",
      }),
      {
        progressCardReset: false,
        previousSessionId: "session-1",
        nextEntry: { sessionId: "session-2" },
      },
    );
    expect(() => actor.snapshot(authority)).toThrow("closed");
    const current = await acquire();
    const currentStore = storage(current);
    expect(
      await read(currentStore, "session.history.hydrate", { sessionId: "session-1" }),
    ).toMatchObject({
      kind: "full",
      snapshot: {
        events: [{ type: "session" }, { id: "custom" }, { type: "reset", id: "reset-1" }],
      },
    });
    expect(await readById(currentStore)).toMatchObject({
      sessionKey,
      entry: { sessionId: "session-1" },
    });
    await expectCommitted(mutate(currentStore, "session.lifecycle.delete", {}), { deleted: true });
    const empty = await acquire();
    expect(await readById(storage(empty))).toBeUndefined();
    expect(empty.snapshot(authority)?.entry).toBeUndefined();
  });

  it("installs multi-session replacements atomically and authorizes every affected owner", async () => {
    const { actor, store, acquire } = await fixture(true);
    const sibling = await acquire(siblingKey);
    const siblingStore = storage(sibling);
    await create(siblingStore, { sessionId: "sibling", updatedAt: 1 });
    const first = await entry(store);
    const second = await entry(siblingStore);
    const replacements = [
      { sessionKey, expected: first, entry: { ...first!, label: "One" } },
      { sessionKey: siblingKey, expected: second, entry: { ...second!, label: "Two" } },
    ];
    const result = await store.mutate(
      { type: "session.entry.replacements", input: { replacements } },
      {
        assertCurrent() {},
        authorize(stage, facts) {
          if (stage === "commit" && facts.target.sessionKey === siblingKey) {
            throw new Error("sibling access revoked");
          }
        },
      },
    );
    expectRollback(result, { message: "sibling access revoked" });
    expect(actor.snapshot(authority)?.entry?.label).toBeUndefined();
    expect(sibling.snapshot(authority)?.entry?.label).toBeUndefined();
    await expectCommitted(mutate(store, "session.entry.replacements", { replacements }));
    expect(sibling.snapshot(authority)?.entry?.label).toBe("Two");
  });

  it("authorizes ownership changes against the current owner before installing the replacement", async () => {
    const { actor, store } = await fixture();
    await create(store, {
      sessionId: "session-1",
      updatedAt: 1,
      owner: { actor: { type: "human", id: "private-owner" } },
    });
    const result = await store.mutate(
      {
        type: "session.entry.patch",
        input: fields({ owner: { actor: { type: "human", id: "caller" } } }),
      },
      {
        assertCurrent() {},
        authorize(_stage, facts) {
          if (facts.entry?.owner?.actor.id !== "caller") {
            throw new Error("Current owner denies transfer");
          }
        },
      },
    );
    expectRollback(result, { message: "Current owner denies transfer" });
    expect(actor.snapshot(authority)?.entry?.owner?.actor.id).toBe("private-owner");
  });

  it("keeps committed results after publication failure and detaches observer and caller values", async () => {
    const { actor, store } = await fixture(true);
    const result = await store.mutate(
      { type: "session.entry.patch", input: fields({ label: "Saved" }) },
      authority,
      {
        committed(outcome) {
          outcome.changes[0]!.after!.entry!.label = "Observer mutation";
          throw new Error("publication failed");
        },
      },
    );
    expect(result).toMatchObject({
      kind: "committed",
      value: { label: "Saved" },
      failure: { message: "publication failed" },
    });
    assert(result.kind === "committed", "Expected committed result");
    result.value!.label = "Caller mutation";
    Object.assign(result.changes[0]!.after!.version, { sequence: 100 });
    expect(actor.snapshot(authority)?.entry?.label).toBe("Saved");
    expect(actor.snapshot(authority)?.version.sequence).not.toBe(100);
  });

  it("settles retired pending custody without touching a reused key in the current window", async () => {
    const { store, acquire } = await fixture(true);
    const oldInput = {
      sessionKey,
      sessionId: "session-1",
      idempotencyKey: "reused",
      runId: "old-run",
      requestHash: "old-hash",
      lifecycleGeneration: "old-lifecycle",
    };
    const stage = async (
      selected: SessionActorStorage,
      input: typeof oldInput,
      inputId: string,
    ) => {
      const expected = await read(selected, "session.pendingInput.read", {
        ...input,
        kind: "stage",
        trackCompletion: true,
      });
      assert(expected.kind === "stage", "Expected staging snapshot");
      return mutate(selected, "session.pendingInput.mutate", {
        ...input,
        kind: "stage",
        expected,
        inputId,
        trackCompletion: true,
        messageJson: JSON.stringify({ role: "user", content: inputId, timestamp: 1 }),
      });
    };
    await expectCommitted(stage(store, oldInput, "old-input"));
    const expected = await entry(store);
    await expectCommitted(reset(store, expected));
    const current = storage(await acquire());
    const newInput = {
      ...oldInput,
      sessionId: "session-2",
      runId: "new-run",
      requestHash: "new-hash",
      lifecycleGeneration: "new-lifecycle",
    };
    await expectCommitted(stage(current, newInput, "new-input"));
    await expectCommitted(
      mutate(current, "session.pendingInput.mutate", {
        ...oldInput,
        kind: "finish",
        inputId: "old-input",
        disposition: "interrupted",
      }),
    );
    const old = await pendingHistory(current, "session-1");
    const fresh = await pendingHistory(current, "session-2");
    expect(old).toMatchObject({
      currentSessionId: "session-2",
      rows: [{ input_id: "old-input", state: "interrupted" }],
    });
    expect(fresh).toMatchObject({
      currentSessionId: "session-2",
      rows: [{ input_id: "new-input", state: "queued" }],
    });
  });

  it("drains accepted storage writes through release and respects close before queued effects", async () => {
    const { actor, store, acquire, owner } = await fixture();
    const accepted = create(store);
    const release = actor.release();
    await expectCommitted(accepted);
    await release;
    expect(() => create(store)).toThrow("released");
    const current = await acquire();
    expect(current.snapshot(authority)?.entry?.sessionId).toBe("session-1");
    const pending = mutate(
      storage(current),
      "session.entry.patch",
      fields({ label: "Must not commit" }),
    );
    owner.closeSession(sessionKey);
    expectRollback(await pending, { message: "Incognito session actor is closed" });
    expect((await acquire()).snapshot(authority)?.entry).toBeUndefined();
  });
});
