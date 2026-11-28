/** Proposed internal P03/M06 vocabulary boundary; no wire API or membership database. */
export const VOCABULARY_LIMITS = Object.freeze({
  schemaVersion: 1,
  collectionTerms: 5_000,
  personalTerms: 1_000,
  collectionBytes: 400 * 1_024,
  selectedCollections: 8,
  aliases: 16,
  termBytes: 1_024,
  labelBytes: 256,
  auditEvents: 32,
});

export type VocabularyErrorCode =
  | "unavailable"
  | "invalid-input"
  | "unsupported-version"
  | "limit-exceeded"
  | "revision-conflict"
  | "outcome-unknown"
  | "expired"
  | "cancelled";

/** Messages intentionally contain neither supplied identifiers nor private vocabulary. */
export class VocabularyError extends Error {
  constructor(readonly code: VocabularyErrorCode) {
    super(`Vocabulary ${code}`);
    this.name = "VocabularyError";
  }
}

export type VocabularyTerm = Readonly<{
  id: string;
  canonical: string;
  aliases: readonly string[];
  locales: readonly string[];
  enabled: boolean;
}>;

export type VocabularyCollectionDraft = Readonly<{
  schemaVersion: 1;
  label: string;
  terms: readonly VocabularyTerm[];
}>;

export type VocabularyCollectionRef = Readonly<{ scopeId: string; collectionId: string }>;
export type VocabularyOperation = "read" | "edit" | "manage" | "export" | "disclose";
export type VocabularyAuditEvent = Readonly<{
  actorId: string;
  operation: "create" | "replace" | "import" | "delete";
  revision: number;
  at: number;
  termCount: number;
}>;

export type VocabularyCollection = VocabularyCollectionRef &
  Readonly<{
    schemaVersion: 1;
    revision: number;
    updatedAt: number;
    audit: readonly VocabularyAuditEvent[];
  }> &
  (
    | Readonly<{ deleted: false; label: string; terms: readonly VocabularyTerm[] }>
    | Readonly<{ deleted: true }>
  );

/** Host-owned live authority, never serialized or reconstructed from an ID or token. */
export type VocabularyGrant = Readonly<{
  actorId: string;
  expiresAt: number;
  assertCurrent(): void;
  revalidate(): Promise<void>;
  onInvalidated(listener: () => void): () => void;
}>;

/** The host must map these operations to its accepted scope policy before enabling sharing. */
export type VocabularyAuthority = Readonly<{
  authorize(request: {
    scopeId: string;
    collectionId?: string;
    operation: VocabularyOperation;
    providerId?: string;
  }): Promise<VocabularyGrant>;
}>;

export type AuthorizedVocabularyCollection = Readonly<{
  collection: VocabularyCollection & { deleted: false };
  grant: VocabularyGrant;
}>;

export type VocabularySource =
  | Readonly<{ kind: "session" }>
  | Readonly<{ kind: "personal"; revision: number }>
  | (VocabularyCollectionRef & Readonly<{ kind: "shared"; revision: number }>);

export type EffectiveVocabularyTerm = Readonly<{
  term: VocabularyTerm;
  sources: readonly VocabularySource[];
}>;

export type VocabularyConflict = Readonly<{
  alias: string;
  candidates: readonly Readonly<{ canonical: string; source: VocabularySource }>[];
}>;

export type EffectiveVocabulary = Readonly<{
  entries: readonly EffectiveVocabularyTerm[];
  conflicts: readonly VocabularyConflict[];
}>;

/** No real adapter is advertised by this proposal until endpoint and quota evidence exists. */
export type VocabularyHintCapability =
  | Readonly<{ kind: "unsupported" }>
  | Readonly<{
      kind: "canonical-list";
      maxTerms: number;
      maxBytes: number;
      maxTokens: number;
      /** The adapter owns its exact tokenizer and serialized field representation. */
      measure(terms: readonly string[]): { bytes: number; tokens: number };
    }>;

export type VocabularyHints = Readonly<{
  status: "supported" | "truncated" | "unsupported";
  terms: readonly string[];
  omitted: number;
  bytes: number;
  tokens: number;
}>;
