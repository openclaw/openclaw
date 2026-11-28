import { DictationRefinementCoordinator } from "../../../../src/shared/dictation-refinement/coordinator.js";
import {
  detectRefinementLiteralSpans,
  whitespaceRefinementProcessor,
} from "../../../../src/shared/dictation-refinement/plan.js";
import {
  REFINEMENT_LIMITS,
  RefinementError,
  type RefinementRequest,
  type RefinementResult,
} from "../../../../src/shared/dictation-refinement/types.js";
import { refinementByteLength } from "../../../../src/shared/dictation-refinement/validation.js";
import {
  replaceComposerDraft,
  type ComposerDraftTransaction,
} from "../../lib/composer-draft-transaction.ts";
import { focusComposerInput } from "../../lib/composer-input.ts";
import {
  createPunctuationProcessor,
  type DictationPunctuationPolicy,
  type PunctuationDetail,
} from "../../lib/dictation-refinement.ts";
import { adjustTextareaHeight } from "./components/chat-composer-dom.ts";
import {
  placeComposerDictation,
  type ComposerDictationFinalSnapshot,
  type ComposerDictationSession,
} from "./composer-dictation-session.ts";

export type ComposerRefinementTarget = {
  target: object;
  revision: number;
  value: string;
  start: number;
  end: number;
  /** A selection captured by the gesture must still belong to the draft at admission. */
  selectionCurrent?: boolean;
};

/** Only a capture that reached review can offer a synchronous editor transaction. */
export type ComposerReviewedCommit = (
  read: () => HTMLTextAreaElement | null,
  canWrite?: () => boolean,
) => ComposerDraftTransaction | null;

function reviewedInsertion(
  source: ComposerRefinementTarget,
  transcript: string,
  current: () => boolean,
): ComposerReviewedCommit {
  return (read, canWrite) => {
    const target = read();
    if (!target || source.target !== target) {
      return null;
    }
    // Plan without truncation. Reject the whole insertion if the field cannot fit it.
    const insertion = placeComposerDictation(transcript, source, source);
    const isCurrent = () =>
      current() &&
      canWrite?.() !== false &&
      read() === target &&
      target.isConnected &&
      !target.readOnly &&
      !target.disabled &&
      target.value === source.value &&
      (target.maxLength < 0 || insertion.value.length <= target.maxLength);
    if (!isCurrent()) {
      return null;
    }
    // The shared transaction checks again after focus, before editing this field.
    const receipt = replaceComposerDraft(target, insertion.value, isCurrent, {
      start: source.start,
      end: source.end,
      caret: insertion.caret,
    });
    if (receipt.committed) {
      adjustTextareaHeight(target);
    }
    return receipt;
  };
}

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

type Punctuation = { policy: DictationPunctuationPolicy; target: ComposerRefinementTarget };
type Capture = {
  id: string;
  generation: number;
  scope: ComposerRefinementScope;
  punctuation?: Punctuation;
  // Only while STT closes, to permit same-field manual recovery without accepting a late final.
  captionAtStop?: string;
  draftChanged?: true;
};
type Delivery = {
  status: "pending" | "committed" | "not-committed" | "outcome-unknown";
  undoOutcome: "not-attempted" | "pending" | "undone" | "not-undone" | "outcome-unknown";
  undo?: { transaction: ComposerDraftTransaction; target: ComposerRefinementTarget };
};
type PreviewPhase = "idle" | "recording" | "finishing" | RefinementResult["status"];

/** The capture owner lends this operation its draft; only an explicit accept writes it. */
export class ComposerDictationRefinement {
  phase: PreviewPhase = "idle";
  result: RefinementResult | undefined;
  incompleteCaption = "";
  captionLimitExceeded = false;
  private generation = 0;
  private detail: PunctuationDetail | undefined;
  private selected: "original" | "refined" = "refined";
  private delivery: Delivery | undefined;
  private capture: Capture | undefined;
  private abort: AbortController | undefined;
  private coordinator: DictationRefinementCoordinator | undefined;

