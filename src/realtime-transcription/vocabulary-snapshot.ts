import { randomUUID } from "node:crypto";
import {
  resolveEffectiveVocabulary,
  selectVocabularyHints,
  validateVocabularyDraft,
  validateVocabularyTerms,
} from "./vocabulary-terms.js";
import {
  VocabularyError,
  VOCABULARY_LIMITS,
  type AuthorizedVocabularyCollection,
  type EffectiveVocabulary,
  type VocabularyAuthority,
  type VocabularyGrant,
  type VocabularyHintCapability,
  type VocabularyHints,
  type VocabularyTerm,
} from "./vocabulary-types.js";

export type VocabularyStage = "stt" | "refinement";
export type VocabularyLineage = Readonly<{
  snapshotId: string;
  stage: VocabularyStage;
  sharedDerived: boolean;
}>;

/** An admitted attempt, not a result owner. Talk/M11 still owns dispatch and publication. */
export type VocabularyEgress = Readonly<{
  providerId: string;
  hints: VocabularyHints;
  lineage: VocabularyLineage;
  claimDispatch(): void;
  assertCurrent(): void;
  assertCanPublish(): void;
  onInvalidated(listener: () => void): () => void;
}>;

export type VocabularySnapshotLease = Readonly<{
  id: string;
  expiresAt: number;
  inspect(): EffectiveVocabulary;
  prepareEgress(stage: VocabularyStage): Promise<VocabularyEgress>;
  assertCurrent(): void;
  /** The coordinator releases this once STT, refinement, and publication have settled. */
  release(): void;
}>;

/**
 * Shared access is unavailable without a host-owned scope authorizer. No Gateway
 * connection, profile, collection ID, or provider selection supplies that grant.
 * There is deliberately no production registration until that mapping is accepted.
 */
