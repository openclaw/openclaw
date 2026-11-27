import { afterEach, describe, expect, vi } from "vitest";
import * as mutationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { stateTest } from "../plugin-state/plugin-state-fixtures.test-support.js";
import {
  createPluginStateKeyedStoreV2,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { MAX_PLUGIN_STATE_VALUE_BYTES } from "../plugin-state/plugin-state-store.kernel.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VocabularyCollections } from "./vocabulary-collections.js";
import {
  VOCABULARY_LIMITS,
  type VocabularyAuthority,
  type VocabularyCollection,
  type VocabularyGrant,
} from "./vocabulary-types.js";

const it = stateTest("vocabulary-collections.integration");
const draft = (canonical = "SyntheticQuokka") => ({
  schemaVersion: 1,
  label: "Synthetic team",
  terms: [{ id: "term-one", canonical, aliases: [], locales: [], enabled: true }],
});

/** Real V2 workers and retained rows; authority is synthetic, with no production ACL mapping. */
function fixture(state: OpenClawTestState) {
  const revokedActors = new Set<string>();
  let afterObserve: (() => Promise<void>) | undefined;
  const grant = (actorId: string): VocabularyGrant => {
    const assertCurrent = () => {
      if (revokedActors.has(actorId)) {
        throw new Error("Synthetic actor revoked");
      }
    };
    return {
      actorId,
      expiresAt: Date.now() + 60_000,
      assertCurrent,
      revalidate: async () => assertCurrent(),
      onInvalidated: () => () => {},
    };
  };
  const openStore = (authority: VocabularyGrant) =>
    createPluginStateKeyedStoreV2<VocabularyCollection>(
      "synthetic-vocabulary-integration",
      { namespace: "collections", retention: "retained", env: state.env },
      { assertCurrent: authority.assertCurrent },
    );
  const editor = (actorId: string, id?: () => string) => {
    const authority: VocabularyAuthority = {
      authorize: async () => grant(actorId),
    };
    return new VocabularyCollections({
      authority,
      id,
      openStore: (authorized) => {
        const store = openStore(authorized);
        return {
          observe: async (key) => {
            const observed = await store.observe(key);
            await afterObserve?.();
            return observed;
          },
          compareAndApply: store.compareAndApply,
          entriesInKeyRange: store.entriesInKeyRange,
        };
      },
    });
  };
  return {
    editor,
    inspect: () => openStore(grant("synthetic-auditor")),
    revoke: (actorId: string) => revokedActors.add(actorId),
    holdObservations: (hold?: () => Promise<void>) => {
      afterObserve = hold;
    },
  };
}

async function closeWorkers() {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

describe("vocabulary collections over the real worker store", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeWorkers();
  });

  it("settles two editors from the same observed revision without overwriting the winner", async ({
    state,
  }) => {
    const f = fixture(state);
    const alice = f.editor("alice");
    const bob = f.editor("bob");
    const ref = await alice.create("scope-a", draft());
    const bothObserved = createDeferredCore();
    let observations = 0;
    f.holdObservations(async () => {
      if (++observations === 2) {
        bothObserved.resolve();
      }
      // Both actual worker observations precede either conditional mutation.
      await bothObserved.promise;
    });
    const outcomes = await Promise.allSettled([
      alice.replace(ref, 1, draft("SyntheticAlice")),
      bob.replace(ref, 1, draft("SyntheticBob")),
    ]);
    f.holdObservations();
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "revision-conflict" }) }),
    ]);
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
    if (winner?.status !== "fulfilled") {
      throw new Error("Expected one successful editor");
    }
    await closeWorkers();
    const reopened = f.editor("bob");
    const current = await reopened.read(ref);
    expect(current).toEqual(winner.value);
    expect(current.revision).toBe(2);
    expect(["SyntheticAlice", "SyntheticBob"]).toContain(current.terms[0]?.canonical);
    expect((await reopened.audit(ref)).map(({ operation }) => operation)).toEqual([
      "create",
      "replace",
    ]);
    await expect(reopened.replace(ref, 1, draft("StaleOverwrite"))).rejects.toMatchObject({
      code: "revision-conflict",
    });
    expect(await reopened.read(ref)).toEqual(current);
  });

  it("preserves atomic import and tombstones across worker restart without touching another scope", async ({
    state,
  }) => {
    const f = fixture(state);
    const editor = f.editor("alice");
    const original = await editor.create("scope-a", draft());
    const sibling = await editor.create("scope-b", draft("SyntheticSibling"));
    const exported = await editor.export(original);
    await expect(
      editor.import(original, 1, '{"schemaVersion":1,"terms":[{}]}'),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect(await editor.export(original)).toBe(exported);
    await editor.delete(original, 1);
    await closeWorkers();
    const reopened = f.editor("bob");
    await expect(reopened.import(original, 1, exported)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(reopened.replace(original, 2, draft())).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((await reopened.list("scope-a")).collections).toEqual([]);
    expect(await reopened.read(sibling)).toEqual(sibling);
    const stored = await f.inspect().observe(`scope-a:${original.collectionId}`);
    expect(stored.value).toMatchObject({ deleted: true, revision: 2 });
    expect(stored.value).not.toHaveProperty("terms");
    expect(stored.value).not.toHaveProperty("label");
    expect((await reopened.audit(original)).map(({ operation }) => operation)).toEqual([
      "create",
      "delete",
    ]);
  });

  it("binds collection grants to final worker commit admission and never replays a denied write", async ({
    state,
  }) => {
    const f = fixture(state);
    const alice = f.editor("alice");
    const original = await alice.create("scope-a", draft());
    const stages: string[] = [];
    const admission = sqliteWorkerOwnerProbe.admission(
      mutationAdmission,
      (request, grant, admit) => {
        stages.push(request.stage);
        if (request.stage === "commit") {
          f.revoke("alice");
        }
        admit(request, grant);
      },
    );
    await expect(alice.replace(original, 1, draft("DeniedSynthetic"))).rejects.toMatchObject({
      code: "outcome-unknown",
      outcome: "unknown",
      message: "Vocabulary outcome-unknown",
    });
    admission.mockRestore();
    expect(stages).toEqual(["transaction", "commit"]);
    await closeWorkers();
    const bob = f.editor("bob");
    expect(await bob.read(original)).toEqual(original);
    expect((await bob.audit(original)).map(({ operation }) => operation)).toEqual(["create"]);
  });

  it("persists exact 400-KiB 5000-term drafts including maximum identifiers and the full audit ring", async ({
    state,
  }) => {
    const input = {
      schemaVersion: 1,
      label: "L".repeat(VOCABULARY_LIMITS.labelBytes),
      terms: Array.from({ length: VOCABULARY_LIMITS.collectionTerms }, (_, index) => ({
        id: `t${index.toString(36)}`,
        canonical: `Term${index.toString(36)}`,
        aliases: [],
        locales: [],
        enabled: true,
      })),
    };
    let remaining = VOCABULARY_LIMITS.collectionBytes - Buffer.byteLength(JSON.stringify(input));
    expect(remaining).toBeGreaterThan(0);
    for (const term of input.terms) {
      const added = Math.min(
        remaining,
        VOCABULARY_LIMITS.termBytes - Buffer.byteLength(term.canonical),
      );
      if (added > 0) {
        term.canonical += `~${"x".repeat(added - 1)}`;
        remaining -= added;
      }
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(input))).toBe(409_600);
    const f = fixture(state);
    const editor = f.editor("a".repeat(128), () => "c".repeat(128));
    const ref = await editor.create("s".repeat(128), input);
    // Fill the bounded history with small drafts before writing the maximum payload again.
    for (let revision = 1; revision < VOCABULARY_LIMITS.auditEvents; revision++) {
      await editor.replace(ref, revision, draft());
    }
    await editor.replace(ref, VOCABULARY_LIMITS.auditEvents, input);
    await closeWorkers();
    const current = await f.editor("bob").read(ref);
    expect(current.revision).toBe(33);
    expect(current.terms).toEqual(input.terms);
    expect(current.label).toBe(input.label);
    const stored = (await f.inspect().observe(`${ref.scopeId}:${ref.collectionId}`)).value;
    expect(stored?.audit).toHaveLength(32);
    const storedBytes = Buffer.byteLength(JSON.stringify(stored));
    expect(storedBytes).toBeGreaterThan(VOCABULARY_LIMITS.collectionBytes);
    expect(storedBytes).toBeLessThanOrEqual(MAX_PLUGIN_STATE_VALUE_BYTES);
  });
});