  constructor(
    private readonly options: {
      readScope: () => ComposerRefinementScope;
      changed: () => void;
      readTarget?: () => ComposerRefinementTarget | undefined;
      commit: (
        text: string,
        reviewed?: ComposerReviewedCommit,
      ) => boolean | void | ComposerDraftTransaction;
    },
  ) {}

  get punctuation(): boolean {
    return Boolean(this.capture?.punctuation || this.delivery);
  }

  get busy(): boolean {
    return this.phase === "finishing";
  }

  get pending(): boolean {
    return this.delivery ? this.delivery.status === "pending" : this.capture !== undefined;
  }

  boundedCaption(text: string): string {
    return text.length <= REFINEMENT_LIMITS.transcriptBytes &&
      refinementByteLength(text) <= REFINEMENT_LIMITS.transcriptBytes
      ? text
      : "";
  }

  get review() {
    const capture = this.capture;
    const punctuation = capture?.punctuation;
    const result = this.result;
    if (
      result?.status === "cancelled" ||
      (!this.delivery &&
        (!punctuation || (!result && !this.incompleteCaption && this.phase !== "unavailable")))
    ) {
      return null;
    }
    const raw = result?.rawText ?? this.incompleteCaption;
    const canInsert = Boolean(capture && this.canAccept(capture));
    // A receipt may outlive cancellation, but never its private transcript or editor handle.
    const policy = punctuation?.policy ?? { mode: "verbatim" as const, explicitEnabled: false };
    const selected =
      capture?.draftChanged || this.incompleteCaption ? ("original" as const) : this.selected;
    return {
      policy,
      rawText: raw,
      selected,
      result: {
        text: selected === "original" ? raw : (result?.candidateText ?? result?.text ?? raw),
        // A successful local edit proposal does not override the coordinator's meaning review.
        status: result?.status ?? ("unavailable" as const),
        transcriptRevision: result?.transcriptRevision,
        effectiveLocale: this.detail?.effectiveLocale ?? null,
        edits: selected === "original" ? [] : (this.detail?.edits ?? []),
        reasons: this.captionLimitExceeded
          ? ["input-too-large" as const]
          : selected === "original" && result?.rawText
            ? ["verbatim" as const]
            : (this.detail?.reasons ?? []),
        warnings: result?.warnings ?? [],
      },
      limitation: capture?.draftChanged
        ? ("draft-changed" as const)
        : this.incompleteCaption
          ? ("transcript-incomplete" as const)
          : undefined,
      canInsert,
      delivery: this.delivery?.status ?? ("not-attempted" as const),
      canUndo: this.canUndo(),
      undoOutcome: this.delivery?.undoOutcome ?? ("not-attempted" as const),
    };
  }

  begin(scope = this.options.readScope(), punctuation?: Punctuation): void {
    this.release();
    this.capture = {
      id: globalThis.crypto.randomUUID(),
      generation: ++this.generation,
      scope: { ...scope },
      ...(punctuation
        ? {
            punctuation: {
              policy: Object.freeze({ ...punctuation.policy }),
              target: { ...punctuation.target },
            },
          }
        : {}),
    };
    this.result = undefined;
    this.incompleteCaption = "";
    this.captionLimitExceeded = false;
    this.delivery = undefined;
    this.detail = undefined;
    this.selected = "refined";
    this.phase = "recording";
    this.options.changed();
  }

  reconcile(observedCaption?: string): void {
    const capture = this.capture;
    if (!capture) {
      return;
    }
    const next = this.options.readScope();
    const target = capture.punctuation && this.options.readTarget?.();
    if (!this.sameDestination(capture, next, target)) {
      this.cancel(false);
      return;
    }
    if (this.delivery) {
      // Input fires inside our own write. Only a settled undo receipt uses the post-write revision.
      if (this.delivery.undo && !this.canUndo()) {
        this.delivery.undo = undefined;
        this.options.changed();
      }
      return;
    }
    if (capture.draftChanged || this.sameDraft(capture, next, target)) {
      return;
    }
    const caption =
      capture.punctuation &&
      this.boundedCaption(
        this.result?.rawText ||
          this.incompleteCaption ||
          observedCaption ||
          capture.captionAtStop ||
          "",
      );
    if (!caption) {
      this.cancel();
      return;
    }
    capture.draftChanged = true;
    capture.captionAtStop = undefined;
    this.stopOperation();
    this.detail = undefined;
    this.result = undefined;
    this.incompleteCaption = caption;
    this.phase = "unavailable";
    this.options.changed();
  }

