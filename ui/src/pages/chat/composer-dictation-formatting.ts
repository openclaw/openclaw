import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { replaceComposerInputWithHistory } from "../../lib/composer-input-history.ts";
import {
  type DictationFormattingMode,
  type DictationFormattingResult,
  type DictationRange,
  prepareDictationFormatting,
} from "../../lib/dictation/formatting.ts";
import { sameDictationFormattingTarget } from "./composer-dictation-target.ts";

export type { DictationFormattingMode } from "../../lib/dictation/formatting.ts";
export type PrepareFormatting = typeof prepareDictationFormatting;

/** Private adapter facts. Preparing HTML is not evidence that a target accepts it. */
export type DictationFormattingTarget = {
  identity: object;
  revision: number;
  value: string;
  start: number;
  end: number;
  editable: boolean;
  focused: boolean;
  capabilities: {
    version: 1;
    revision: number;
    formats: readonly ("text/plain" | "text/markdown" | "text/html")[];
    markdownProfile?: "commonmark-0.31.2-lists";
    richTextProfile?: "safe-blocks-v1";
    safeMultiline: boolean;
    maxLength?: number;
  };
};

export type DictationFormattingReceipt = "not-committed" | "committed" | "outcome-unknown";
export type ReviewedDictationPlacement = {
  target: DictationFormattingTarget;
  format: "text/plain" | "text/markdown" | "text/html";
  isCurrent?: () => boolean;
};

export type ReviewedDictationEdit = ReviewedDictationPlacement & {
  insertion: ReturnType<typeof placeReviewedDictation>;
  applyTo: (input: HTMLTextAreaElement) => boolean | undefined;
};

export type ComposerDictationFailure = {
  kind: "interrupted" | "start" | "busy";
  preservesText: boolean;
};

export type ComposerDictationOwnerOptions = {
  client: GatewayBrowserClient | null;
  sessionKey?: string;
  prepareSession?: () => Promise<string | undefined>;
  draftKey?: string;
  connected: boolean;
  enabled: boolean;
  dictationAvailable?: boolean;
  realtimeTalkActive: boolean;
  onCommit: (
    text: string,
    late?: true,
    preservePreview?: true,
    reviewed?: ReviewedDictationEdit,
  ) => boolean | void;
  readFormattingTarget?: () => DictationFormattingTarget | undefined;
  onFormattingDismiss?: () => void;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onTap?: () => void;
  onDictationUnavailable?: () => void;
};

export type DictationFormattingCapture = {
  target: DictationFormattingTarget | undefined;
  client: GatewayBrowserClient;
  auth: GatewayBrowserClient["auth"];
  connection: number;
  invalidated: boolean;
};

export type DictationFormattingAuthority = {
  client: GatewayBrowserClient;
  auth: GatewayBrowserClient["auth"] | undefined;
  connection: number | undefined;
};

export type DictationFormattingSource = {
  id: string;
  revision: number;
  finalized: boolean;
  timedOut: boolean;
};

export type DictationFormattingReview = DictationFormattingCapture & {
  version: 1;
  result: DictationFormattingResult;
  generation: number;
  mode: DictationFormattingMode;
  receipt: DictationFormattingReceipt;
  source: DictationFormattingSource;
  timing: { finalizationMs: number; localMs: number };
};

/** Bounded projection only; authority and all review mutations remain with the owner. */
export function diagnostics(review: DictationFormattingReview | undefined) {
  return review
    ? {
        version: review.version,
        generation: review.generation,
        transcriptRevision: review.source.revision,
        isFinal: review.source.finalized,
        mode: review.mode,
        providerPolicy: "local-deterministic" as const,
        status: review.result.status,
        receipt: review.receipt,
        counts: review.result.counts,
        ...review.timing,
      }
    : undefined;
}

/** Keep each live read behind the owner's current-authority check. */
export function reviewProjection(
  review: DictationFormattingReview | undefined,
  isCurrent: (review: DictationFormattingReview) => boolean,
  readTarget: () => DictationFormattingTarget | undefined,
) {
  if (!review) {
    return undefined;
  }
  return {
    result: review.result,
    receipt: review.receipt,
    // Bounded local diagnostics contain no transcript, target value, or credentials.
    get diagnostics() {
      return diagnostics(review);
    },
    canApply:
      isCurrent(review) &&
      selectDictationFormatting(review.result, review.target, readTarget()).canApply,
    canApplyOriginal:
      isCurrent(review) &&
      selectDictationFormatting(review.result, review.target, readTarget(), true).canApply,
  };
}

