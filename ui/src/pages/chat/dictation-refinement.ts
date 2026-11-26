import type { DictationCleanupPolicy } from "../../app/settings-contract.ts";
import {
  refineDictation,
  isCleanupSourceBounded,
  type CleanupReason,
  type CleanupRemoval,
  type CleanupResult,
  type DictationCleanupSource,
} from "./dictation-cleanup.ts";

/** A receipt can replace only the unchanged, unsent insertion that created it. */
export type DictationDraftReceipt = {
  isCurrent: () => boolean;
  restore: (text: string) => boolean;
};

export type DictationDraftSnapshot = { revision: number; value: string };

export type DictationCleanupReview = {
  rawText: string;
  candidateText: string;
  removals: readonly CleanupRemoval[];
  reason?: CleanupReason;
  status: "pending" | "ready" | "failed" | "unavailable";
  applied: boolean;
  publicationUncertain: boolean;
  canAccept: boolean;
  canUseRaw: boolean;
  canRetry: boolean;
};

type DraftBinding = {
  /** Reuses the capture owner's connection, mode and draft scope. */
  isCurrent: () => boolean;
  readDraft: () => DictationDraftSnapshot | undefined;
  publish: (text: string) => DictationDraftReceipt | false | void;
};

type Preparation = {
  source: DictationCleanupSource;
  policy: DictationCleanupPolicy;
  binding: DraftBinding;
  draft: DictationDraftSnapshot | undefined;
  status: DictationCleanupReview["status"];
  result: CleanupResult | null;
  receipt: DictationDraftReceipt | null;
  applied: boolean;
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
    return Boolean(this.preparation && !this.preparation.applied && !this.preparation.cancelled);
  }

  get review(): DictationCleanupReview | null {
    const preparation = this.preparation;
    if (!preparation) {
      return null;
    }
    const authorized = preparation.binding.isCurrent();
    const unedited = authorized && this.matchesDraft(preparation);
    const restorable = authorized && preparation.receipt?.isCurrent() === true;
    return {
      rawText: authorized ? preparation.source.text : "",
      candidateText: authorized ? (preparation.result?.candidate ?? preparation.source.text) : "",
      removals: authorized ? (preparation.result?.removals ?? []) : [],
      reason: authorized ? preparation.result?.reason : undefined,
      status:
        !authorized || preparation.status === "unavailable"
          ? "unavailable"
          : !unedited && !preparation.applied
            ? "failed"
            : preparation.status,
      applied: preparation.applied,
      publicationUncertain: preparation.applied && preparation.status === "failed",
      canAccept:
        unedited &&
        !preparation.applied &&
        preparation.status === "ready" &&
        preparation.result?.status === "refined",
      canUseRaw: preparation.applied
        ? restorable
        : unedited && preparation.status !== "unavailable",
      canRetry:
        authorized &&
        !preparation.applied &&
        preparation.source.isFinal &&
        preparation.result?.reason !== "semantic-unavailable",
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
      result: null,
      receipt: null,
      applied: false,
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
    preparation.result = null;
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
    // Retire the candidate before calling an external draft owner: callbacks can
    // synchronously trigger rendering, edits, cancellation, or another choice.
    preparation.generation = ++this.generation;
    let restored: boolean;
    try {
      restored = preparation.applied
        ? preparation.receipt?.restore(preparation.source.text) === true
        : this.publish(preparation, preparation.source.text);
    } catch {
      preparation.receipt = null;
      preparation.status = "failed";
      this.changed();
      return false;
    }
    if (restored && this.preparation === preparation) {
      this.dismiss();
    }
    return restored;
  }

  accept(): boolean {
    const preparation = this.preparation;
    if (!preparation || !this.review?.canAccept || !preparation.result) {
      return false;
    }
    preparation.generation = ++this.generation;
    return this.publish(preparation, preparation.result.candidate);
  }

  /** Cancel computation and future automatic publication, retaining eligible text for review. */
  cancel(): void {
    const preparation = this.preparation;
    if (!preparation || preparation.applied) {
      return;
    }
    preparation.generation = ++this.generation;
    preparation.cancelled = true;
    if (preparation.status !== "unavailable") {
      preparation.status = "failed";
    }
    preparation.result = null;
    this.changed();
  }

  /** Scope loss/disposal releases source text as well as candidate and receipt. */
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
    // A single deferred local stage gives raw choice and cancel the same generation
    // boundary as future optional handlers, without a provider request per feature.
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
      let result: CleanupResult;
      try {
        result = refineDictation(preparation.source, preparation.policy);
      } catch {
        // No transcript or exception payload enters telemetry. Recovery still
        // uses the same permission and draft checks as a successful preparation.
        preparation.status = "failed";
        preparation.result = null;
        this.changed();
        return;
      }
      if (this.preparation !== preparation || preparation.generation !== generation) {
        return;
      }
      // The input bound makes this a short synchronous stage. A stalled client
      // must still offer original text rather than a result outside its deadline.
      if (
        performance.now() - started > 2_500 ||
        result.status === "rejected" ||
        !preparation.source.isFinal
      ) {
        preparation.status = "failed";
        preparation.result = null;
      } else {
        preparation.result = result;
        preparation.status = "ready";
      }
      this.changed();
    });
  }

  private publish(preparation: Preparation, text: string): boolean {
    if (
      preparation.applied ||
      !preparation.binding.isCurrent() ||
      !this.matchesDraft(preparation)
    ) {
      return false;
    }
    // The synchronous owner records the attempted write before invoking its
    // adapter. An exception is not permission to replay an uncertain write.
    preparation.applied = true;
    preparation.receipt = null;
    try {
      const receipt = preparation.binding.publish(text);
      if (receipt === false) {
        preparation.applied = false;
        preparation.status = "failed";
        preparation.result = null;
        return false;
      }
      preparation.receipt = receipt ?? null;
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