  cancel(keepReceipt = true): void {
    const hadCapture = this.capture !== undefined;
    this.release();
    this.result = undefined;
    this.incompleteCaption = "";
    this.captionLimitExceeded = false;
    this.detail = undefined;
    this.selected = "original";
    if (!keepReceipt) {
      this.delivery = undefined;
    } else if (this.delivery) {
      this.delivery.undo = undefined;
    }
    this.phase = hadCapture || this.phase === "cancelled" ? "cancelled" : "idle";
    this.options.changed();
  }

  async finish(session: ComposerDictationSession): Promise<boolean> {
    const capture = this.capture;
    if (!capture || !this.current(capture)) {
      void session.cancel().catch(() => undefined);
      this.reconcile();
      return false;
    }
    if (capture.punctuation) {
      capture.captionAtStop = this.boundedCaption(session.transcriptSnapshot());
    }
    await this.run(capture, (signal) => session.finishSnapshot({ signal }));
    // Finishing a review is never a send or insertion receipt.
    return false;
  }

  private async run(
    capture: Capture,
    snapshot: (signal: AbortSignal) => Promise<ComposerDictationFinalSnapshot>,
  ): Promise<boolean> {
    const abort = new AbortController();
    this.abort = abort;
    this.phase = "finishing";
    this.options.changed();
    try {
      const transcript = await snapshot(abort.signal);
      if (abort.signal.aborted || !this.current(capture)) {
        this.reconcile();
        return false;
      }
      return await this.prepare(capture, transcript, abort);
    } catch {
      if (this.current(capture) && !abort.signal.aborted) {
        capture.captionAtStop = undefined;
        this.phase = "unavailable";
        this.options.changed();
      }
      return false;
    } finally {
      if (this.abort === abort) {
        this.abort = undefined;
        this.coordinator?.dispose();
        this.coordinator = undefined;
      }
    }
  }

  private async prepare(
    capture: Capture,
    transcript: ComposerDictationFinalSnapshot,
    abort: AbortController,
  ): Promise<boolean> {
    if (
      (transcript.text && !this.boundedCaption(transcript.text)) ||
      (transcript.incompleteText && !this.boundedCaption(transcript.incompleteText))
    ) {
      capture.captionAtStop = undefined;
      this.captionLimitExceeded = true;
      this.phase = "unavailable";
      this.options.changed();
      return false;
    }
    let protectedSpans: RefinementRequest["protectedSpans"] | undefined = [];
    if (transcript.isFinal) {
      try {
        protectedSpans = detectRefinementLiteralSpans(transcript.text);
      } catch (error) {
        if (!(error instanceof RefinementError) || error.code !== "payload-limit") {
          throw error;
        }
        // No processing is safe without the full set of protections. The
        // coordinator still offers the complete raw text for explicit review.
        protectedSpans = undefined;
      }
    }
    let detail: PunctuationDetail | undefined;
    let processor = whitespaceRefinementProcessor;
    let locale: RefinementRequest["locale"] = { tag: capture.scope.locale, source: "default" };
    if (capture.punctuation) {
      const { target, policy } = capture.punctuation;
      const units = target.start + target.value.length - target.end;
      let context: { left: string; right: string } | undefined;
      if (units <= REFINEMENT_LIMITS.contextBytes) {
        const left = target.value.slice(0, target.start);
        const right = target.value.slice(target.end);
        if (
          refinementByteLength(left) + refinementByteLength(right) <=
          REFINEMENT_LIMITS.contextBytes
        ) {
          context = { left, right };
        }
      }
      locale = { tag: "und", source: "default" };
      if (policy.locale) {
        try {
          const tag = Intl.getCanonicalLocales(policy.locale)[0];
          if (tag) locale = { tag, source: "user" };
        } catch {
          // An invalid selection never enables an English punctuation pack.
        }
      }
      processor = createPunctuationProcessor(policy, context, (value) => {
        detail = value;
      });
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
      locale,
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
      protectedSpans: protectedSpans ?? [],
      authorizedEdits: [],
      featurePolicy: { enabled: protectedSpans !== undefined, processorIds: [processor.id] },
      // Local text processing says nothing about the separately selected STT route.
      providerPolicy: { routeId: null, locality: "strict-local" },
      deadlineAt: transcript.finalizedAt + REFINEMENT_LIMITS.deadlineMs,
    };
    this.coordinator = new DictationRefinementCoordinator({
      processors: [processor],
      isCurrent: () => this.current(capture),
      authorize: () => this.current(capture),
    });
    const result = await this.coordinator.refine(request, abort.signal);
    if (abort.signal.aborted || !this.current(capture)) {
      this.reconcile();
      return false;
    }
    capture.captionAtStop = undefined;
    this.result = result;
    // A declined, expired or stale edit must not advertise an accepted change map.
    this.detail =
      result.status === "refined" || result.status === "needs-review" ? detail : undefined;
    this.incompleteCaption = transcript.isFinal ? "" : transcript.incompleteText;
    this.phase = result.status;
    if (capture.punctuation && !transcript.isFinal && !transcript.incompleteText) {
      this.release();
      this.result = undefined;
    }
    this.options.changed();
    return this.capture === capture && this.canAccept(capture);
  }

