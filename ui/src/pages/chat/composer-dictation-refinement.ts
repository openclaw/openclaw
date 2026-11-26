import { focusComposerInput, type ComposerDraftTransaction } from "../../lib/composer-input.ts";
import type {
  refineDictation,
  DictationProtectedSpan,
  DictationPunctuationPolicy,
  DictationRefinementRequest,
  DictationRefinementResult,
} from "../../lib/dictation-refinement.ts";

type RefinementTarget = {
  target: object;
  revision: number;
  value: string;
  start: number;
  end: number;
};
type RefinementLimitation = "draft-changed" | "source-revoked" | "transcript-incomplete";
type RefinementPlan = {
  captureId: string;
  generation: number;
  target: RefinementTarget | undefined;
  policy: Readonly<DictationPunctuationPolicy>;
  context?: { left: string; right: string };
  protectedSpans?: readonly DictationProtectedSpan[];
  // A supplied context/vocabulary owner can revoke its snapshot, including raw
  // recognition influenced by that snapshot. No permission is inferred from text.
  provenance?: { revision: string; isEligible: () => boolean };
  recognized?: { text: string; isFinal: boolean; transcriptRevision: number };
  retired?: "draft-changed" | "source-revoked";
};
type DictationReview = {
  plan: RefinementPlan;
  rawText: string;
  isFinal: boolean;
  result: DictationRefinementResult;
  revision: number;
  selected: "refined" | "original";
  delivery: "not-attempted" | "pending" | "committed" | "not-committed" | "outcome-unknown";
  undo?: { transaction: ComposerDraftTransaction; target: RefinementTarget; retired: boolean };
  undoOutcome: "not-attempted" | "pending" | "undone" | "not-undone" | "outcome-unknown";
};

export type ComposerDictationRefinementOptions = {
  refinement?: {
    policy: Readonly<DictationPunctuationPolicy>;
    protectedSpans?: readonly DictationProtectedSpan[];
    context?: { left: string; right: string };
    provenance?: RefinementPlan["provenance"];
  };
  // Kept separate from the preference: disabling it affects the next capture,
  // while this reader still fences an already prepared, unsent result.
  readRefinementTarget?: () => RefinementTarget | undefined;
  onCommit: (
    text: string,
    late?: true,
    preservePreview?: true,
    reviewed?: { isCurrent: () => boolean },
  ) => boolean | void | ComposerDraftTransaction;
};

type RecognizedTranscript = { text: string; isFinal: boolean; transcriptRevision: number };

/** Private preparation state held by the capture owner, with no capture, provider or queue. */
export class ComposerDictationRefinement {
  private refinementGeneration = 0;
  private refinementPlan: RefinementPlan | undefined;
  private refine: typeof refineDictation | undefined;
  private prepared: DictationReview | null = null;

  constructor(
    private readonly host: {
      options: () => ComposerDictationRefinementOptions & {
        enabled: boolean;
        realtimeTalkActive: boolean;
      };
      idle: () => boolean;
      disposed: () => boolean;
      changed: () => void;
    },
  ) {}

  private get options() {
    return this.host.options();
  }
  private get disposed() {
    return this.host.disposed();
  }
  get currentPlan() {
    return this.refinementPlan;
  }
  get hasReview() {
    return Boolean(this.prepared);
  }
  get hasState() {
    return Boolean(this.refinementPlan || this.prepared);
  }

  load(refine: typeof refineDictation): void {
    this.refine = refine;
  }

  beginCapture(): boolean {
    this.prepared = null;
    this.refinementPlan = this.captureRefinementPlan();
    return !this.refinementPlan || Boolean(this.refinementPlan.target);
  }

  cancel(): boolean {
    const hadState = this.hasState;
    this.refinementGeneration += 1;
    this.refinementPlan = undefined;
    if (this.prepared?.delivery === "not-attempted") {
      this.prepared = null;
    }
    return hadState;
  }

  retireCapture(plan: RefinementPlan): void {
    if (this.refinementPlan === plan) {
      this.refinementGeneration += 1;
      this.refinementPlan = undefined;
    }
  }

