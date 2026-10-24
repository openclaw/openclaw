import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createSessionEntryWithTranscriptInScope as createEntry } from "./session-accessor.sqlite-creation.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements as replaceExact } from "./session-accessor.sqlite-replacement-projection.js";
import type { SessionActor, SessionActorStorage } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  getSessionActorStorageBinding as getBinding,
  runWithSessionActorStorage as bindStorage,
} from "./session-actor-storage-binding.js";
import type { SessionActorStorageWrites } from "./session-actor-storage-contract.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import * as maintenanceRuntime from "./store-maintenance-runtime.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const readEntry = (storage: SessionActorStorage) =>
  storage.read({ type: "session.entry.read", input: {} }, authority);
const readCurrentEntry = (storage: SessionActorStorage, sessionKey?: string) =>
  storage.readCurrent({ type: "session.entry.read", input: { sessionKey } }, authority);
const readHistory = (storage: SessionActorStorage) =>
  storage.read({ type: "session.history.hydrate", input: {} }, authority);
async function commit<Key extends keyof SessionActorStorageWrites>(
  storage: SessionActorStorage,
  command: { type: Key; input: SessionActorStorageWrites[Key]["input"] },
) {
  expect(await storage.mutate(command, authority)).toMatchObject({ kind: "committed" });
}
const owned: Array<{ agentId: string; path: string }> = [];
const actors: SessionActor[] = [];
function own<T extends SessionActor>(actor: T): T {
  actors.push(actor);
  return actor;
}
type SelectedRows = Parameters<Parameters<typeof replaceExact>[0]["update"]>[0];
const labels = (rows: SelectedRows, label: string | ((key: string) => string)) =>
  rows.map(({ sessionKey, entry }) => ({
    sessionKey,
    entry: { ...entry, label: typeof label === "string" ? label : label(sessionKey) },
  }));

afterEach(async () => {
  await Promise.all(actors.splice(0).map((actor) => actor.release()));
  vi.restoreAllMocks();
  for (const options of owned.splice(0)) {
    memorySessionActorOwners.closeDatabase(options);
  }
});

async function fixture(name: string) {
  const env = { OPENCLAW_STATE_DIR: `/synthetic/actor-entry-adapter/${name}` };
  const options = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  owned.push(options);
  const owner = memorySessionActorOwners.get(options);
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const actor = own(await owner.acquire({ database: owner.identity, sessionKey }, lifetime));
  const binding = { ...options, actor, authority };
  const scope = { agentId: "main", storePath: options.path, sessionKey, env };
  const run = <T>(callback: () => T) => bindStorage(binding, callback);
  await bindStorage(binding, () =>
    upsertSessionEntryCore(scope, { sessionId: name, updatedAt: 1, label: "Original" }),
  );
  return {
    actor,
    binding,
    scope,
    env,
    owner,
    sessionKey,
    storage: actor.storage!,
    creationScope: { ...options, sessionKey, env },
    selection: { agentId: "main", storePath: options.path, sessionKeys: [sessionKey] },
    run,
    read: () => run(() => loadSessionEntryReadOnly(scope)),
    patch: (patch: Partial<SessionEntry>) => run(() => upsertSessionEntryCore(scope, patch)),
    async sibling(sessionId: string, entry: Partial<SessionEntry> = {}) {
      const key = `${sessionKey}-${sessionId}`;
      const sibling = own(await actor.storage!.acquire(key));
      await bindStorage({ ...binding, actor: sibling }, () =>
        upsertSessionEntryCore(
          { ...scope, sessionKey: key },
          { sessionId, updatedAt: 2, ...entry },
        ),
      );
      return { actor: sibling, key, storage: sibling.storage! };
    },
  };
}