  async reprocess(policy: DictationPunctuationPolicy): Promise<boolean> {
    const previous = this.capture;
    const raw = this.result?.rawText;
    if (!previous?.punctuation || !raw || !this.result || !this.canAccept(previous)) {
      return false;
    }
    const revision = this.result.transcriptRevision;
    const capture: Capture = {
      ...previous,
      generation: ++this.generation,
      punctuation: { target: previous.punctuation.target, policy: Object.freeze({ ...policy }) },
      captionAtStop: raw,
    };
    this.stopOperation();
    this.capture = capture;
    this.result = undefined;
    this.detail = undefined;
    this.selected = "refined";
    // A new explicit operation and deadline, not another recognizer revision or STT final.
    const transcript: ComposerDictationFinalSnapshot = {
      text: raw,
      revision,
      finalizedAt: Date.now(),
      isFinal: true,
      incompleteText: "",
      reason: "complete",
    };
    return this.run(capture, () => Promise.resolve(transcript));
  }

  chooseOriginal(): boolean {
    const capture = this.capture;
    if (!capture?.punctuation || this.selected === "original" || !this.canAccept(capture)) {
      return false;
    }
    this.selected = "original";
    this.options.changed();
    return true;
  }

  accept(source: "candidate" | "raw"): boolean {
    const capture = this.capture;
    if (!capture || !this.canAccept(capture) || !this.result) {
      this.reconcile();
      return false;
    }
    const text =
      source === "raw" || this.selected === "original"
        ? this.result.rawText
        : (this.result.candidateText ?? this.result.text);
    if (!text) {
      return false;
    }
    const punctuation = capture.punctuation;
    if (!punctuation) {
      // The original M11 integration has no transaction contract. Retire before its draft write.
      this.release();
      this.result = undefined;
      this.incompleteCaption = "";
      this.captionLimitExceeded = false;
      this.phase = "idle";
      this.options.commit(text);
      this.options.changed();
      return true;
    }
    const delivery: Delivery = { status: "pending", undoOutcome: "not-attempted" };
    this.delivery = delivery;
    this.options.changed();
    const isCurrent = () => this.delivery === delivery && this.current(capture);
    try {
      const receipt = isCurrent()
        ? this.options.commit(text, reviewedInsertion(punctuation.target, text, isCurrent))
        : false;
      const committed = typeof receipt === "object" ? receipt.committed : receipt;
      delivery.status =
        committed === true
          ? "committed"
          : committed === false
            ? "not-committed"
            : "outcome-unknown";
      if (committed === true && typeof receipt === "object" && this.capture === capture) {
        const target = this.options.readTarget?.();
        if (target && this.sameDestination(capture, this.options.readScope(), target)) {
          delivery.undo = { transaction: receipt, target: { ...target, value: receipt.value } };
        }
      }
    } catch {
      // The callback can write, cancel and then throw. Never replay an unknown local outcome.
      delivery.status = "outcome-unknown";
    }
    this.options.changed();
    return delivery.status === "committed";
  }

