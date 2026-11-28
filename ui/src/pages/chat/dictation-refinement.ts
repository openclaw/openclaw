import type { DictationCleanupPolicy } from "../../app/settings-contract.ts";
import {
  dictationReviewReason,
  isCleanupSourceBounded,
  type CleanupReason,
  type DictationCleanupSource,
} from "./dictation-cleanup.ts";

export type DictationDraftSnapshot = { revision: number; value: string };

export type DictationCleanupReview = {
  rawText: string;
  reason?: CleanupReason;
  status: "pending" | "ready" | "failed" | "unavailable";
  publicationUncertain: boolean;
  canUseRaw: boolean;
  canRetry: boolean;
};

type DraftBinding = {
  /** Reuses the capture owner's connection, mode and draft scope. */
  isCurrent: () => boolean;
  readDraft: () => DictationDraftSnapshot | undefined;
  publish: (text: string) => false | void;
};

type Preparation = {
  source: DictationCleanupSource;
  policy: DictationCleanupPolicy;
  binding: DraftBinding;
  draft: DictationDraftSnapshot | undefined;
  status: DictationCleanupReview["status"];
  reason?: CleanupReason;
  writeAttempted: boolean;
  cancelled: boolean;
  generation: number;
};

/**
 * One bounded, in-memory preparation for the existing dictation owner. It never
 * captures audio, resolves a provider, creates a queue, or sends a message.
 */
export class DictationRefinement {
  private preparation: Preparation | null = null;
  private generation = 0;

  constructor(private readonly changed: () => void) {}

  get blocksCapture(): boolean {
    return Boolean(
      this.preparation && !this.preparation.writeAttempted && !this.preparation.cancelled,
    );
  }

  get review(): DictationCleanupReview | null {
    const preparation = this.preparation;
    if (!preparation) {
      return null;
    }
    const authorized = preparation.binding.isCurrent();
    const unedited = authorized && this.matchesDraft(preparation);
    return {
      rawText: authorized ? preparation.source.text : "",
      reason: authorized ? preparation.reason : undefined,
      status:
        !authorized || preparation.status === "unavailable"
          ? "unavailable"
          : !unedited && !preparation.writeAttempted
            ? "failed"
            : preparation.status,
      publicationUncertain: preparation.writeAttempted && preparation.status === "failed",
      canUseRaw: unedited && !preparation.writeAttempted && preparation.status !== "unavailable",
      canRetry:
        authorized &&
        !preparation.writeAttempted &&
        preparation.source.isFinal &&
        preparation.reason !== "semantic-unavailable",
    };
  }

  prepare(
    source: DictationCleanupSource,
    policy: DictationCleanupPolicy,
    binding: DraftBinding,
    draft: DictationDraftSnapshot | undefined,
  ): void {
    const bounded = isCleanupSourceBounded(source.text);
    this.preparation = {
      source: bounded
        ? source
        : { id: source.id, revision: source.revision, text: "", isFinal: false },
      policy,
      binding,
      draft,
      status: bounded ? "pending" : "unavailable",
      writeAttempted: false,
      cancelled: false,
      generation: ++this.generation,
    };
    if (bounded) {
      this.run(this.preparation);
    } else {
      this.changed();
    }
  }

  /** Retry is a new user intent, using existing text and the current unsent draft. */
  retry(policy: DictationCleanupPolicy): void {
    const preparation = this.preparation;
    if (!preparation || !this.review?.canRetry) {
      return;
    }
    preparation.policy = policy;
    preparation.draft = preparation.binding.readDraft();
    preparation.reason = undefined;
    preparation.cancelled = false;
    preparation.status = "pending";
    preparation.generation = ++this.generation;
    this.run(preparation);
  }

  chooseRaw(): boolean {
    const preparation = this.preparation;
    if (!preparation || !this.review?.canUseRaw) {
      return false;
    }
    // Retire deferred validation before calling the draft owner: callbacks can
    // synchronously trigger rendering, edits, cancellation, or another choice.
    preparation.generation = ++this.generation;
    return this.publish(preparation);
  }

  /** Cancel validation while retaining eligible text for review. */
  cancel(): void {
    const preparation = this.preparation;
    if (!preparation || preparation.writeAttempted) {
      return;
    }
    preparation.generation = ++this.generation;
    preparation.cancelled = true;
    if (preparation.status !== "unavailable") {
      preparation.status = "failed";
    }
    preparation.reason = undefined;
    this.changed();
  }

  /** Scope loss/disposal releases the recognized source. */
  dismiss(): void {
    this.generation += 1;
    this.preparation = null;
    this.changed();
  }

  private matchesDraft(preparation: Preparation): boolean {
    const current = preparation.binding.readDraft();
    return Boolean(
      current &&
      preparation.draft &&
      current.revision === preparation.draft.revision &&
      current.value === preparation.draft.value,
    );
  }

  private run(preparation: Preparation): void {
    const generation = preparation.generation;
    this.changed();
    // Let the review render before checking the source.
    queueMicrotask(() => {
      if (this.preparation !== preparation || preparation.generation !== generation) {
        return;
      }
      if (!preparation.binding.isCurrent()) {
        this.dismiss();
        return;
      }
      if (!this.matchesDraft(preparation)) {
        preparation.status = "failed";
        this.changed();
        return;
      }
      const started = performance.now();
      const reason = dictationReviewReason(preparation.source, preparation.policy);
      if (this.preparation !== preparation || preparation.generation !== generation) {
        return;
      }
      // The input bound makes this a short synchronous stage. A stalled client
      // must still offer original text rather than a result outside its deadline.
      if (performance.now() - started > 2_500 || !preparation.source.isFinal) {
        preparation.status = "failed";
        preparation.reason = undefined;
      } else {
        preparation.reason = reason;
        preparation.status = "ready";
      }
      this.changed();
    });
  }

  private publish(preparation: Preparation): boolean {
    if (
      preparation.writeAttempted ||
      !preparation.binding.isCurrent() ||
      !this.matchesDraft(preparation)
    ) {
      return false;
    }
    // The synchronous owner records the attempted write before invoking its
    // adapter. An exception is not permission to replay an uncertain write.
    preparation.writeAttempted = true;
    try {
      if (preparation.binding.publish(preparation.source.text) === false) {
        preparation.writeAttempted = false;
        preparation.status = "failed";
        preparation.reason = undefined;
        return false;
      }
      if (this.preparation === preparation) {
        this.preparation = null;
      }
      return true;
    } catch {
      // An uncertain attempted write is never retried or represented as success.
      preparation.status = "failed";
      return false;
    } finally {
      this.changed();
    }
  }
}