describe("generic session entry APIs with actor memory storage", () => {
  it("merges concurrent fixed patches and exposes detached read-after-write results", async () => {
    const { run, read, patch } = await fixture("fixed-patches");
    await run(async () => {
      const before = read();
      await Promise.all([
        patch({ label: "Renamed" }),
        patch({
          model: "synthetic-model",
          skillsSnapshot: { prompt: "Retained prompt", skills: [] },
        }),
      ]);
      expect(read()).toMatchObject({
        sessionId: "fixed-patches",
        label: "Renamed",
        model: "synthetic-model",
        skillsSnapshot: { prompt: "Retained prompt", skills: [] },
      });
      expect(before?.label).toBe("Original");
      const detached = read()!;
      detached.skillsSnapshot!.prompt = "Caller edit";
      expect(read()?.skillsSnapshot?.prompt).toBe("Retained prompt");
    });
  });

  it("rejects an asynchronous updater's stale snapshot without losing an intervening patch", async () => {
    const { binding, scope } = await fixture("callback-conflict");
    await bindStorage(binding, async () => {
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const pending = patchSessionEntryCore(scope, async (entry) => {
        entry.label = "Stale callback";
        entered.resolve();
        await resume.promise;
        return entry;
      });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "SqliteSessionMutationConflictError",
      });
      await entered.promise;
      expect(loadSessionEntryReadOnly(scope)?.label).toBe("Original");
      try {
        await upsertSessionEntryCore(scope, { label: "Concurrent edit", model: "kept-model" });
      } finally {
        resume.resolve();
      }
      await rejected;
      expect(loadSessionEntryReadOnly(scope)).toMatchObject({
        label: "Concurrent edit",
        model: "kept-model",
      });
    });
  });

  it("creates over an existing entry with its transcript, owner, and explicit label together", async () => {
    const { actor, binding, scope, creationScope } = await fixture("creation");
    const owner: SessionOwnerAssignment = {
      actor: { type: "human", id: "synthetic-owner" },
      assignedBy: { type: "system" },
      assignedAt: 20,
    };
    const events = [
      createSessionTranscriptHeader({ sessionId: "replacement" }),
      { type: "custom", id: "retained-event", customType: "synthetic", data: { text: "payload" } },
    ];
    const created = await bindStorage(binding, () =>
      createEntry(
        creationScope,
        () => ({
          ok: true,
          entry: { sessionId: "replacement", updatedAt: 20, label: "Callback label" },
          transcriptEvents: events,
        }),
        { label: "Requested label", resolveOwnerAssignment: () => owner },
      ),
    );
    expect(created.ok).toBe(true);
    const current = own(await actor.storage!.acquire(scope.sessionKey));
    await bindStorage({ ...binding, actor: current }, async () => {
      expect(loadSessionEntryReadOnly(scope)).toMatchObject({
        sessionId: "replacement",
        label: "Requested label",
        owner,
      });
      expect(await readHistory(current.storage!)).toMatchObject({
        kind: "full",
        snapshot: { events },
      });
    });
  });

  it.each([
    ["target changed", "SqliteSessionMutationConflictError", "target-changed"],
    ["label claimed", "SessionLabelConflictError", "label-claimed"],
  ])(
    "rejects prepared creation when %s without installing its transcript or owner",
    async (change, errorName, fixtureName) => {
      const { actor, binding, scope, creationScope, sibling } = await fixture(fixtureName);
      await bindStorage(binding, async () => {
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const pending = createEntry(
          creationScope,
          async () => {
            entered.resolve();
            await resume.promise;
            return {
              ok: true,
              entry: { sessionId: "uncommitted", updatedAt: 20 },
              transcriptEvents: [createSessionTranscriptHeader({ sessionId: "uncommitted" })],
            };
          },
          {
            label: "Claimed label",
            resolveOwnerAssignment: () => ({ actor: { type: "human", id: "uncommitted-owner" } }),
          },
        );
        const rejected = expect(pending).rejects.toMatchObject({ name: errorName });
        await entered.promise;
        try {
          if (change === "target changed") {
            await upsertSessionEntryCore(scope, { label: "Concurrent edit" });
          } else {
            await sibling("sibling", { label: "Claimed label" });
          }
        } finally {
          resume.resolve();
        }
        await rejected;
        expect(loadSessionEntryReadOnly(scope)).toMatchObject({
          sessionId: fixtureName,
          label: change === "target changed" ? "Concurrent edit" : "Original",
        });
        expect(loadSessionEntryReadOnly(scope)?.owner).toBeUndefined();
        expect(await readHistory(actor.storage!)).toMatchObject({
          kind: "full",
          snapshot: { events: [] },
        });
      });
    },
  );

  it("preserves full payloads in exact replacements and rolls back a batch if a selected row changed", async () => {
    const { binding, scope, selection, sibling: acquireSibling } = await fixture("replacements");
    const snapshot: NonNullable<SessionEntry["skillsSnapshot"]> = {
      prompt: "Retained prompt and tool instructions",
      skills: [{ name: "synthetic-skill" }],
    };
    const { actor: sibling, key: siblingKey } = await acquireSibling("sibling", {
      skillsSnapshot: snapshot,
    });
    const siblingScope = { ...scope, sessionKey: siblingKey };
    await bindStorage(binding, async () => {
      const params = {
        ...selection,
        includeSessionWindowOwner: "sibling",
      };
      expect(
        await replaceExact({
          ...params,
          update: (rows) => ({
            result: "committed",
            replacements: labels(rows, (key) =>
              key === scope.sessionKey ? "Batch primary" : "Batch sibling",
            ),
          }),
        }),
      ).toBe("committed");
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const pending = replaceExact({
        ...params,
        sessionKeys: [scope.sessionKey, siblingKey],
        update: async (rows) => {
          entered.resolve();
          await resume.promise;
          return {
            result: "stale",
            replacements: labels(rows, "Stale batch"),
          };
        },
      });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "SqliteSessionMutationConflictError",
      });
      await entered.promise;
      try {
        await bindStorage({ ...binding, actor: sibling }, () =>
          upsertSessionEntryCore(siblingScope, { label: "Concurrent sibling edit" }),
        );
      } finally {
        resume.resolve();
      }
      await rejected;
      expect(loadSessionEntryReadOnly(scope)?.label).toBe("Batch primary");
    });
    bindStorage({ ...binding, actor: sibling }, () => {
      expect(loadSessionEntryReadOnly(siblingScope)).toMatchObject({
        label: "Concurrent sibling edit",
        skillsSnapshot: snapshot,
      });
    });
  });
  it("keeps absent replacement reads noncreating and rejects required writes", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/actor-entry-adapter/absent-replacement" };
    const scope = {
      agentId: "main",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      sessionKeys: ["agent:main:dashboard:incognito-absent-replacement"],
    };
    const update = (rows: unknown[]) => {
      expect(rows).toEqual([]);
      return {
        result: "absent",
        replacements: [
          { sessionKey: scope.sessionKeys[0]!, entry: { sessionId: "absent", updatedAt: 1 } },
        ],
      };
    };
    await expect(replaceExact({ ...scope, update })).resolves.toBe("absent");
    await expect(replaceExact({ ...scope, update, requireWriteSuccess: true })).rejects.toThrow(
      "did not persist any rows",
    );
    expect(
      memorySessionActorOwners.read({ agentId: scope.agentId, path: scope.storePath }),
    ).toBeUndefined();
  });

  it("replaces the requested agent's entries while another agent is bound", async () => {
    const { actor, binding, scope } = await fixture("cross-agent-replacement");
    const target = {
      agentId: "other",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "other", env: scope.env }),
    };
    owned.push(target);
    const owner = memorySessionActorOwners.get(target);
    const sessionKey = "agent:other:dashboard:incognito-replacement";
    const other = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
    try {
      await commit(other.storage!, {
        type: "session.entry.create",
        input: { entry: { sessionId: "other", updatedAt: 1, label: "Other original" } },
      });
      await bindStorage(binding, () =>
        replaceExact({
          agentId: target.agentId,
          storePath: target.path,
          sessionKeys: [sessionKey],
          requireWriteSuccess: true,
          update: (entries) => ({
            result: undefined,
            replacements: labels(entries, "Other replaced"),
          }),
        }),
      );
      expect(await readEntry(other.storage!)).toMatchObject({ label: "Other replaced" });
      expect(await readEntry(actor.storage!)).toMatchObject({ label: "Original" });
    } finally {
      await Promise.all([actor.release(), other.release()]);
    }
  });

  it("replaces existing unbound memory entries, consumes pending reset, and applies maintenance", async () => {
    const { actor, scope, selection } = await fixture("unbound-replacement");
    const staleKey = "agent:main:dashboard:incognito-replacement-stale";
    const stale = await actor.storage!.acquire(staleKey);
    try {
      const original = await readEntry(actor.storage!);
      await commit(actor.storage!, {
        type: "session.entry.replace",
        input: { expected: original, entry: { ...original!, updatedAt: 0 } },
      });
      await commit(stale.storage!, {
        type: "session.entry.create",
        input: {
          entry: { sessionId: "stale", updatedAt: 1 },
          transcriptEvents: [{ type: "metadata", id: "retained" }],
        },
      });
      vi.spyOn(maintenanceRuntime, "resolveMaintenanceConfig").mockReturnValue(
        resolveMaintenanceConfigFromInput({ mode: "enforce", pruneAfter: "1d", maxEntries: 100 }),
      );
      const replace = (consumePendingReset: boolean) =>
        replaceExact({
          ...selection,
          activeSessionKey: scope.sessionKey,
          consumePendingReset,
          skipMaintenance: !consumePendingReset,
          update: (rows) => ({
            result: "updated",
            replacements: rows.map(({ sessionKey, entry }) => ({
              sessionKey,
              entry: { ...entry, updatedAt: Date.now(), label: "Replaced" },
            })),
          }),
        });
      await replace(false);
      expect((await readEntry(actor.storage!))?.updatedAt).toBe(0);
      expect((await readEntry(stale.storage!))?.archivedAt).toBeUndefined();
      await replace(true);
      expect((await readEntry(actor.storage!))?.updatedAt).toBeGreaterThan(0);
      expect(await readEntry(stale.storage!)).toMatchObject({ archivedAt: expect.any(Number) });
      expect(await readHistory(stale.storage!)).toMatchObject({
        snapshot: { events: [{ type: "metadata", id: "retained" }] },
      });
      await expect(
        replaceExact({
          ...selection,
          update: () => ({
            result: "unselected",
            replacements: [{ sessionKey: staleKey, entry: { sessionId: "stale", updatedAt: 2 } }],
          }),
        }),
      ).rejects.toThrow("outside the selected key set");
    } finally {
      await Promise.all([actor.release(), stale.release()]);
    }
  });
});

