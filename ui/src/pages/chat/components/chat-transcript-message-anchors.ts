import type { Range, Virtualizer } from "@tanstack/virtual-core";
import { extractTranscriptRange } from "./chat-transcript-range.ts";

type ChatTranscriptMessageAnchor = { messageKey: string; rowKey: string | null; top: number };
type TranscriptMessageKeys = Pick<ReadonlySet<string>, "keys" | "has">;

/** Own the message anchor across projection capture, measurement, and restoration. */
export class TranscriptMessageAnchors {
  messageKeys: TranscriptMessageKeys = new Set();
  committedMessageRows: ReadonlyMap<string, string> = new Map();
  private firstMessageKey: string | undefined;
  private prependReturn: (ChatTranscriptMessageAnchor & { measured: boolean }) | null = null;

  private searchFiltered = false;
  private searchEmpty = false;
  private searchReturn: {
    anchor: ChatTranscriptMessageAnchor;
    phase: "captured" | "pending" | "committed" | "measured";
  } | null = null;

  setSearchState(
    element: HTMLDivElement | null,
    filtered: boolean,
    empty: boolean,
    following: boolean,
  ): void {
    if (filtered && (!this.searchFiltered || (empty && !this.searchEmpty && !this.searchReturn))) {
      const anchor = following
        ? null
        : captureTranscriptMessageAnchor(element, this.committedMessageRows);
      if (anchor && element) {
        anchor.top -= element.getBoundingClientRect().top;
      }
      this.searchReturn = anchor ? { anchor, phase: "captured" } : null;
    } else if (!filtered && this.searchFiltered) {
      if (this.searchEmpty && this.searchReturn && !following) {
        this.searchReturn.phase = "pending";
      } else {
        this.searchReturn = null;
      }
    }
    this.searchFiltered = filtered;
    this.searchEmpty = filtered && empty;
  }

  get restoringSearch(): boolean {
    return this.searchReturn?.phase === "committed" || this.searchReturn?.phase === "measured";
  }

  /** Stable message identity used to resolve its row in the committed projection. */
  get messageKey(): string | null {
    return this.prependReturn?.messageKey ?? null;
  }

  /** Keep the retained row mounted while virtual and native offsets reconcile. */
  get rowKey(): string | null {
    return this.prependReturn?.rowKey ?? null;
  }

  /** Keep the retained bubble mounted against the committed, not candidate, row map. */
  extractRange(
    range: Range,
    indexes: ReadonlyMap<string, number>,
    focusedRowKey: string | null,
  ): number[] {
    const search = this.searchReturn;
    const returnKey =
      search && this.restoringSearch
        ? this.committedMessageRows.get(search.anchor.messageKey)
        : null;
    const returnIndex = returnKey ? indexes.get(returnKey) : undefined;
    // Render the destination neighborhood before measuring, rather than adding one distant row
    // to the empty projection's clamped viewport. Keep the existing window and overscan budget.
    const visibleRange =
      returnIndex === undefined
        ? range
        : {
            ...range,
            startIndex: returnIndex,
            endIndex: Math.min(range.count - 1, returnIndex + range.endIndex - range.startIndex),
          };
    const messageKey = this.messageKey;
    const rowKey =
      (messageKey === null ? null : this.committedMessageRows.get(messageKey)) ?? this.rowKey;
    return extractTranscriptRange(visibleRange, indexes, [
      focusedRowKey,
      rowKey,
      returnKey ?? null,
    ]);
  }

  /** Whether the next projection inserts history before the committed first message. */
  get hasPrepend(): boolean {
    return Boolean(
      this.firstMessageKey &&
      this.firstMessageKey !== this.messageKeys.keys().next().value &&
      this.messageKeys.has(this.firstMessageKey),
    );
  }

  /** Resolve a pending search return or capture history against the committed projection. */
  capture(element: HTMLDivElement | null, commanded: boolean, following = false): void {
    const search = this.searchReturn;
    if (search && (search.phase === "pending" || this.restoringSearch)) {
      const rowKey = this.committedMessageRows.get(search.anchor.messageKey);
      if (rowKey && !following && !commanded) {
        if (search.phase === "pending" || search.anchor.rowKey !== rowKey) {
          search.phase = "committed";
        }
        search.anchor.rowKey = rowKey;
        this.prependReturn = null;
      } else {
        this.searchReturn = null;
      }
    }
    const anchor =
      commanded || this.restoringSearch
        ? null
        : captureTranscriptPrependAnchor(element, this.firstMessageKey, this.messageKeys);
    if (anchor) {
      this.prependReturn = { ...anchor, measured: false };
    }
    this.firstMessageKey = this.messageKeys.keys().next().value;
  }