  undoReviewed(): boolean {
    const delivery = this.delivery;
    const undo = delivery?.undo;
    const capture = this.capture;
    if (!delivery || !undo || !capture || !this.canUndo()) {
      return false;
    }
    const isCurrent = () =>
      this.capture === capture &&
      this.delivery === delivery &&
      this.matchesReceipt(capture, undo.target);
    delivery.undo = undefined; // Claim once, even if a change listener cancels or replaces the field.
    delivery.undoOutcome = "pending";
    this.options.changed();
    try {
      const undone = isCurrent() ? undo.transaction.undo(isCurrent) : false;
      delivery.undoOutcome =
        undone === true ? "undone" : undone === false ? "not-undone" : "outcome-unknown";
    } catch {
      delivery.undoOutcome = "outcome-unknown";
    }
    this.options.changed();
    return delivery.undoOutcome === "undone";
  }

  dismissReview(): void {
    const capture = this.capture;
    const target = this.options.readTarget?.();
    const mayFocus =
      capture?.punctuation &&
      target &&
      (this.delivery?.undo
        ? this.matchesReceipt(capture, this.delivery.undo.target)
        : this.current(capture));
    const generation = this.generation;
    this.release();
    this.result = undefined;
    this.detail = undefined;
    this.incompleteCaption = "";
    this.captionLimitExceeded = false;
    this.delivery = undefined;
    this.phase = "idle";
    this.options.changed();
    if (
      mayFocus &&
      !this.capture &&
      this.generation === generation &&
      target.target instanceof HTMLTextAreaElement &&
      target.target.isConnected &&
      this.matchesReceipt(capture, target)
    ) {
      focusComposerInput(target.target, { preventScroll: true });
    }
  }

  private matchesReceipt(capture: Capture, receipt: ComposerRefinementTarget): boolean {
    const target = this.options.readTarget?.();
    return Boolean(
      target &&
      this.sameDestination(capture, this.options.readScope(), target) &&
      target.target === receipt.target &&
      target.revision === receipt.revision &&
      (target.target instanceof HTMLTextAreaElement ? target.target.value : target.value) ===
        receipt.value,
    );
  }

  private canUndo(): boolean {
    const undo = this.delivery?.undo;
    return Boolean(
      undo &&
      this.capture &&
      this.matchesReceipt(this.capture, undo.target) &&
      undo.transaction.canUndo(),
    );
  }

  private canAccept(capture: Capture): boolean {
    return (
      !this.delivery &&
      this.phase !== "finishing" &&
      Boolean(this.result?.rawText) &&
      this.result?.status !== "cancelled" &&
      this.result?.status !== "unavailable" &&
      this.current(capture)
    );
  }

  private current(capture: Capture): boolean {
    if (this.capture !== capture || capture.draftChanged) {
      return false;
    }
    const next = this.options.readScope();
    const target = capture.punctuation && this.options.readTarget?.();
    return this.sameDestination(capture, next, target) && this.sameDraft(capture, next, target);
  }

  private sameDestination(
    capture: Capture,
    next: ComposerRefinementScope,
    target?: ComposerRefinementTarget,
  ): boolean {
    const before = capture.scope;
    return (
      next.permitted &&
      next.connection === before.connection &&
      next.connectionGeneration === before.connectionGeneration &&
      next.authority === before.authority &&
      next.accountId === before.accountId &&
      next.target === before.target &&
      next.locale === before.locale &&
      (!capture.punctuation || target?.target === capture.punctuation.target.target)
    );
  }

  private sameDraft(
    capture: Capture,
    next: ComposerRefinementScope,
    target?: ComposerRefinementTarget,
  ): boolean {
    const frozen = capture.punctuation?.target;
    return (
      next.draftRevision === capture.scope.draftRevision &&
      next.draftText === capture.scope.draftText &&
      (!frozen || (target?.revision === frozen.revision && target.value === frozen.value))
    );
  }

  private stopOperation(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.coordinator?.dispose();
    this.coordinator = undefined;
  }

  private release(): void {
    this.capture = undefined;
    this.stopOperation();
  }
}