export function mergeDictationMarkerConfirmations(
  accepted: readonly DictationRange[],
  requested: readonly DictationRange[],
): readonly DictationRange[] {
  return [
    ...accepted,
    ...requested.filter(
      (range) => !accepted.some((item) => item.start === range.start && item.end === range.end),
    ),
  ];
}

export function commitReceipt(committed: boolean | void): DictationFormattingReceipt {
  return committed === true
    ? "committed"
    : committed === false
      ? "not-committed"
      : "outcome-unknown";
}

export function prepareReview(
  prepare: PrepareFormatting,
  review: DictationFormattingReview,
  mode: DictationFormattingMode,
  ranges?: readonly DictationRange[],
) {
  const markers = ranges
    ? mergeDictationMarkerConfirmations(review.result.document?.confirmedMarkers ?? [], ranges)
    : undefined;
  return prepareDictationResult(prepare, review.result.originalText, mode, review.source, markers);
}

function finalPreparation(
  mode: DictationFormattingMode,
  generation: number,
  capture: DictationFormattingCapture | undefined,
  client: GatewayBrowserClient,
) {
  return {
    mode,
    generation,
    capture,
    target: capture?.target,
    client: capture?.client ?? client,
    auth: capture?.auth,
    connection: capture?.connection,
    stoppedAt: performance.now(),
  };
}

/** Pure preparation is injected lazily; this helper never publishes or inserts. */
export function prepareDictationResult(
  prepare: typeof prepareDictationFormatting,
  text: string,
  mode: DictationFormattingMode,
  source: DictationFormattingSource,
  confirmedMarkers?: readonly DictationRange[],
): DictationFormattingResult {
  const started = performance.now();
  const result = prepare(text, source.finalized ? mode : "preserve", {
    sourceId: source.id,
    sourceRevision: source.revision,
    confirmedMarkers,
  });
  return !source.finalized || performance.now() - started > 2_500
    ? {
        ...result,
        status: "raw-fallback",
        plainText: text,
        markdown: "",
        html: "",
        document: undefined,
        reason: source.finalized || source.timedOut ? "deadline" : "incomplete-transcript",
      }
    : result;
}

export function prepareFinalReview(
  prepare: PrepareFormatting,
  text: string,
  transcript: {
    transcriptRevision: number;
    finalResultIsComplete: boolean;
    finalResultTimedOut: boolean;
  },
  preparation: ReturnType<typeof finalPreparation>,
): DictationFormattingReview {
  const { mode, generation, capture, target, client, auth, connection, stoppedAt } = preparation;
  const source: DictationFormattingSource = {
    id: `composer-${generation}`,
    revision: transcript.transcriptRevision,
    finalized: transcript.finalResultIsComplete,
    timedOut: transcript.finalResultTimedOut,
  };
  const prepareStartedAt = performance.now();
  const result = prepareDictationResult(prepare, text, mode, source);
  return {
    version: 1,
    result,
    source,
    timing: {
      finalizationMs: prepareStartedAt - stoppedAt,
      localMs: performance.now() - prepareStartedAt,
    },
    target,
    generation,
    client,
    auth: auth!,
    connection: connection!,
    mode,
    receipt: "not-committed",
    invalidated: capture?.invalidated === true,
  };
}

/** Reviewed text replaces exactly the range captured before recognition. */
export function placeReviewedDictation(text: string, { target }: ReviewedDictationPlacement) {
  const before = target.value.slice(0, target.start);
  return {
    value: before + text + target.value.slice(target.end),
    caret: before.length + text.length,
    captured: null,
  };
}

/** No write, retry, clipboard operation or app-name inference occurs here. */
export function selectDictationFormatting(
  result: DictationFormattingResult,
  captured: DictationFormattingTarget | undefined,
  live: DictationFormattingTarget | undefined,
  original = false,
): { text: string; format: "text/plain" | "text/markdown" | "text/html"; canApply: boolean } {
  const fallback = {
    text: original ? result.originalText : result.plainText,
    format: "text/plain" as const,
    canApply: false,
  };
  if (!sameDictationFormattingTarget(captured, live) || !live) {
    return fallback;
  }
  const capability = live.capabilities;
  if (
    !original &&
    result.document &&
    capability.formats.includes("text/html") &&
    capability.richTextProfile === "safe-blocks-v1"
  ) {
    // This client has no qualified rich insertion adapter. Keep preparation separate.
    return { text: result.html, format: "text/html", canApply: false };
  }
  if (
    !original &&
    result.document &&
    capability.formats.includes("text/markdown") &&
    capability.markdownProfile === "commonmark-0.31.2-lists"
  ) {
    const text = result.markdown;
    return {
      text,
      format: "text/markdown",
      // Surrounding Markdown can turn a list into fenced, quoted, or inline content.
      canApply: live.start === 0 && live.end === live.value.length && fits(text, live),
    };
  }
  return {
    ...fallback,
    canApply: capability.formats.includes("text/plain") && fits(fallback.text, live),
  };
}