describe("selected actor storage binding", () => {
  it("refuses another incognito session or owner while accepting its logical store locator", async () => {
    const { env, sessionKey, binding } = await fixture("scope");
    bindStorage(binding, () => {
      expect(getBinding({ sessionKey })?.actor).toBe(binding.actor);
      expect(() => getBinding({ sessionKey: "agent:main:dashboard:incognito-other" })).toThrow(
        "another session",
      );
      expect(getBinding({ sessionKey: "agent:main:durable" })).toBeUndefined();
      expect(() => getBinding({ sessionKey: "agent:main:durable", sessionActor: binding })).toThrow(
        "another session",
      );
      expect(
        getBinding({
          sessionKey,
          storePath: path.join(env.OPENCLAW_STATE_DIR, "agents/main/sessions/sessions.json"),
        })?.actor,
      ).toBe(binding.actor);
      const foreign = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: "/synthetic/actor-storage-binding/foreign" },
      });
      expect(() => getBinding({ sessionKey, storePath: foreign })).toThrow("another owner");
    });
  });

  it("reads committed sibling state without acquisition and closes public handles with their session", async () => {
    const { storage, owner, sessionKey } = await fixture("siblings");
    const siblingKey = "agent:main:dashboard:incognito-sibling";
    const sibling = own(await storage.acquire(siblingKey));
    await commit(sibling.storage!, {
      type: "session.entry.create",
      input: { entry: { sessionId: "sibling", updatedAt: 2 } },
    });
    expect(readCurrentEntry(storage, siblingKey)).toMatchObject({ sessionId: "sibling" });
    owner.closeSession(sessionKey);
    expect(() => readCurrentEntry(storage, siblingKey)).toThrow(/closed/);
    expect(() => sibling.assertReadable()).not.toThrow();
  });

  it("acquires separate handles from the captured owner after rotation and release", async () => {
    const { actor, storage, sessionKey } = await fixture("rotate");
    const before = readCurrentEntry(storage)!;
    await commit(storage, {
      type: "session.lifecycle.reset",
      input: { expected: before, nextEntry: { ...before, sessionId: "rotated" } },
    });
    expect(() => actor.assertCurrent()).toThrow(/closed/);
    const replacement = await storage.acquire(sessionKey);
    expect(replacement).not.toBe(actor);
    expect(readCurrentEntry(replacement.storage!)).toMatchObject({ sessionId: "rotated" });
    await actor.release();
    const separate = await storage.acquire(sessionKey);
    await replacement.release();
    expect(() => replacement.assertReadable()).toThrow(/released/);
    expect(() => separate.assertReadable()).not.toThrow();
    expect(readCurrentEntry(separate.storage!)).toMatchObject({ sessionId: "rotated" });
    await separate.release();
  });
});