  remember(plan: RefinementPlan, recognized: RecognizedTranscript): void {
    plan.recognized = recognized;
  }

  /** Sample target/source changes synchronously, not only when a view reads review. */
  update(recognized?: RecognizedTranscript): RefinementPlan | undefined {
    const plan = this.refinementPlan;
    const previousRetirement = plan?.retired;
    const retired =
      plan &&
      this.refinementLimitation(
        plan,
        true,
        !this.prepared || this.prepared.delivery === "not-attempted",
      );
    if (plan && retired) {
      this.retainRecognizedReview(plan, recognized);
    }
    if (plan && plan.retired !== previousRetirement) {
      this.host.changed();
    }
    const review = this.prepared;
    if (review?.undo && !review.undo.retired && !this.canUndoReview(review)) {
      this.host.changed();
    }
    return retired ? plan : undefined;
  }

  finalize(
    plan: RefinementPlan,
    text: string,
    state: { isFinal: boolean; transcriptRevision: number },
  ): void {
    if (this.refinementPlan !== plan) {
      return;
    }
    if (!this.refinementLimitation(plan, true)) {
      this.prepared = this.prepareReview(plan, text, state.isFinal, state.transcriptRevision);
    } else {
      this.retainRecognizedReview(plan);
    }
    this.host.changed();
  }

  get review() {
    const review = this.prepared;
    if (!review) {
      return null;
    }
    const limitation = this.refinementLimitation(
      review.plan,
      review.isFinal,
      review.delivery === "not-attempted",
    );
    const revoked = limitation === "source-revoked";
    return {
      rawText: revoked ? "" : review.rawText,
      result: revoked
        ? { ...review.result, status: "unavailable" as const, text: "", edits: [] }
        : review.result,
      policy: review.plan.policy,
      revision: review.revision,
      selected: review.selected,
      canInsert: this.canInsertReview(review, limitation),
      delivery: review.delivery,
      canUndo: this.canUndoReview(review),
      undoOutcome: review.undoOutcome,
      ...(limitation ? { limitation } : {}),
    };
  }

  reprocess(policy: DictationPunctuationPolicy): boolean {
    return this.replaceReview(policy, "refined");
  }

  chooseOriginal(): boolean {
    const review = this.prepared;
    return Boolean(
      review && this.replaceReview({ ...review.plan.policy, mode: "verbatim" }, "original"),
    );
  }

  private replaceReview(
    policy: DictationPunctuationPolicy,
    selected: "refined" | "original",
  ): boolean {
    const review = this.prepared;
    if (
      !review ||
      review.delivery !== "not-attempted" ||
      this.refinementLimitation(review.plan, review.isFinal)
    ) {
      return false;
    }
    const plan = {
      ...review.plan,
      generation: ++this.refinementGeneration,
      policy: Object.freeze({ ...policy }),
    };
    this.refinementPlan = plan;
    this.prepared = this.prepareReview(plan, review.rawText, review.isFinal, review.revision + 1);
    this.prepared.selected = selected;
    this.host.changed();
    return true;
  }

  insertReviewed(): boolean {
    const review = this.prepared;
    if (
      !review ||
      !this.canInsertReview(review, this.refinementLimitation(review.plan, review.isFinal))
    ) {
      return false;
    }
    review.delivery = "pending";
    this.host.changed();
    // A change listener may cancel or replace the draft before this indivisible
    // local write. Claim delivery once, then recheck authority at dispatch.
    const isCurrent = () =>
      !(
        this.prepared !== review ||
        this.refinementPlan !== review.plan ||
        this.refinementLimitation(review.plan, review.isFinal) ||
        this.disposed ||
        !this.options.enabled ||
        this.options.realtimeTalkActive
      );
    if (!isCurrent()) {
      review.delivery = "not-committed";
    } else {
      try {
        const receipt = this.options.onCommit(
          review.selected === "original" ? review.rawText : review.result.text,
          undefined,
          undefined,
          { isCurrent },
        );
        const committed = typeof receipt === "object" ? receipt.committed : receipt;
        review.delivery =
          committed === true
            ? "committed"
            : committed === false
              ? "not-committed"
              : "outcome-unknown";
        const target = this.readRefinementTarget();
        if (committed === true && typeof receipt === "object" && target) {
          review.undo = {
            transaction: receipt,
            target: { ...target, value: receipt.value },
            retired: false,
          };
        }
      } catch {
        // A callback may have written before throwing. Never offer an automatic
        // retry or describe cancellation as an undo of a completed write.
        review.delivery = "outcome-unknown";
      }
    }
    this.host.changed();
    return review.delivery === "committed";
  }

