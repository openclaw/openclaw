import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createSessionEntryWithTranscriptInScope } from "./session-accessor.sqlite-creation.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import type { SessionActorStorage } from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
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
const mutate = <Key extends keyof SessionActorStorageWrites>(
  storage: SessionActorStorage,
  command: { type: Key; input: SessionActorStorageWrites[Key]["input"] },
) => storage.mutate(command, authority);
const readHistory = (storage: SessionActorStorage) =>
  storage.read({ type: "session.history.hydrate", input: {} }, authority);
async function commit<Key extends keyof SessionActorStorageWrites>(
  storage: SessionActorStorage,
  command: { type: Key; input: SessionActorStorageWrites[Key]["input"] },
) {
  expect(await storage.mutate(command, authority)).toMatchObject({ kind: "committed" });
}
const owned: Array<{ agentId: string; path: string }> = [];
afterEach(() => {
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
  const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
  const binding = { ...options, actor, authority };
  const scope = { agentId: "main", storePath: options.path, sessionKey, env };
  await runWithSessionActorStorage(binding, () =>
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
  };
}

describe("generic session entry APIs with actor memory storage", () => {
  it("merges concurrent fixed patches and exposes detached read-after-write results", async () => {
    const { actor, binding, scope } = await fixture("fixed-patches");
    await runWithSessionActorStorage(binding, async () => {
      const before = loadSessionEntryReadOnly(scope);
      await Promise.all([
        upsertSessionEntryCore(scope, { label: "Renamed" }),
        upsertSessionEntryCore(scope, {
          model: "synthetic-model",
          skillsSnapshot: { prompt: "Retained prompt", skills: [] },
        }),
      ]);
      expect(loadSessionEntryReadOnly(scope)).toMatchObject({
        sessionId: "fixed-patches",
        label: "Renamed",
        model: "synthetic-model",
        skillsSnapshot: { prompt: "Retained prompt", skills: [] },
      });
      expect(before?.label).toBe("Original");
      const detached = loadSessionEntryReadOnly(scope)!;
      detached.skillsSnapshot!.prompt = "Caller edit";
      expect(loadSessionEntryReadOnly(scope)?.skillsSnapshot?.prompt).toBe("Retained prompt");
    });
    await actor.release();
  });

  it("rejects an asynchronous updater's stale snapshot without losing an intervening patch", async () => {
    const { actor, binding, scope } = await fixture("callback-conflict");
    await runWithSessionActorStorage(binding, async () => {
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
    await actor.release();
  });

  it("creates over an existing entry with its transcript, owner, and explicit label together", async () => {
    const { actor, binding, scope, creationScope } = await fixture("creation");
    const owner: SessionOwnerAssignment = {
      actor: { type: "human", id: "synthetic-owner" },
      assignedBy: { type: "system" },
      assignedAt: 20,
    };
    const events = [
      createSessionTranscriptHeader({
        sessionId: "replacement",
        cwd: "/synthetic/workspace",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      {
        type: "custom",
        id: "retained-event",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        customType: "synthetic-payload",
        data: { text: "Prepared transcript payload" },
      },
    ];
    await runWithSessionActorStorage(binding, async () => {
      expect(
        await createSessionEntryWithTranscriptInScope(
          creationScope,
          ({ existingEntry, targetEntry, labelInUse }) => {
            expect(existingEntry).toMatchObject({ sessionId: "creation", label: "Original" });
            expect(targetEntry).toEqual(existingEntry);
            expect(labelInUse).toBe(false);
            return {
              ok: true,
              entry: { sessionId: "replacement", updatedAt: 20, label: "Callback label" },
              transcriptEvents: events,
            };
          },
          { label: "Requested label", resolveOwnerAssignment: () => owner },
        ),
      ).toMatchObject({
        ok: true,
        entry: { sessionId: "replacement", label: "Requested label", owner },
      });
    });
    const current = await actor.storage!.acquire(scope.sessionKey);
    await runWithSessionActorStorage({ ...binding, actor: current }, async () => {
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
    await Promise.all([actor.release(), current.release()]);
  });

  it.each([
    ["target changed", "SqliteSessionMutationConflictError", "target-changed"],
    ["label claimed", "SessionLabelConflictError", "label-claimed"],
  ])(
    "rejects prepared creation when %s without installing its transcript or owner",
    async (change, errorName, fixtureName) => {
      const { actor, binding, scope, creationScope } = await fixture(fixtureName);
      await runWithSessionActorStorage(binding, async () => {
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const pending = createSessionEntryWithTranscriptInScope(
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
            const siblingKey = `${scope.sessionKey}-sibling`;
            const sibling = await actor.storage!.acquire(siblingKey);
            try {
              await runWithSessionActorStorage({ ...binding, actor: sibling }, () =>
                upsertSessionEntryCore(
                  { ...scope, sessionKey: siblingKey },
                  { sessionId: "sibling", updatedAt: 2, label: "Claimed label" },
                ),
              );
            } finally {
              await sibling.release();
            }
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
      await actor.release();
    },
  );

  it("preserves full payloads in exact replacements and rolls back a batch if a selected row changed", async () => {
    const { actor, binding, scope } = await fixture("replacements");
    const siblingKey = `${scope.sessionKey}-sibling`;
    const sibling = await actor.storage!.acquire(siblingKey);
    const siblingScope = { ...scope, sessionKey: siblingKey };
    const snapshot: NonNullable<SessionEntry["skillsSnapshot"]> = {
      prompt: "Retained prompt and tool instructions",
      skills: [{ name: "synthetic-skill" }],
    };
    await runWithSessionActorStorage({ ...binding, actor: sibling }, () =>
      upsertSessionEntryCore(siblingScope, {
        sessionId: "sibling",
        updatedAt: 2,
        skillsSnapshot: snapshot,
      }),
    );
    await runWithSessionActorStorage(binding, async () => {
      const params = {
        agentId: "main",
        storePath: scope.storePath,
        sessionKeys: [scope.sessionKey],
        includeSessionWindowOwner: "sibling",
      };
      expect(
        await applySessionEntryExactReplacements({
          ...params,
          update: (rows) => ({
            result: "committed",
            replacements: rows.map(({ sessionKey, entry }) => ({
              sessionKey,
              entry: {
                ...entry,
                label: sessionKey === scope.sessionKey ? "Batch primary" : "Batch sibling",
              },
            })),
          }),
        }),
      ).toBe("committed");
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const pending = applySessionEntryExactReplacements({
        ...params,
        sessionKeys: [scope.sessionKey, siblingKey],
        update: async (rows) => {
          entered.resolve();
          await resume.promise;
          return {
            result: "stale",
            replacements: rows.map(({ sessionKey, entry }) => ({
              sessionKey,
              entry: { ...entry, label: "Stale batch" },
            })),
          };
        },
      });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "SqliteSessionMutationConflictError",
      });
      await entered.promise;
      try {
        await runWithSessionActorStorage({ ...binding, actor: sibling }, () =>
          upsertSessionEntryCore(siblingScope, { label: "Concurrent sibling edit" }),
        );
      } finally {
        resume.resolve();
      }
      await rejected;
      expect(loadSessionEntryReadOnly(scope)?.label).toBe("Batch primary");
    });
    runWithSessionActorStorage({ ...binding, actor: sibling }, () => {
      expect(loadSessionEntryReadOnly(siblingScope)).toMatchObject({
        label: "Concurrent sibling edit",
        skillsSnapshot: snapshot,
      });
    });
    await Promise.all([actor.release(), sibling.release()]);
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
    await expect(applySessionEntryExactReplacements({ ...scope, update })).resolves.toBe("absent");
    await expect(
      applySessionEntryExactReplacements({ ...scope, update, requireWriteSuccess: true }),
    ).rejects.toThrow("did not persist any rows");
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
      await runWithSessionActorStorage(binding, () =>
        applySessionEntryExactReplacements({
          agentId: target.agentId,
          storePath: target.path,
          sessionKeys: [sessionKey],
          requireWriteSuccess: true,
          update: (entries) => ({
            result: undefined,
            replacements: entries.map((row) => ({
              sessionKey: row.sessionKey,
              entry: { ...row.entry, label: "Other replaced" },
            })),
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
    const { actor, scope } = await fixture("unbound-replacement");
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
        applySessionEntryExactReplacements({
          agentId: scope.agentId,
          storePath: scope.storePath,
          sessionKeys: [scope.sessionKey],
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
        applySessionEntryExactReplacements({
          agentId: scope.agentId,
          storePath: scope.storePath,
          sessionKeys: [scope.sessionKey],
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
    runWithSessionActorStorage(binding, () => {
      expect(getSessionActorStorageBinding({ sessionKey })?.actor).toBe(binding.actor);
      expect(() =>
        getSessionActorStorageBinding({ sessionKey: "agent:main:dashboard:incognito-other" }),
      ).toThrow("another session");
      expect(getSessionActorStorageBinding({ sessionKey: "agent:main:durable" })).toBeUndefined();
      expect(() =>
        getSessionActorStorageBinding({ sessionKey: "agent:main:durable", sessionActor: binding }),
      ).toThrow("another session");
      expect(
        getSessionActorStorageBinding({
          sessionKey,
          storePath: path.join(env.OPENCLAW_STATE_DIR, "agents/main/sessions/sessions.json"),
        })?.actor,
      ).toBe(binding.actor);
      const foreign = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: "/synthetic/actor-storage-binding/foreign" },
      });
      expect(() => getSessionActorStorageBinding({ sessionKey, storePath: foreign })).toThrow(
        "another owner",
      );
    });
  });

  it("reads committed sibling state without acquisition and closes public handles with their session", async () => {
    const { actor, storage, owner, sessionKey } = await fixture("siblings");
    const siblingKey = "agent:main:dashboard:incognito-sibling";
    const sibling = await owner.acquire(
      { database: owner.identity, sessionKey: siblingKey },
      lifetime,
    );
    expect(
      await mutate(sibling.storage!, {
        type: "session.entry.create",
        input: { entry: { sessionId: "sibling", updatedAt: 2 } },
      }),
    ).toMatchObject({ kind: "committed" });
    expect(readCurrentEntry(storage, siblingKey)).toMatchObject({
      sessionId: "sibling",
      updatedAt: 2,
    });
    expect(
      await mutate(sibling.storage!, {
        type: "session.entry.patch",
        input: { operation: { kind: "fields", patch: { label: "changed" } } },
      }),
    ).toMatchObject({ kind: "committed" });
    expect(readCurrentEntry(storage, siblingKey)).toMatchObject({ label: "changed" });
    owner.closeSession(sessionKey);
    expect(() => actor.assertCurrent()).toThrow(/closed/);
    expect(() => actor.assertReadable()).toThrow(/closed/);
    expect(() => readCurrentEntry(storage, siblingKey)).toThrow(/closed/);
    expect(() => sibling.assertReadable()).not.toThrow();
    await Promise.all([actor.release(), sibling.release()]);
  });

  it("acquires separate handles from the captured owner after rotation and release", async () => {
    const { actor, storage, sessionKey } = await fixture("rotate");
    const before = readCurrentEntry(storage)!;
    expect(
      await mutate(storage, {
        type: "session.lifecycle.reset",
        input: { expected: before, nextEntry: { ...before, sessionId: "rotated" } },
      }),
    ).toMatchObject({ kind: "committed" });
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
