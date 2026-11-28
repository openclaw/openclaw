import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createVocabularySnapshot, vocabularyRecovery } from "./vocabulary-snapshot.js";
import { validateVocabularyDraft } from "./vocabulary-terms.js";
import type {
  AuthorizedVocabularyCollection,
  VocabularyAuthority,
  VocabularyGrant,
  VocabularyHintCapability,
} from "./vocabulary-types.js";

// Synthetic external authorization and quota fixtures; not production membership or ASR proof.
function authorityFixture() {
  let current = true;
  let reachable = true;
  let version = 1;
  let checks = 0;
  const listeners = new Set<() => void>();
  const grant: VocabularyGrant = {
    actorId: "person-a",
    expiresAt: 10_000,
    assertCurrent: () => {
      if (!current || !reachable) {
        throw new Error("Private upstream detail");
      }
    },
    revalidate: async () => {
      checks += 1;
      grant.assertCurrent();
    },
    onInvalidated: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const authority: VocabularyAuthority = {
    authorize: async ({ scopeId, providerId }) => {
      if (scopeId !== "workspace-a" || providerId !== "fixture-stt") {
        throw new Error("Private upstream detail");
      }
      grant.assertCurrent();
      return grant;
    },
  };
  const selected = (): AuthorizedVocabularyCollection => ({
    grant,
    collection: {
      ...validateVocabularyDraft({
        schemaVersion: 1,
        label: "Synthetic collection",
        terms: [
          { id: "term-1", canonical: `Example${version}`, aliases: [], locales: [], enabled: true },
        ],
      }),
      scopeId: "workspace-a",
      collectionId: "collection-a",
      revision: version,
      updatedAt: 1,
      deleted: false,
      audit: [],
    },
  });
  return {
    authority,
    selected,
    edit: () => {
      version += 1;
    },
    offline: () => {
      reachable = false;
    },
    online: () => {
      reachable = true;
    },
    revoke: () => {
      current = false;
      for (const listener of listeners) {
        listener();
      }
    },
    checks: () => checks,
    observers: () => listeners.size,
  };
}

const capability: VocabularyHintCapability = {
  kind: "canonical-list",
  maxTerms: 64,
  maxBytes: 2_048,
  maxTokens: 2_048,
  measure: (terms) => ({
    bytes: Buffer.byteLength(JSON.stringify(terms)),
    tokens: JSON.stringify(terms).length,
  }),
};

function open(fixture: ReturnType<typeof authorityFixture>, options = {}) {
  return createVocabularySnapshot({
    authority: fixture.authority,
    collections: [fixture.selected()],
    personalRevision: 0,
    providerId: "fixture-stt",
    capability,
    now: () => 1,
    expiresAt: 9_000,
    ...options,
  });
}

describe("vocabulary snapshot authority and lineage", () => {
  it("captures collection identity, contents, and grant before deferred authorization", async () => {
    const fixture = authorityFixture();
    const replacement = authorityFixture();
    const initial = fixture.selected();
    const mutable = {
      ...initial.collection,
      terms: initial.collection.terms.map((term) => ({
        ...term,
        aliases: [...term.aliases],
        locales: [...term.locales],
      })),
    };
    const selected = { collection: mutable, grant: initial.grant };
    const pending = createDeferredCore();
    const entered = createDeferredCore();
    const authorize = vi.fn(async (request: Parameters<VocabularyAuthority["authorize"]>[0]) => {
      entered.resolve();
      await pending.promise;
      return fixture.authority.authorize(request);
    });
    const opening = open(fixture, { authority: { authorize }, collections: [selected] });
    await entered.promise;
    mutable.scopeId = "workspace-b";
    mutable.collectionId = "collection-b";
    mutable.revision = 9;
    mutable.label = "Changed collection";
    mutable.terms[0]!.canonical = "ChangedTermB";
    mutable.terms[0]!.aliases.push("changed alias");
    mutable.terms[0]!.locales.push("fr");
    selected.collection = {
      ...mutable,
      terms: [
        { id: "replacement", canonical: "ReplacementB", aliases: [], locales: [], enabled: true },
      ],
    };
    selected.grant = replacement.selected().grant;
    pending.resolve();
    const snapshot = await opening;
    expect(authorize).toHaveBeenCalledExactlyOnceWith({
      scopeId: "workspace-a",
      collectionId: "collection-a",
      operation: "disclose",
      providerId: "fixture-stt",
    });
    expect(snapshot.inspect().entries).toEqual([
      {
        term: { id: "term-1", canonical: "Example1", aliases: [], locales: [], enabled: true },
        sources: [
          { kind: "shared", scopeId: "workspace-a", collectionId: "collection-a", revision: 1 },
        ],
      },
    ]);
    expect((await snapshot.prepareEgress("stt")).hints.terms).toEqual(["Example1"]);
    expect(replacement.observers()).toBe(0);
    fixture.revoke();
    expect(() => snapshot.inspect()).toThrow("Vocabulary unavailable");
    expect(fixture.observers()).toBe(0);
  });

  it("validates selected identity and content before requesting disclosure", async () => {
    const fixture = authorityFixture();
    const initial = fixture.selected();
    const authorize = vi.fn(fixture.authority.authorize);
    await expect(
      open(fixture, {
        authority: { authorize },
        collections: [
          {
            ...initial,
            collection: { ...initial.collection, scopeId: "../workspace-b" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      open(fixture, {
        authority: { authorize },
        collections: [
          {
            ...initial,
            collection: {
              ...initial.collection,
              terms: [{ id: "invalid", canonical: "line\nbreak" }],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(authorize).not.toHaveBeenCalled();
    expect(fixture.observers()).toBe(0);
  });

  it("pins ordinary edits, reauthorizes each egress, and refuses replay of one attempt", async () => {
    const fixture = authorityFixture();
    const snapshot = await open(fixture);
    fixture.edit();
    const stt = await snapshot.prepareEgress("stt");
    expect(stt.hints.terms).toEqual(["Example1"]);
    expect(stt.lineage.sharedDerived).toBe(true);
    const refinement = await snapshot.prepareEgress("refinement");
    expect(refinement.lineage.sharedDerived).toBe(true);
    expect(fixture.checks()).toBe(6);
    await expect(snapshot.prepareEgress("stt")).rejects.toMatchObject({ code: "invalid-input" });
    const next = await open(fixture);
    expect((await next.prepareEgress("stt")).hints.terms).toEqual(["Example2"]);
    next.release();
    snapshot.release();
    expect(fixture.observers()).toBe(0);
  });

  it("revokes hinted STT and refinement without raw fallback, replay, or retained hints", async () => {
    const fixture = authorityFixture();
    const snapshot = await open(fixture);
    const stt = await snapshot.prepareEgress("stt");
    const refinement = await snapshot.prepareEgress("refinement");
    let cancelled = 0;
    stt.onInvalidated(() => {
      cancelled += 1;
    });
    fixture.revoke();
    expect(cancelled).toBe(1);
    expect(() => stt.assertCanPublish()).toThrow("Vocabulary unavailable");
    expect(() => refinement.assertCanPublish()).toThrow("Vocabulary unavailable");
    expect(() => stt.hints).toThrow("Vocabulary unavailable");
    expect(() => snapshot.inspect()).toThrow("Vocabulary unavailable");
    expect(vocabularyRecovery(false)).toEqual({
      action: "manual",
      automaticReplay: false,
      remoteRecall: false,
    });
    expect(vocabularyRecovery(true)).toEqual({
      action: "explicit-retranscription",
      automaticReplay: false,
      remoteRecall: false,
    });
    expect(fixture.observers()).toBe(0);
  });

  it("fails closed before egress and requires a new authorized snapshot after reconnect", async () => {
    const fixture = authorityFixture();
    const snapshot = await open(fixture);
    fixture.offline();
    await expect(snapshot.prepareEgress("stt")).rejects.toMatchObject({ code: "unavailable" });
    fixture.online();
    await expect(snapshot.prepareEgress("stt")).rejects.toMatchObject({ code: "unavailable" });
    const next = await open(fixture);
    expect((await next.prepareEgress("stt")).hints.status).toBe("supported");
    next.release();
  });

  it("does not infer scope or provider disclosure permission from a known collection", async () => {
    const fixture = authorityFixture();
    await expect(open(fixture, { authority: undefined })).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(open(fixture, { providerId: "another-provider" })).rejects.toThrow(
      "Vocabulary unavailable",
    );
    expect(fixture.observers()).toBe(0);
    const personal = await createVocabularySnapshot({
      collections: [],
      personalRevision: 1,
      personalTerms: [
        { id: "personal", canonical: "PersonalSpelling", aliases: [], locales: [], enabled: true },
      ],
      providerId: "fixture-stt",
      capability,
      expiresAt: 9_000,
      now: () => 1,
    });
    expect((await personal.prepareEgress("stt")).hints.terms).toEqual(["PersonalSpelling"]);
    personal.release();
  });

  it("checks expiration at publication and advertises unsupported hints honestly", async () => {
    const fixture = authorityFixture();
    let now = 1;
    const snapshot = await open(fixture, {
      now: () => now,
      expiresAt: 10,
      capability: { kind: "unsupported" },
    });
    const request = await snapshot.prepareEgress("stt");
    expect(request.hints).toMatchObject({ status: "unsupported", terms: [], omitted: 1 });
    expect(request.lineage.sharedDerived).toBe(false);
    now = 10;
    expect(() => request.assertCanPublish()).toThrow("Vocabulary expired");
    expect(fixture.observers()).toBe(0);
  });
});