  undoReviewed(): boolean {
    const review = this.prepared;
    if (!review || !this.canUndoReview(review) || !review.undo) {
      return false;
    }
    const undo = review.undo;
    undo.retired = true;
    review.undoOutcome = "pending";
    this.host.changed();
    const isCurrent = () => this.undoTargetMatches(review, undo);
    try {
      const undone = isCurrent() ? undo.transaction.undo(isCurrent) : false;
      review.undoOutcome =
        undone === true ? "undone" : undone === false ? "not-undone" : "outcome-unknown";
    } catch {
      review.undoOutcome = "outcome-unknown";
    }
    if (review.undoOutcome === "undone") {
      const current = this.readRefinementTarget();
      if (current?.target === undo.target.target) {
        undo.target = {
          ...current,
          value:
            current.target instanceof HTMLTextAreaElement ? current.target.value : current.value,
        };
      }
    }
    this.host.changed();
    return review.undoOutcome === "undone";
  }

  dismissReview(): void {
    const review = this.prepared;
    const target = review?.plan.target?.target;
    const focusSnapshot = this.readRefinementTarget();
    const focusValue = target instanceof HTMLTextAreaElement ? target.value : undefined;
    const mayFocus =
      review &&
      (review.undo
        ? this.undoTargetMatches(review, review.undo)
        : !this.refinementLimitation(review.plan, review.isFinal));
    const generation = ++this.refinementGeneration;
    this.refinementPlan = undefined;
    this.prepared = null;
    this.host.changed();
    const current = this.readRefinementTarget();
    if (
      mayFocus &&
      this.refinementGeneration === generation &&
      current?.target === target &&
      current?.revision === focusSnapshot?.revision &&
      target instanceof HTMLTextAreaElement &&
      target.value === focusValue &&
      target.isConnected
    ) {
      focusComposerInput(target, { preventScroll: true });
    }
  }

  private captureRefinementPlan(): RefinementPlan | undefined {
    const refinement = this.options.refinement;
    const generation = ++this.refinementGeneration;
    if (!refinement) {
      return undefined;
    }
    const target = this.readRefinementTarget();
    const context =
      refinement.context ??
      (target && target.value.length <= 8192
        ? { left: target.value.slice(0, target.start), right: target.value.slice(target.end) }
        : undefined);
    return {
      captureId: `dictation-${generation}`,
      generation,
      target: target ? { ...target } : undefined,
      policy: Object.freeze({ ...refinement.policy }),
      ...(context ? { context: { ...context } } : {}),
      ...(refinement.protectedSpans
        ? { protectedSpans: refinement.protectedSpans.map((span) => ({ ...span })) }
        : {}),
      ...(refinement.provenance ? { provenance: { ...refinement.provenance } } : {}),
    };
  }

  private readRefinementTarget(): RefinementTarget | undefined {
    try {
      return this.options.readRefinementTarget?.();
    } catch {
      return undefined;
    }
  }

  private refinementLimitation(
    plan: RefinementPlan,
    isFinal: boolean,
    verifyTarget = true,
  ): RefinementLimitation | undefined {
    if (plan.provenance) {
      try {
        if (!plan.provenance.isEligible()) {
          plan.retired = "source-revoked";
        }
      } catch {
        plan.retired = "source-revoked";
      }
    }
    if (!plan.retired && verifyTarget) {
      const current = this.readRefinementTarget();
      if (
        !current ||
        !plan.target ||
        current.target !== plan.target.target ||
        current.revision !== plan.target.revision ||
        current.value !== plan.target.value
      ) {
        plan.retired = "draft-changed";
      }
    }
    return plan.retired ?? (!isFinal ? "transcript-incomplete" : undefined);
  }