function fits(text: string, target: DictationFormattingTarget): boolean {
  const { safeMultiline, maxLength } = target.capabilities;
  return (
    (safeMultiline || !/[\r\n]/u.test(text)) &&
    (maxLength === undefined ||
      target.value.length - (target.end - target.start) + text.length <= maxLength)
  );
}

/** Perform the admitted editor transaction without transferring draft ownership. */
export function applyReview(
  review: DictationFormattingReview,
  choice: "formatted" | "original",
  readOptions: () => ComposerDictationOwnerOptions,
  stillCurrent: () => boolean,
  onReceipt: (receipt: DictationFormattingReceipt) => void,
): DictationFormattingReceipt {
  const selection = selectDictationFormatting(
    review.result,
    review.target,
    readOptions().readFormattingTarget?.(),
    choice === "original",
  );
  if (!selection.canApply) {
    review.invalidated = true;
    return review.receipt;
  }
  // Set the receipt before the indivisible attempt. A callback can cancel/reenter;
  // that cannot authorize another write or make an uncertain effect disappear.
  review.receipt = "outcome-unknown";
  onReceipt(review.receipt);
  try {
    const placement = { target: review.target!, format: selection.format };
    const insertion = placeReviewedDictation(selection.text, placement);
    const isCurrent = () =>
      stillCurrent() &&
      selectDictationFormatting(
        review.result,
        review.target,
        readOptions().readFormattingTarget?.(),
        choice === "original",
      ).canApply;
    const committed = readOptions().onCommit(selection.text, true, undefined, {
      ...placement,
      insertion,
      isCurrent,
      applyTo: (input) =>
        replaceComposerInputWithHistory(input, insertion.value, isCurrent, placement.target),
    });
    review.receipt = commitReceipt(committed);
  } catch {
    review.receipt = "outcome-unknown";
  }
  review.invalidated = true;
  onReceipt(review.receipt);
  return review.receipt;
}

/** Loaded for Explicit capture only; the gesture owner retains capture admission. */
export class ComposerDictationReviewState {
  current: DictationFormattingReview | undefined;
  receipt: DictationFormattingReceipt = "not-committed";
  readonly finalPreparation = finalPreparation;

  constructor(
    private readonly options: () => ComposerDictationOwnerOptions,
    private readonly policy: () => DictationFormattingMode,
    private readonly sourceIsCurrent: (review: DictationFormattingAuthority) => boolean,
    private readonly changed: () => void,
  ) {}

  get projection() {
    return reviewProjection(
      this.current,
      (review) => this.isCurrent(review),
      () => this.options().readFormattingTarget?.(),
    );
  }

  finalize(
    text: string,
    session: Parameters<typeof prepareFinalReview>[2],
    preparation: ReturnType<typeof finalPreparation>,
    policyChanged: boolean,
  ): void {
    const review = prepareFinalReview(prepareDictationFormatting, text, session, preparation);
    review.invalidated ||= policyChanged;
    this.current = review;
    this.receipt = "not-committed";
  }

  reprocess(advance: () => number, ranges?: readonly DictationRange[]): void {
    const mode = this.policy();
    const review = this.current;
    if (!review || review.receipt !== "not-committed" || !this.sourceIsCurrent(review)) {
      return;
    }
    if (ranges && (!this.isCurrent(review) || !review.source.finalized || mode !== "explicit")) {
      return;
    }
    // Reprocessing never retargets the draft or reacquires a lost selection.
    const result = prepareReview(prepareDictationFormatting, review, mode, ranges);
    this.current = { ...review, result, generation: advance(), mode, invalidated: false };
    this.changed();
  }

  accept(choice: "formatted" | "original"): boolean {
    const review = this.current;
    if (!review || !this.isCurrent(review)) {
      return false;
    }
    const receipt = applyReview(
      review,
      choice,
      this.options,
      () => this.current === review && this.isCurrent(review, "outcome-unknown"),
      (next) => {
        this.receipt = next;
      },
    );
    this.changed();
    return receipt === "committed";
  }

  invalidate(): void {
    if (this.current) {
      this.current.invalidated = true;
    }
  }

  clear(): void {
    this.current = undefined;
  }

  private isCurrent(
    review: DictationFormattingReview,
    receipt: DictationFormattingReceipt = "not-committed",
  ): boolean {
    return (
      this.options().enabled &&
      this.sourceIsCurrent(review) &&
      !review.invalidated &&
      review.mode === this.policy() &&
      review.receipt === receipt
    );
  }
}
