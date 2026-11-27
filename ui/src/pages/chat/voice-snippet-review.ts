import {
  refineDictation,
  type DictationRefinementRequest,
  type DictationRefinementResult,
} from "../../../../src/shared/dictation-refinement.js";
import {
  DictationSnippetIndex,
  initialSnippetIntents,
  selectSnippetIntent,
  type SnippetIntent,
  type SnippetProblem,
} from "../../../../src/shared/dictation-snippets.js";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { VoiceSnippetCatalog } from "../../../../src/shared/voice-snippets.js";

export type VoiceSnippetReviewSnapshot = {
  sourceText: string;
  text: string;
  problems: readonly SnippetProblem[];
  busy: boolean;
  error: string | null;
  canAccept: boolean;
  fallbackOnly: boolean;
  expandedCount: number;
};

/** Presentation of one pending capture. The existing composer remains the only draft writer. */
export class VoiceSnippetReview {
  private readonly changes = createChangeListeners();
  readonly subscribe = this.changes.subscribe;
  private readonly index: DictationSnippetIndex;
  private intents: SnippetIntent[];
  private readonly choices = new Map<string, string>();
  private result: DictationRefinementResult | null = null;
  private problems: SnippetProblem[] = [];
  private busy = false;
  private error: string | null = null;
  private fallbackOnly = false;
  private terminal = false;
  private revision = 0;

  constructor(
    private readonly options: {
      request: DictationRefinementRequest;
      catalog: VoiceSnippetCatalog;
      signal: AbortSignal;
      isCurrent: () => boolean;
      deliver: (
        result: DictationRefinementResult,
      ) => "committed" | "not-committed" | "outcome-unknown";
      literalCode?: boolean;
    },
  ) {
    this.index = new DictationSnippetIndex(options.catalog);
    this.intents = initialSnippetIntents(options.request, options.literalCode);
  }

  snapshot(): VoiceSnippetReviewSnapshot {
    const current = this.current();
    return {
      sourceText: current ? this.options.request.rawTranscript : "",
      text: current ? (this.result?.text ?? this.options.request.rawTranscript) : "",
      problems: current ? this.problems : [],
      busy: this.busy,
      error: current ? this.error : "cancelled",
      canAccept:
        current &&
        !this.busy &&
        !this.error &&
        !this.fallbackOnly &&
        this.problems.length === 0 &&
        this.result !== null,
      fallbackOnly: this.fallbackOnly,
      expandedCount:
        this.result?.protectedSpans.filter((span) => span.snippetId !== undefined).length ?? 0,
    };
  }

  private current(): boolean {
    return !this.terminal && !this.options.signal.aborted && this.options.isCurrent();
  }

  async prepare(): Promise<void> {
    if (!this.current()) {
      return;
    }
    const revision = ++this.revision;
    this.busy = true;
    this.error = null;
    this.changes.publish();
    try {
      // Catalog content belongs to the admitted capture. Connection and
      // destination checks still apply when the user acts on the review.
      const resolved = this.index.resolve(
        this.options.request,
        this.intents,
        this.options.catalog,
        this.choices,
      );
      const escapes = resolved.literalEdits.map((edit) => ({
        intentId: `${this.options.request.captureId}:literal:${edit.start}:${edit.end}`,
        start: edit.start,
        end: edit.end,
        source: this.options.request.rawTranscript.slice(edit.start, edit.end),
        text: edit.text,
      }));
      const result = await refineDictation(
        this.options.request,
        [...resolved.candidates, ...escapes],
        { signal: this.options.signal },
      );
      if (!this.current() || revision !== this.revision) {
        return;
      }
      this.problems = resolved.problems;
      this.result = result;
      // HTML text controls normalize CR and cannot promise NUL fidelity. Keep the exact
      // string available for an explicit UTF-8 download instead of silently changing it.
      this.fallbackOnly = result.text.includes("\r") || result.text.includes("\u0000");
      this.error = this.fallbackOnly ? "unsupported-encoding" : null;
    } catch {
      if (this.current() && revision === this.revision) {
        this.result = null;
        this.error = "unavailable";
      }
    } finally {
      if (revision === this.revision) {
        this.busy = false;
        this.changes.publish();
      }
    }
  }

  choose(intentId: string, id: string): void {
    if (
      this.busy ||
      !this.current() ||
      !this.problems.some(
        (problem) =>
          problem.intentId === intentId && problem.choices.some((choice) => choice.id === id),
      )
    ) {
      return;
    }
    this.choices.set(intentId, id);
    void this.prepare();
  }

  selectCommand(start: number, end: number): void {
    if (this.busy || !this.current()) {
      return;
    }
    try {
      this.intents = selectSnippetIntent(this.options.request, this.intents, start, end);
      void this.prepare();
    } catch {
      this.error = "invalid-selection";
      this.changes.publish();
    }
  }

  async accept(): Promise<boolean> {
    if (!this.snapshot().canAccept || !this.result) {
      return false;
    }
    this.busy = true;
    this.changes.publish();
    try {
      if (!this.current()) {
        return false;
      }
      const outcome = this.options.deliver(this.result);
      // A delivery attempt is never automatically replayed, including uncertain effects.
      if (outcome !== "committed") {
        this.fallbackOnly = true;
        this.error = "changed-target";
        return false;
      }
      this.terminal = true;
      return true;
    } catch {
      this.result = null;
      this.error = "unavailable";
      return false;
    } finally {
      this.busy = false;
      this.changes.publish();
    }
  }

  /** Recover the admitted result while its capture and connection are current. */
  exportText(): string | null {
    if (
      !this.current() ||
      this.busy ||
      !this.result ||
      this.problems.length ||
      (this.error !== null &&
        this.error !== "changed-target" &&
        this.error !== "unsupported-encoding")
    ) {
      return null;
    }
    return this.result.text;
  }

  cancel(): void {
    this.terminal = true;
    this.revision += 1;
    this.result = null;
    this.choices.clear();
    this.changes.publish();
  }
}
