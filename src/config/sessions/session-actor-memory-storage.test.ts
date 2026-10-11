import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActor, SessionActorAuthority } from "./session-actor-contract.js";
import { createMemorySessionActorOwner } from "./session-actor-memory.js";
import type { SessionActorStorage } from "./session-actor-storage-contract.js";
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

const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const sessionKey = "agent:main:dashboard:incognito-storage";
const siblingKey = "agent:main:dashboard:incognito-sibling";
const owners: ReturnType<typeof createMemorySessionActorOwner>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.close();
  }
});

function storage(actor: SessionActor): SessionActorStorage {
  if (!actor.storage) {
    throw new Error("Memory actor has no storage capability");
  }
  return actor.storage;
}
async function fixture() {
  const owner = createMemorySessionActorOwner({ agentId: "main", path: "/synthetic/incognito" });
  owners.push(owner);
  const acquire = (key = sessionKey) =>
    owner.acquire({ database: owner.identity, sessionKey: key }, lifetime);
  const actor = await acquire();
  return { owner, acquire, actor, store: storage(actor) };
}
function create(
  store: SessionActorStorage,
  entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 },
) {
  return store.mutate(
    { type: "session.entry.create", input: { entry, cwd: "/synthetic" } },
    authority,
  );
}

describe("actor-owned memory storage", () => {
  it("creates without a user turn and serializes typed patches with phase writes across handles", async () => {
    const { actor, store, acquire } = await fixture();
    expect(await create(store)).toMatchObject({ kind: "committed", value: { incognito: true } });
    expect(
      await store.read({ type: "session.history.hydrate", input: {} }, authority),
    ).toMatchObject({
      kind: "full",
      snapshot: { events: [{ type: "session", id: "session-1" }] },
    });
    const second = await acquire();
    const phaseWrite = actor.patch(
      { commandId: "activity", phaseId: "turn", reducers: [{ kind: "activity", updatedAt: 50 }] },
      authority,
    );
    const patch = storage(second).mutate(
      {
        type: "session.entry.patch",
        input: {
          operation: { kind: "fields", patch: { label: "Current" } },
          preserveActivity: true,
        },
      },
      authority,
    );
    const queuedRead = store.read({ type: "session.entry.read", input: {} }, authority);
    expect((await phaseWrite).kind).toBe("committed");
    expect((await patch).kind).toBe("committed");
    expect(await queuedRead).toMatchObject({ updatedAt: 50, label: "Current", incognito: true });
    await Promise.all([actor.release(), second.release()]);
    const reopened = await acquire();
    expect(
      await storage(reopened).read({ type: "session.entry.read", input: {} }, authority),
    ).toMatchObject({ label: "Current" });
  });

  it("rejects a prepared overwrite after an intervening write without losing either field", async () => {
    const { actor, store } = await fixture();
    await create(store);
    const expected = await store.read({ type: "session.entry.read", input: {} }, authority);
    await actor.patch(
      { commandId: "activity", phaseId: "turn", reducers: [{ kind: "activity", updatedAt: 50 }] },
      authority,
    );
    const result = await store.mutate(
      {
        type: "session.entry.replace",
        input: { expected, entry: { ...expected!, label: "Stale" } },
      },
      authority,
    );
    expect(result).toMatchObject({
      kind: "rolled-back",
      error: { name: "SqliteSessionMutationConflictError" },
    });
    expect(await store.read({ type: "session.entry.read", input: {} }, authority)).toMatchObject({
      updatedAt: 50,
    });
    expect(actor.snapshot(authority)?.entry?.label).toBeUndefined();
  });

  it("retains reset windows, closes old handles, and deletes all owned history", async () => {
    const { actor, store, acquire } = await fixture();
    await create(store);
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
    const expected = await store.read({ type: "session.entry.read", input: {} }, authority);
    const reset = await store.mutate(
      {
        type: "session.lifecycle.reset",
        input: {
          expected,
          nextEntry: { ...expected!, sessionId: "session-2" },
          resetBoundary: {
            context: "clear",
            reason: "reset",
            cwd: "/synthetic",
            boundaryId: "reset-1",
          },
        },
      },
      authority,
    );
    expect(reset).toMatchObject({
      kind: "committed",
      value: {
        progressCardReset: true,
        previousSessionId: "session-1",
        nextEntry: { sessionId: "session-2" },
      },
    });
    expect(() => actor.snapshot(authority)).toThrow("closed");
    const current = await acquire();
    const currentStore = storage(current);
    expect(
      await currentStore.read(
        { type: "session.history.hydrate", input: { sessionId: "session-1" } },
        authority,
      ),
    ).toMatchObject({
      kind: "full",
      snapshot: {
        events: [{ type: "session" }, { id: "custom" }, { type: "reset", id: "reset-1" }],
      },
    });
    expect(
      await currentStore.read(
        { type: "session.entry.readById", input: { sessionId: "session-1" } },
        authority,
      ),
    ).toMatchObject({ sessionKey, entry: { sessionId: "session-1" } });
    expect(
      await currentStore.mutate({ type: "session.lifecycle.delete", input: {} }, authority),
    ).toMatchObject({ kind: "committed", value: { deleted: true } });
    const empty = await acquire();
    expect(
      await storage(empty).read(
        { type: "session.entry.readById", input: { sessionId: "session-1" } },
        authority,
      ),
    ).toBeUndefined();
    expect(empty.snapshot(authority)?.entry).toBeUndefined();
  });

  it("installs multi-session replacements atomically and authorizes every affected owner", async () => {
    const { actor, store, acquire } = await fixture();
    await create(store);
    const sibling = await acquire(siblingKey);
    const siblingStore = storage(sibling);
    await create(siblingStore, { sessionId: "sibling", updatedAt: 1 });
    const first = await store.read({ type: "session.entry.read", input: {} }, authority);
    const second = await siblingStore.read({ type: "session.entry.read", input: {} }, authority);
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
    expect(result).toMatchObject({
      kind: "rolled-back",
      error: { message: "sibling access revoked" },
    });
    expect(actor.snapshot(authority)?.entry?.label).toBeUndefined();
    expect(sibling.snapshot(authority)?.entry?.label).toBeUndefined();
    expect(
      (
        await store.mutate(
          { type: "session.entry.replacements", input: { replacements } },
          authority,
        )
      ).kind,
    ).toBe("committed");
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
        input: {
          operation: {
            kind: "fields",
            patch: { owner: { actor: { type: "human", id: "caller" } } },
          },
        },
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
    expect(result).toMatchObject({
      kind: "rolled-back",
      error: { message: "Current owner denies transfer" },
    });
    expect(actor.snapshot(authority)?.entry?.owner?.actor.id).toBe("private-owner");
  });

  it("keeps committed results after publication failure and detaches observer and caller values", async () => {
    const { actor, store } = await fixture();
    await create(store);
    const result = await store.mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { label: "Saved" } } },
      },
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
    if (result.kind !== "committed") {
      throw new Error("Expected committed result");
    }
    result.value!.label = "Caller mutation";
    Object.assign(result.changes[0]!.after!.version, { sequence: 100 });
    expect(actor.snapshot(authority)?.entry?.label).toBe("Saved");
    expect(actor.snapshot(authority)?.version.sequence).not.toBe(100);
  });

  it("settles retired pending custody without touching a reused key in the current window", async () => {
    const { store, acquire } = await fixture();
    await create(store);
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
      const expected = await selected.read(
        {
          type: "session.pendingInput.read",
          input: { ...input, kind: "stage", trackCompletion: true },
        },
        authority,
      );
      if (expected.kind !== "stage") {
        throw new Error("Expected staging snapshot");
      }
      return selected.mutate(
        {
          type: "session.pendingInput.mutate",
          input: {
            ...input,
            kind: "stage",
            expected,
            inputId,
            trackCompletion: true,
            messageJson: JSON.stringify({ role: "user", content: inputId, timestamp: 1 }),
          },
        },
        authority,
      );
    };
    expect((await stage(store, oldInput, "old-input")).kind).toBe("committed");
    const expected = await store.read({ type: "session.entry.read", input: {} }, authority);
    expect(
      (
        await store.mutate(
          {
            type: "session.lifecycle.reset",
            input: { expected, nextEntry: { ...expected!, sessionId: "session-2" } },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    const current = storage(await acquire());
    const newInput = {
      ...oldInput,
      sessionId: "session-2",
      runId: "new-run",
      requestHash: "new-hash",
      lifecycleGeneration: "new-lifecycle",
    };
    expect((await stage(current, newInput, "new-input")).kind).toBe("committed");
    expect(
      (
        await current.mutate(
          {
            type: "session.pendingInput.mutate",
            input: {
              ...oldInput,
              kind: "finish",
              inputId: "old-input",
              disposition: "interrupted",
            },
          },
          authority,
        )
      ).kind,
    ).toBe("committed");
    const old = await current.read(
      { type: "session.pendingInput.history", input: { sessionKey, sessionId: "session-1" } },
      authority,
    );
    const fresh = await current.read(
      { type: "session.pendingInput.history", input: { sessionKey, sessionId: "session-2" } },
      authority,
    );
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
    expect((await accepted).kind).toBe("committed");
    await release;
    expect(() => create(store)).toThrow("released");
    const current = await acquire();
    expect(current.snapshot(authority)?.entry?.sessionId).toBe("session-1");
    const pending = storage(current).mutate(
      {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { label: "Must not commit" } } },
      },
      authority,
    );
    owner.closeSession(sessionKey);
    expect(await pending).toMatchObject({
      kind: "rolled-back",
      error: { message: "Incognito session actor is closed" },
    });
    expect((await acquire()).snapshot(authority)?.entry).toBeUndefined();
  });
});
