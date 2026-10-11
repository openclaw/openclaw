import { afterEach, describe, expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createSessionEntryWithTranscriptInScope } from "./session-accessor.sqlite-creation.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
const owned: Array<{ agentId: string; path: string }> = [];
afterEach(() => {
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
  return { actor, binding, scope, creationScope: { ...options, sessionKey, env } };
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
      expect(
        await current.storage!.read({ type: "session.history.hydrate", input: {} }, authority),
      ).toMatchObject({ kind: "full", snapshot: { events } });
    });
    await Promise.all([actor.release(), current.release()]);
  });

  it.each([
    ["target changed", "SqliteSessionMutationConflictError"],
    ["label claimed", "SessionLabelConflictError"],
  ])(
    "rejects prepared creation when %s without installing its transcript or owner",
    async (change, errorName) => {
      const { actor, binding, scope, creationScope } = await fixture(errorName);
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
          sessionId: errorName,
          label: change === "target changed" ? "Concurrent edit" : "Original",
        });
        expect(loadSessionEntryReadOnly(scope)?.owner).toBeUndefined();
        expect(
          await actor.storage!.read({ type: "session.history.hydrate", input: {} }, authority),
        ).toMatchObject({ kind: "full", snapshot: { events: [] } });
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
});