  /** Measure estimated rows before restoring the retained message on the next commit. */
  update(
    element: HTMLDivElement | null,
    virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    measureRows: () => void,
    following = false,
    onRestored?: () => void,
  ): boolean {
    const search = this.searchReturn;
    if (search && this.restoringSearch) {
      if (following || !element) {
        this.searchReturn = null;
        return true;
      }
      if (search.phase === "committed") {
        return false;
      }
      this.searchReturn = null;
      const restored = restoreTranscriptMessageAnchor(
        { ...search.anchor, top: search.anchor.top + element.getBoundingClientRect().top },
        element,
        virtualizer,
        0,
      );
      if (restored !== null) {
        onRestored?.();
      }
      // Commit ordinary overscan skipping again, including when no scroll write was needed.
      return true;
    }
    const anchor = this.prependReturn;
    if (!anchor) {
      return false;
    }
    if (!anchor.measured) {
      measureRows();
      anchor.measured = true;
      return true;
    }
    this.prependReturn = null;
    return restoreTranscriptMessageAnchor(anchor, element, virtualizer) ?? false;
  }

  /** Measure after nested row controls commit, before the sizer's restoration commit. */
  measureSearchReturn(measureRows: () => boolean): boolean {
    const search = this.searchReturn;
    if (search?.phase !== "committed") {
      return false;
    }
    if (!measureRows()) {
      return false;
    }
    search.phase = "measured";
    return true;
  }

  /** Carry the viewport target with native reader movement, not layout growth. */
  moveWithReader(delta: number): void {
    this.searchReturn = null;
    if (this.prependReturn) {
      this.prependReturn.top -= delta;
    }
  }

  /** Retire pending restoration when the reader or another command takes over. */
  clear(): void {
    this.searchReturn = null;
    this.prependReturn = null;
  }

  disconnect(): void {
    this.clear();
    this.searchFiltered = false;
    this.searchEmpty = false;
  }

  /** Drop projection identity when the owning session is disposed. */
  reset(): void {
    this.disconnect();
    this.firstMessageKey = undefined;
    this.messageKeys = new Set();
    this.committedMessageRows = new Map();
  }
}

/** Capture the message being read before older history changes its containing row. */
function captureTranscriptPrependAnchor(
  scrollElement: HTMLDivElement | null,
  previousFirstMessageKey: string | undefined,
  next: TranscriptMessageKeys,
): ChatTranscriptMessageAnchor | null {
  const first = previousFirstMessageKey;
  if (!scrollElement || !first || first === next.keys().next().value || !next.has(first)) {
    return null;
  }
  return captureTranscriptMessageAnchor(scrollElement, next);
}

function captureTranscriptMessageAnchor(
  scrollElement: HTMLDivElement | null,
  next: TranscriptMessageKeys,
): ChatTranscriptMessageAnchor | null {
  if (!scrollElement) {
    return null;
  }
  const viewport = scrollElement.getBoundingClientRect();
  // Only rendered, retained bubbles can anchor the reader; overscan above the
  // viewport and messages removed by the new projection are not candidates.
  for (const bubble of scrollElement.querySelectorAll<HTMLElement>(
    ".chat-bubble[data-message-id]",
  )) {
    const messageKey = bubble.dataset.messageId;
    const rect = bubble.getBoundingClientRect();
    if (
      messageKey &&
      next.has(messageKey) &&
      rect.bottom > viewport.top &&
      rect.top < viewport.bottom
    ) {
      return {
        messageKey,
        rowKey: bubble.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey ?? null,
        top: rect.top,
      };
    }
  }
  return null;
}

/** Reconcile the inner-message anchor after the virtualizer commits its row anchor. */
function restoreTranscriptMessageAnchor(
  anchor: ChatTranscriptMessageAnchor | null,
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  tolerance = 1,
): boolean | null {
  if (!anchor || !scrollElement) {
    return null;
  }
  // Group renderers may replace the bubble at an array index during prepend;
  // resolve its stable render key in the committed DOM, not an old element.
  const bubble = [
    ...scrollElement.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
  ].find((element) => element.dataset.messageId === anchor.messageKey);
  if (!bubble) {
    return null;
  }
  const delta = bubble.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) <= tolerance) {
    return false;
  }
  const offset = Math.max(0, scrollElement.scrollTop + delta);
  // Commit one measured message target through the scroll owner. This also
  // retires deferred row corrections already represented by the measured DOM.
  virtualizer.scrollToOffset(offset, { behavior: "instant" });
  return true;
}
