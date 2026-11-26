/** Private, in-memory dictation boundary. This is not a persisted or public SDK schema. */
export const REFINEMENT_LIMITS = Object.freeze({
  transcriptBytes: 32 * 1024,
  contextBytes: 8 * 1024,
  vocabularyBytes: 8 * 1024,
  payloadBytes: 64 * 1024,
  outputBytes: 32 * 1024,
  instructionBytes: 4 * 1024,
  snapshots: 32,
  spans: 256,
  edits: 256,
  processors: 32,
  deadlineMs: 2_500,
});

export type RefinementMode = "dictation" | "literal" | "developer";

export type ProtectedSpan = Readonly<{
  /** Half-open UTF-16 code-unit offsets, also required to be grapheme boundaries. */
  start: number;
  end: number;
  kind: "literal" | "snippet" | "reference";
  /** Opaque identity supplied by the reference owner, never inferred from display text. */
  identity?: string;
}>;

export type RefinementEdit = Readonly<{ start: number; end: number; text: string }>;

export type AuthorizedRefinementEdit = RefinementEdit &
  Readonly<{
    intentId: string;
    kind: "correction" | "expansion" | "reference" | "literal";
    protection?: Readonly<{ kind: ProtectedSpan["kind"]; identity?: string }>;
  }>;

export type RefinementSnapshot = Readonly<{
  id: string;
  revision: number;
  source: string;
  authorizationId: string;
  expiresAt: number;
  text: string;
}>;

export type RefinementRequest = Readonly<{
  schemaVersion: 1;
  offsetUnit: "utf16";
  captureId: string;
  generation: number;
  transcriptRevision: number;
  rawTranscript: string;
  isFinal: boolean;
  mode: RefinementMode;
  locale: Readonly<{ tag: string; source: "user" | "recognizer" | "default" }>;
  target: Readonly<{ id: string; revision: number; draftRevision: number }>;
  scope: Readonly<{
    connectionId: string;
    connectionGeneration: number;
    accountId: string;
    authorizationRevision: number;
    policyRevision: number;
  }>;
  transcriptProvenance: Readonly<{
    authorizationRevision: number;
    hintSnapshotIds: readonly string[];
  }>;
  contextSnapshots: readonly RefinementSnapshot[];
  vocabularySnapshots: readonly RefinementSnapshot[];
  protectedSpans: readonly ProtectedSpan[];
  authorizedEdits: readonly AuthorizedRefinementEdit[];
  featurePolicy: Readonly<{ enabled: boolean; processorIds: readonly string[] }>;
  providerPolicy: Readonly<{ routeId: string | null; locality: "strict-local" | "selected" }>;
  /** Absolute owner clock time, normally capture Stop + deadlineMs. */
  deadlineAt: number;
}>;

type CandidateBase = Readonly<{
  schemaVersion: 1;
  offsetUnit: "utf16";
  baseRevision: number;
}>;

export type RefinementCandidate = CandidateBase &
  (
    | Readonly<{ kind: "text"; text: string }>
    | Readonly<{ kind: "edits"; edits: readonly RefinementEdit[] }>
  );

export type RefinementFailureCode =
  | "unsupported-schema"
  | "invalid-request"
  | "invalid-candidate"
  | "wrong-base"
  | "invalid-range"
  | "protected-content"
  | "payload-limit"
  | "disabled"
  | "incomplete-transcript"
  | "unsupported-locale"
  | "unsupported-mode"
  | "processor-unavailable"
  | "provider-unavailable"
  | "locality-denied"
  | "authorization-changed"
  | "superseded"
  | "duplicate-final"
  | "cancelled"
  | "deadline"
  | "provider-error"
  | "processor-error"
  | "meaning-review";

/** Fixed codes only: provider errors and private input are never copied into diagnostics. */
export class RefinementError extends Error {
  constructor(readonly code: RefinementFailureCode) {
    super(`Dictation refinement: ${code}`);
    this.name = "RefinementError";
  }
}

export type RefinementPhase = "plan" | "deterministic" | "provider" | "validation";
export type RefinementMetric = Readonly<{
  phase: RefinementPhase | "terminal";
  durationMs: number;
  sizeBucket: "empty" | "small" | "medium" | "large";
  status?: RefinementResult["status"];
  providerRequests: number;
}>;

export type RefinementResult = Readonly<{
  schemaVersion: 1;
  captureId: string;
  generation: number;
  transcriptRevision: number;
  status: "refined" | "raw-fallback" | "cancelled" | "unavailable" | "needs-review";
  /** Eligible preview text; absent after cancellation or authorization loss. */
  text?: string;
  /** Authorized finalized source for local change inspection; never a delivery receipt. */
  rawText?: string;
  /** Uncertain candidate, shown only in explicit local review, never automatically inserted. */
  candidateText?: string;
  protectedSpans?: readonly ProtectedSpan[];
  warnings: readonly RefinementFailureCode[];
  metrics: Readonly<{
    elapsedMs: number;
    inputBytes: number;
    outputBytes: number;
    providerRequests: number;
    phases: readonly Readonly<{ phase: RefinementPhase; durationMs: number }>[];
  }>;
}>;

export type RefinementModelInput = Readonly<{
  /** The transport must project allowed content; never serialize target/scope wholesale. */
  request: RefinementRequest;
  text: string;
  /** Revision of this exact text, advanced after each admitted transformation. */
  baseRevision: number;
  protectedSpans: readonly ProtectedSpan[];
  modelInstructions: readonly string[];
}>;

export type RefinementModelAdapter = Readonly<{
  id: string;
  /** An authoritative route capability, not a hostname-based guess. */
  locality: "local" | "remote";
  supportedLocales: readonly string[];
  refine: (input: RefinementModelInput, signal: AbortSignal) => Promise<unknown>;
}>;

export type RefinementProcessor = Readonly<{
  id: string;
  stage: "intent" | "deterministic" | "prose";
  order: number;
  modes: readonly RefinementMode[];
  supportedLocales: readonly string[];
  /** Trusted adapter policy, combined into the one selected model pass. */
  modelInstruction?: string;
  /** Bounded local transformation only: no I/O, tools, delivery, or permission decisions. */
  transform?: (input: RefinementModelInput, signal: AbortSignal) => unknown;
}>;

export type RefinementAuthorityPhase = "dispatch" | "publication" | "fallback";

export type RefinementCoordinatorOptions = Readonly<{
  processors?: readonly RefinementProcessor[];
  model?: RefinementModelAdapter;
  now?: () => number;
  isCurrent: (request: RefinementRequest) => boolean;
  /** Consult the existing authority owner, including STT hint provenance for fallback. */
  authorize: (request: RefinementRequest, phase: RefinementAuthorityPhase) => boolean;
  onMetric?: (metric: RefinementMetric) => void;
}>;
