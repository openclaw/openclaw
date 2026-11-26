import { DictationRefinementCoordinator } from "../../../../src/shared/dictation-refinement/coordinator.js";
import {
  detectRefinementLiteralSpans,
  whitespaceRefinementProcessor,
} from "../../../../src/shared/dictation-refinement/plan.js";
import {
  REFINEMENT_LIMITS,
  type RefinementRequest,
  type RefinementResult,
} from "../../../../src/shared/dictation-refinement/types.js";
import { refinementByteLength } from "../../../../src/shared/dictation-refinement/validation.js";
import type { ComposerDictationSession } from "./composer-dictation-session.ts";

export type ComposerRefinementScope = {
  connection: object | null;
  connectionGeneration: number;
  authority: object | null;
  accountId: string;
  target: string;
  draftRevision: number;
  draftText: string | undefined;
  permitted: boolean;
  locale: string;
};

type Capture = { id: string; generation: number; scope: ComposerRefinementScope };
type PreviewPhase = "idle" | "recording" | "finishing" | RefinementResult["status"];

/** The capture owner lends this operation its draft; only an explicit accept writes it. */
export class ComposerDictationRefinement {
  phase: PreviewPhase = "idle";
  result: RefinementResult | undefined;
  incompleteCaption = "";
  captionLimitExceeded = false;
  private generation = 0;
  private capture: Capture | undefined;
  private abort: AbortController | undefined;
  private coordinator: DictationRefinementCoordinator | undefined;

  constructor(
    private readonly options: {
      readScope: () => ComposerRefinementScope;
      changed: () => void;
      commit: (text: string) => void;
    },
  ) {}

  get busy(): boolean {
    return this.phase === "finishing";
  }

  get pending(): boolean {
    return this.capture !== undefined;
  }

  boundedCaption(text: string): string {
    return text.length <= REFINEMENT_LIMITS.transcriptBytes &&
      refinementByteLength(text) <= REFINEMENT_LIMITS.transcriptBytes
      ? text
      : "";
  }

  begin(): void {
    this.release();
    this.capture = {
      id: globalThis.crypto.randomUUID(),
      generation: ++this.generation,
      scope: this.options.readScope(),
    };
    this.result = undefined;
    this.incompleteCaption = "";
    this.captionLimitExceeded = false;
    this.phase = "recording";
    this.options.changed();
  }

  reconcile(): void {
    if (this.capture && !this.current(this.capture)) {
      this.cancel();
    }
  }

  cancel(): void {
    const hadCapture = this.capture !== undefined;
    this.release();
    this.result = undefined;
    this.incompleteCaption = "";
    this.captionLimitExceeded = false;
    this.phase = hadCapture || this.phase === "cancelled" ? "cancelled" : "idle";
    this.options.changed();
  }

  async finish(session: ComposerDictationSession): Promise<boolean> {
    const capture = this.capture;
    if (!capture || !this.current(capture)) {
      void session.cancel().catch(() => undefined);
      this.cancel();
      return false;
    }
    const abort = new AbortController();
    this.abort = abort;
    const deadlineAt = Date.now() + REFINEMENT_LIMITS.deadlineMs;
    this.phase = "finishing";
    this.options.changed();
    try {
      const transcript = await session.finishSnapshot({
        signal: abort.signal,
        timeoutMs: REFINEMENT_LIMITS.deadlineMs,
      });
      if (abort.signal.aborted || !this.current(capture)) {
        this.reconcile();
        return false;
      }
      if (
        (transcript.text && !this.boundedCaption(transcript.text)) ||
        (transcript.incompleteText && !this.boundedCaption(transcript.incompleteText))
      ) {
        this.captionLimitExceeded = true;
        this.phase = "unavailable";
        this.options.changed();
        return false;
      }
      // This integration supplies no optional context/vocabulary hints to STT.
      // Their owners must supply provenance and revocation before enabling them here.
      const request: RefinementRequest = {
        schemaVersion: 1,
        offsetUnit: "utf16",
        captureId: capture.id,
        generation: capture.generation,
        transcriptRevision: transcript.revision,
        rawTranscript: transcript.text,
        isFinal: transcript.isFinal,
        mode: "dictation",
        locale: { tag: capture.scope.locale, source: "default" },
        target: {
          id: capture.scope.target,
          revision: capture.generation,
          draftRevision: capture.scope.draftRevision,
        },
        scope: {
          connectionId: capture.id,
          connectionGeneration: capture.scope.connectionGeneration,
          accountId: capture.scope.accountId,
          authorizationRevision: capture.scope.connectionGeneration,
          policyRevision: capture.generation,
        },
        transcriptProvenance: {
          authorizationRevision: capture.scope.connectionGeneration,
          hintSnapshotIds: [],
        },
        contextSnapshots: [],
        vocabularySnapshots: [],
        protectedSpans: detectRefinementLiteralSpans(transcript.text),
        authorizedEdits: [],
        featurePolicy: { enabled: true, processorIds: ["whitespace"] },
        // Local text processing says nothing about the separately selected STT route.
        providerPolicy: { routeId: null, locality: "strict-local" },
        deadlineAt,
      };
      this.coordinator = new DictationRefinementCoordinator({
        processors: [whitespaceRefinementProcessor],
        isCurrent: () => this.current(capture),
        authorize: () => this.current(capture),
      });
      const result = await this.coordinator.refine(request, abort.signal);
      if (abort.signal.aborted || !this.current(capture)) {
        this.reconcile();
        return false;
      }
      this.result = result;
      this.incompleteCaption = transcript.isFinal ? "" : transcript.incompleteText;
      this.phase = result.status;
      this.options.changed();
    } catch {
      if (this.current(capture) && !abort.signal.aborted) {
        this.phase = "unavailable";
        this.options.changed();
      }
    } finally {
      if (this.abort === abort) {
        this.abort = undefined;
        this.coordinator?.dispose();
        this.coordinator = undefined;
      }
    }
    // A preview is not a send or insertion receipt. Explicit review owns acceptance.
    return false;
  }

  accept(source: "candidate" | "raw"): boolean {
    const capture = this.capture;
    if (!capture || !this.current(capture)) {
      this.cancel();
      return false;
    }
    const result = this.result;
    if (!result || result.status === "cancelled" || result.status === "unavailable") {
      return false;
    }
    const text = source === "raw" ? result.rawText : (result.candidateText ?? result.text);
    if (!text) {
      return false;
    }
    // Retire before the draft owner increments its edit revision; double activation is inert.
    this.release();
    this.result = undefined;
    this.incompleteCaption = "";
    this.captionLimitExceeded = false;
    this.phase = "idle";
    this.options.commit(text);
    this.options.changed();
    return true;
  }

  private current(capture: Capture): boolean {
    if (this.capture !== capture) {
      return false;
    }
    const next = this.options.readScope();
    const before = capture.scope;
    return (
      next.permitted &&
      next.connection === before.connection &&
      next.connectionGeneration === before.connectionGeneration &&
      next.authority === before.authority &&
      next.accountId === before.accountId &&
      next.target === before.target &&
      next.draftRevision === before.draftRevision &&
      next.draftText === before.draftText &&
      next.locale === before.locale
    );
  }

  private release(): void {
    this.capture = undefined;
    this.abort?.abort();
    this.abort = undefined;
    this.coordinator?.dispose();
    this.coordinator = undefined;
  }
}
