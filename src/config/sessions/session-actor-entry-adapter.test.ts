import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { UI_RAIL_SHORTCUTS_PREFERENCE_KEY } from "../../../packages/gateway-protocol/src/schema/ui-navigation-preferences.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { setCanonicalUserPreferences } from "../../state/user-preferences.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.js";
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
import { readSessionEntryInWorker as readWorkerEntry } from "./session-entry-read-runtime.js";
import * as maintenanceRuntime from "./store-maintenance-runtime.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const pinDirs = useSessionStoreTempDirs(afterAll, "openclaw-memory-pin-scope-");

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const readEntry = (storage: SessionActorStorage) =>
  storage.read({ type: "session.entry.read", input: {} }, authority);
const readHistory = (storage: SessionActorStorage) =>
  storage.read({ type: "session.history.hydrate", input: {} }, authority);
async function commit<Key extends keyof SessionActorStorageWrites>(
  storage: SessionActorStorage,
  type: Key,
  input: SessionActorStorageWrites[Key]["input"],
) {
  expect(await storage.mutate({ type, input }, authority)).toMatchObject({ kind: "committed" });
}
function pausedPreparation() {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  return {
    async wait() {
      entered.resolve();
      await resume.promise;
    },
    async reject(pending: Promise<unknown>, name: string, intervene: () => Promise<unknown>) {
      const rejected = expect(pending).rejects.toMatchObject({ name });
      await entered.promise;
      try {
        await intervene();
      } finally {
        resume.resolve();
      }
      await rejected;
    },
  };
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

async function fixture(name: string, stateDir = `/synthetic/actor-entry-adapter/${name}`) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
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
    async sibling(this: void, sessionId: string, entry: Partial<SessionEntry> = {}) {
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
    const { run, read, patch, scope } = await fixture("fixed-patches");
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
      await expect(readWorkerEntry({ ...scope, projection: "list" })).resolves.not.toHaveProperty(
        "skillsSnapshot",
      );
      await expect(
        readWorkerEntry({ ...scope, projection: ["skillsSnapshot"] }),
      ).resolves.toMatchObject({ skillsSnapshot: { prompt: "Retained prompt", skills: [] } });
      await expect(readWorkerEntry(scope)).resolves.toMatchObject({
        skillsSnapshot: { prompt: "Retained prompt", skills: [] },
      });
    });
  });

  it("rejects an asynchronous updater's stale snapshot without losing an intervening patch", async () => {
    const { binding, scope } = await fixture("callback-conflict");
    await bindStorage(binding, async () => {
      const preparation = pausedPreparation();
      const pending = patchSessionEntryCore(scope, async (entry) => {
        entry.label = "Stale callback";
        await preparation.wait();
        return entry;
      });
      await preparation.reject(pending, "SqliteSessionMutationConflictError", async () => {
        expect(loadSessionEntryReadOnly(scope)?.label).toBe("Original");
        await upsertSessionEntryCore(scope, { label: "Concurrent edit", model: "kept-model" });
      });
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
    await bindStorage(binding, () =>
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
        const preparation = pausedPreparation();
        const pending = createEntry(
          creationScope,
          async () => {
            await preparation.wait();
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
        await preparation.reject(pending, errorName, async () => {
          if (change === "target changed") {
            await upsertSessionEntryCore(scope, { label: "Concurrent edit" });
          } else {
            await sibling("sibling", { label: "Claimed label" });
          }
        });
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
      await replaceExact({
        ...params,
        update: (rows) => ({
          result: "committed",
          replacements: labels(rows, (key) =>
            key === scope.sessionKey ? "Batch primary" : "Batch sibling",
          ),
        }),
      });
      const preparation = pausedPreparation();
      const pending = replaceExact({
        ...params,
        sessionKeys: [scope.sessionKey, siblingKey],
        update: async (rows) => {
          await preparation.wait();
          return {
            result: "stale",
            replacements: labels(rows, "Stale batch"),
          };
        },
      });
      await preparation.reject(pending, "SqliteSessionMutationConflictError", async () => {
        await bindStorage({ ...binding, actor: sibling }, () =>
          upsertSessionEntryCore(siblingScope, { label: "Concurrent sibling edit" }),
        );
      });
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
    const other = own(await owner.acquire({ database: owner.identity, sessionKey }, lifetime));
    await commit(other.storage!, "session.entry.create", {
      entry: { sessionId: "other", updatedAt: 1, label: "Other original" },
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
  });

  it("replaces existing unbound memory entries, consumes pending reset, and applies maintenance", async () => {
    const { actor, scope, selection } = await fixture("unbound-replacement");
    const staleKey = "agent:main:dashboard:incognito-replacement-stale";
    const stale = own(await actor.storage!.acquire(staleKey));
    const original = await readEntry(actor.storage!);
    await commit(actor.storage!, "session.entry.replace", {
      expected: original,
      entry: { ...original!, updatedAt: 0 },
    });
    await commit(stale.storage!, "session.entry.create", {
      entry: { sessionId: "stale", updatedAt: 1 },
      transcriptEvents: [{ type: "metadata", id: "retained" }],
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
});

it.each(["patch", "cleanup", "replacement"] as const)(
  "uses the memory owner state root for personal pins during %s maintenance",
  async (operation) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now - 40 * 24 * 60 * 60 * 1000);
    const f = await fixture("personal-pin-root", pinDirs.make());
    const unpinned = await f.sibling("unpinned");
    const peer = await f.sibling("newer");
    const profile = ensureProfileForEmail("memory-pin@example.test", { env: f.env }).id;
    expect(
      await setCanonicalUserPreferences(
        profile,
        {
          [UI_RAIL_SHORTCUTS_PREFERENCE_KEY]: [`session:${f.sessionKey}`],
        },
        { env: f.env },
      ),
    ).toMatchObject({ ok: true });
    vi.mocked(Date.now).mockReturnValue(now);
    vi.spyOn(maintenanceRuntime, "resolveMaintenanceConfig").mockReturnValue(
      resolveMaintenanceConfigFromInput({ mode: "enforce", pruneAfter: "1d", maxEntries: 100 }),
    );
    if (operation === "patch") {
      await bindStorage({ ...f.binding, actor: peer.actor }, () =>
        upsertSessionEntryCore(
          { ...f.scope, sessionKey: peer.key },
          { label: "Triggers maintenance" },
        ),
      );
    } else if (operation === "cleanup") {
      await applySessionEntryLifecycleMutation({
        storePath: f.binding.path,
        activeSessionKey: peer.key,
        maintenanceOverride: resolveMaintenanceConfigFromInput({
          mode: "enforce",
          pruneAfter: "1d",
          maxEntries: 100,
        }),
      });
    } else {
      await replaceExact({
        storePath: f.binding.path,
        agentId: "main",
        sessionKeys: [peer.key],
        activeSessionKey: peer.key,
        skipMaintenance: false,
        update: (rows) => ({
          result: undefined,
          replacements: labels(rows, "Triggers maintenance"),
        }),
      });
    }
    expect((await readEntry(unpinned.storage))?.archivedAt).toEqual(expect.any(Number));
    expect(await readEntry(f.storage)).toMatchObject({ sessionId: "personal-pin-root" });
    expect((await readEntry(f.storage))?.archivedAt).toBeUndefined();
  },
);