  private canInsertReview(review: DictationReview, limitation?: RefinementLimitation): boolean {
    return (
      !limitation &&
      review.delivery === "not-attempted" &&
      this.refinementPlan === review.plan &&
      review.plan.generation === this.refinementGeneration &&
      this.host.idle() &&
      !this.disposed &&
      this.options.enabled &&
      !this.options.realtimeTalkActive &&
      Boolean(review.rawText) &&
      (review.selected === "original" || review.result.status !== "unavailable")
    );
  }

  private undoTargetMatches(
    review: DictationReview,
    undo: NonNullable<DictationReview["undo"]>,
  ): boolean {
    const current = this.readRefinementTarget();
    return Boolean(
      this.prepared === review &&
      this.refinementPlan === review.plan &&
      review.plan.generation === this.refinementGeneration &&
      this.host.idle() &&
      !this.disposed &&
      this.options.enabled &&
      !this.options.realtimeTalkActive &&
      !this.refinementLimitation(review.plan, true, false) &&
      current &&
      current.target === undo.target.target &&
      current.revision === undo.target.revision &&
      (current.target instanceof HTMLTextAreaElement ? current.target.value : current.value) ===
        undo.target.value,
    );
  }

  private canUndoReview(review: DictationReview): boolean {
    const undo = review.undo;
    if (!undo || undo.retired || review.delivery !== "committed") {
      return false;
    }
    if (!this.undoTargetMatches(review, undo) || !undo.transaction.canUndo()) {
      undo.retired = true;
      return false;
    }
    return true;
  }

  private prepareReview(
    plan: RefinementPlan,
    rawText: string,
    isFinal: boolean,
    revision: number,
  ): DictationReview {
    const request: DictationRefinementRequest = {
      schemaVersion: 1,
      captureId: plan.captureId,
      generation: plan.generation,
      transcriptRevision: revision,
      rawTranscript: rawText,
      isFinal,
      policy: plan.policy,
      ...(plan.context ? { context: plan.context } : {}),
      ...(plan.protectedSpans ? { protectedSpans: plan.protectedSpans } : {}),
    };
    let result: DictationRefinementResult;
    try {
      if (!this.refine) {
        throw new Error("Dictation refinement was not loaded");
      }
      result = this.refine(request);
    } catch {
      result = {
        schemaVersion: 1,
        captureId: plan.captureId,
        generation: plan.generation,
        transcriptRevision: revision,
        text: rawText,
        status: isFinal ? "raw-fallback" : "unavailable",
        edits: [],
        reasons: ["invalid-candidate"],
        effectiveLocale: null,
        policyVersion: 1,
      };
    }
    return {
      plan,
      rawText,
      isFinal,
      result,
      revision,
      selected: "refined",
      delivery: "not-attempted",
      undoOutcome: "not-attempted",
    };
  }

  private retainRecognizedReview(plan: RefinementPlan, snapshot?: RecognizedTranscript): void {
    if (this.prepared || plan.retired !== "draft-changed") {
      return;
    }
    const recognized = snapshot ?? plan.recognized;
    if (!recognized?.text) {
      return;
    }
    // Keep only the text already recognized before retirement. Late finals do
    // not replace this recovery, and a revoked source offers no raw fallback.
    const result: DictationRefinementResult = {
      schemaVersion: 1,
      captureId: plan.captureId,
      generation: plan.generation,
      transcriptRevision: recognized.transcriptRevision,
      text: recognized.text,
      status: recognized.isFinal ? "raw-fallback" : "unavailable",
      edits: [],
      reasons: [recognized.isFinal ? "unchanged" : "incomplete-transcript"],
      effectiveLocale: null,
      policyVersion: 1,
    };
    this.prepared = {
      plan,
      rawText: recognized.text,
      isFinal: recognized.isFinal,
      result,
      revision: recognized.transcriptRevision,
      selected: "original",
      delivery: "not-attempted",
      undoOutcome: "not-attempted",
    };
  }
}