export async function createVocabularySnapshot(params: {
  authority?: VocabularyAuthority;
  collections: readonly AuthorizedVocabularyCollection[];
  personalTerms?: readonly VocabularyTerm[];
  personalRevision: number;
  sessionTerms?: readonly VocabularyTerm[];
  locale?: string;
  providerId: string;
  capability: VocabularyHintCapability;
  expiresAt: number;
  now?: () => number;
}): Promise<VocabularySnapshotLease> {
  const now = params.now ?? Date.now;
  const providerId = params.providerId;
  if (params.collections.length > VOCABULARY_LIMITS.selectedCollections) {
    throw new VocabularyError("limit-exceeded");
  }
  // Capture data and its corresponding host-owned grant before authorization can yield.
  // Readonly TypeScript inputs may still be mutable at runtime; neither an outer
  // selection replacement nor edits to its content may change this utterance.
  const collections = Object.freeze(
    params.collections.map((selected) => {
      const source = selected.collection;
      const grant = selected.grant;
      const { scopeId, collectionId, revision, updatedAt, deleted } = source;
      if (
        typeof scopeId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(scopeId) ||
        typeof collectionId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(collectionId) ||
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        !Number.isFinite(updatedAt) ||
        deleted !== false
      ) {
        throw new VocabularyError("invalid-input");
      }
      const draft = validateVocabularyDraft({
        schemaVersion: source.schemaVersion,
        label: source.label,
        terms: source.terms,
      });
      return Object.freeze({
        collection: Object.freeze({
          ...draft,
          scopeId,
          collectionId,
          revision,
          updatedAt,
          deleted: false,
          // Administrative actor history is not part of the effective vocabulary.
          audit: Object.freeze([]),
        }),
        // Retain the authoritative handle; never clone or reconstruct its authority.
        grant,
      });
    }),
  );
  const personalTerms = validateVocabularyTerms(
    params.personalTerms ?? [],
    VOCABULARY_LIMITS.personalTerms,
  );
  const sessionTerms = validateVocabularyTerms(params.sessionTerms ?? []);
  const personalRevision = params.personalRevision;
  const locale = params.locale;
  const capability = Object.freeze({ ...params.capability });
  const authority = params.authority;
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(providerId) ||
    !Number.isSafeInteger(params.expiresAt) ||
    params.expiresAt <= now()
  ) {
    throw new VocabularyError("invalid-input");
  }
  if (collections.length && !authority) {
    throw new VocabularyError("unavailable");
  }
  const snapshotId = randomUUID();
  const grants: VocabularyGrant[] = [];
  const unsubscribe: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const dispatched = new Set<VocabularyStage>();
  const preparing = new Set<VocabularyStage>();
  const lineage = new Set<VocabularyLineage>();
  let expiredAt = params.expiresAt;
  let state: "active" | "unavailable" | "expired" | "cancelled" = "active";
  let effective: EffectiveVocabulary | undefined;
  let hints: VocabularyHints | undefined;
  let actorId: string | undefined;

  const invalidate = (reason: "unavailable" | "expired" | "cancelled") => {
    if (state !== "active") {
      return;
    }
    state = reason;
    effective = undefined;
    hints = undefined;
    lineage.clear();
    grants.length = 0;
    for (const remove of unsubscribe.splice(0)) {
      try {
        remove();
      } catch {
        // A broken observer cleanup cannot preserve authority or private payloads.
      }
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Finish retiring the remaining consumers even when one close fails.
      }
    }
    listeners.clear();
  };

  const assertCurrent = () => {
    if (state === "active" && now() >= expiredAt) {
      invalidate("expired");
    }
    if (state !== "active") {
      throw new VocabularyError(state);
    }
    try {
      for (const grant of grants) {
        grant.assertCurrent();
      }
    } catch {
      invalidate("unavailable");
      throw new VocabularyError("unavailable");
    }
  };

  const retainGrant = (grant: VocabularyGrant) => {
    if (
      !Number.isSafeInteger(grant.expiresAt) ||
      grant.expiresAt <= now() ||
      !grant.actorId ||
      (actorId !== undefined && actorId !== grant.actorId)
    ) {
      throw new VocabularyError("unavailable");
    }
    actorId = grant.actorId;
    expiredAt = Math.min(expiredAt, grant.expiresAt);
    grants.push(grant);
    const remove = grant.onInvalidated(() => invalidate("unavailable"));
    if (state === "active") {
      unsubscribe.push(remove);
    } else {
      remove();
    }
    assertCurrent();
  };

  try {
    for (const selected of collections) {
      retainGrant(selected.grant);
    }
    if (authority) {
      for (const { collection } of collections) {
        assertCurrent();
        retainGrant(
          await authority.authorize({
            scopeId: collection.scopeId,
            collectionId: collection.collectionId,
            operation: "disclose",
            providerId,
          }),
        );
      }
    }
    for (const grant of grants) {
      await grant.revalidate();
      assertCurrent();
    }
    effective = resolveEffectiveVocabulary({
      personalTerms,
      personalRevision,
      sessionTerms,
      collections: collections.map(({ collection }) => collection),
      locale,
    });
    hints = selectVocabularyHints(effective, capability);
    assertCurrent();
  } catch (error) {
    invalidate("unavailable");
    throw error instanceof VocabularyError ? error : new VocabularyError("unavailable");
  }

  return Object.freeze({
    id: snapshotId,
    expiresAt: expiredAt,
    assertCurrent,
    inspect: () => {
      assertCurrent();
      if (!effective) {
        throw new VocabularyError("unavailable");
      }
      return effective;
    },
    prepareEgress: async (stage: VocabularyStage): Promise<VocabularyEgress> => {
      assertCurrent();
      if (
        (stage !== "stt" && stage !== "refinement") ||
        dispatched.has(stage) ||
        preparing.has(stage)
      ) {
        // A retry is new work: the coordinator must resolve current collections again.
        throw new VocabularyError("invalid-input");
      }
      preparing.add(stage);
      try {
        for (const grant of grants) {
          await grant.revalidate();
          assertCurrent();
        }
        assertCurrent();
        if (!hints || !effective) {
          throw new VocabularyError("unavailable");
        }
        const sentTerms = new Set(hints.terms);
        const source: VocabularyLineage = Object.freeze({
          snapshotId,
          stage,
          sharedDerived:
            effective.entries.some(
              (entry) =>
                sentTerms.has(entry.term.canonical) &&
                entry.sources.some((origin) => origin.kind === "shared"),
            ) ||
            // Refinement inherits STT provenance even when it adds no new hints.
            [...lineage].some((parent) => parent.sharedDerived),
        });
        lineage.add(source);
        dispatched.add(stage);
        let claimed = false;
        return Object.freeze({
          providerId,
          get hints() {
            assertCurrent();
            if (!hints) {
              throw new VocabularyError("unavailable");
            }
            return hints;
          },
          lineage: source,
          claimDispatch: () => {
            assertCurrent();
            if (claimed) {
              throw new VocabularyError("unavailable");
            }
            claimed = true;
          },
          assertCurrent,
          assertCanPublish: () => {
            assertCurrent();
            if (!lineage.has(source)) {
              throw new VocabularyError("unavailable");
            }
          },
          onInvalidated: (listener: () => void) => {
            assertCurrent();
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        });
      } catch (error) {
        invalidate("unavailable");
        throw error instanceof VocabularyError ? error : new VocabularyError("unavailable");
      } finally {
        preparing.delete(stage);
      }
    },
    release: () => invalidate("cancelled"),
  });
}

/** Describes an explicit user action. This function never retains or replays audio. */
export function vocabularyRecovery(hasPermittedRetainedAudio: boolean): Readonly<{
  action: "manual" | "explicit-retranscription";
  automaticReplay: false;
  remoteRecall: false;
}> {
  return Object.freeze({
    action: hasPermittedRetainedAudio ? "explicit-retranscription" : "manual",
    automaticReplay: false,
    remoteRecall: false,
  });
}
