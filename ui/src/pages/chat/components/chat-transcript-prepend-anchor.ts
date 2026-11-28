import type { Range, Virtualizer } from "@tanstack/virtual-core";
import { captureChatSessionScrollPosition } from "../scroll.ts";
import { extractTranscriptRange } from "./chat-transcript-range.ts";
import type {
  TranscriptProjectionSource,
  TranscriptSearchProjection,
} from "./chat-transcript-session.ts";

type ChatTranscriptPrependAnchor = { messageKey: string; rowKey: string | null; top: number };
type TranscriptMessageKeys = Pick<ReadonlySet<string>, "keys" | "has">;

/** Own the message anchor across projection capture, measurement, and restoration. */
export class TranscriptPrependAnchor {
  messageKeys: TranscriptMessageKeys = new Set();
  committedMessageRows: ReadonlyMap<string, string> = new Map();
  private searchProjection: TranscriptSearchProjection = null;
  private searchReturn: ChatTranscriptPrependAnchor | "end" | null = null;
  private searchPlacement: "reader" | "end" | null = null;
  private firstMessageKey: string | undefined;
  private source?: TranscriptProjectionSource;
  private firstSourceMessage: unknown;
  private pending:
    | (ChatTranscriptPrependAnchor & { measured: boolean; prepended: boolean })
    | null = null;

  constructor(
    private readonly messageElements: ReadonlyMap<string, HTMLElement>,
    private readonly onLayoutCorrection: (before: number, after: number) => void,
    private readonly measurePrependedRows: () => boolean,
  ) {}

  /** Stable message identity used to resolve its row in the committed projection. */
  get messageKey(): string | null {
    return this.pending?.messageKey ?? null;
  }

  /** Keep the retained bubble mounted against the committed, not candidate, row map. */
  extractRange(
    range: Range,
    indexes: ReadonlyMap<string, number>,
    focusedRowKey: string | null,
  ): number[] {
    const messageKey = this.messageKey;
    const rowKey =
      (messageKey === null ? null : this.committedMessageRows.get(messageKey)) ??
      this.pending?.rowKey ??
      null;
    return extractTranscriptRange(range, indexes, [focusedRowKey, rowKey]);
  }

  get returningReader(): boolean {
    return this.searchPlacement === "reader";
  }

  commitSearchReturn(restoreEnd: () => void): void {
    const end = this.searchPlacement === "end";
    this.searchPlacement = null;
    if (end) {
      restoreEnd();
    }
  }

  /** Track the source history boundary and the reader to restore across an empty search. */
  project(
    messageKeys: TranscriptMessageKeys,
    source: TranscriptProjectionSource | undefined,
    element: HTMLDivElement | null,
    following: boolean,
  ): void {
    this.messageKeys = messageKeys;
    this.source = source;
    const projection = source?.search ?? null;
    const previous = this.searchProjection;
    if (previous?.query === projection?.query && previous?.empty === projection?.empty) {
      return;
    }
    this.searchProjection = projection;
    this.searchPlacement = null;
    if (projection && !previous?.empty && !this.searchReturn) {
      this.searchReturn =
        following &&
        !previous?.query &&
        element &&
        captureChatSessionScrollPosition(element).anchorToEnd
          ? "end"
          : captureTranscriptPrependAnchor(
              element,
              this.committedMessageRows,
              this.messageElements.values(),
            );
    }
    const position = this.searchReturn;
    if (!projection) {
      this.searchReturn = null;
    }
    if (previous?.empty && !projection?.query) {
      if (position === "end") {
        this.searchPlacement = "end";
      } else if (position && this.messageKeys.has(position.messageKey)) {
        this.pending = { ...position, measured: false, prepended: false };
        this.searchPlacement = "reader";
      }
    }
  }

  /** Whether the next projection inserts history before the committed first message. */
  get hasPrepend(): boolean {
    return Boolean(
      this.firstMessageKey &&
      this.firstMessageKey !== this.messageKeys.keys().next().value &&
      (this.messageKeys.has(this.firstMessageKey) ||
        (this.firstSourceMessage !== undefined &&
          (this.source?.messages.indexOf(this.firstSourceMessage) ?? -1) > 0)),
    );
  }

  /** Retain a reader through committed history or row-projection changes. */
  capture(
    element: HTMLDivElement | null,
    commanded: boolean,
    readingProjectionChanged = false,
  ): void {
    if (commanded) {
      this.pending = null;
    }
    if (!commanded && (this.hasPrepend || readingProjectionChanged)) {
      this.retainReader(element);
    }
    this.firstMessageKey = this.messageKeys.keys().next().value;
    this.firstSourceMessage = this.source?.messages[0];
  }

  /** Retain current geometry without admitting a candidate message projection. */
  retainReader(element: HTMLDivElement | null): boolean {
    // A second projection may commit before measurement settles. Keep the
    // original reader target rather than recapturing an already shifted bubble.
    const retained =
      this.pending && this.messageKeys.has(this.pending.messageKey) ? this.pending : null;
    const anchor =
      retained ??
      captureTranscriptPrependAnchor(element, this.messageKeys, this.messageElements.values());
    if (anchor) {
      this.pending = {
        ...anchor,
        measured: false,
        prepended: this.hasPrepend || retained?.prepended === true,
      };
      return true;
    }
    return false;
  }

  /** Prefix insertion must land before paint; warm replacement joins the native batch. */
  update(
    virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    rowsMeasured: () => boolean,
    committed = false,
  ): boolean {
    const anchor = this.pending;
    if (!anchor) {
      return false;
    }
    const ready = anchor.prepended || rowsMeasured();
    if (!ready && !committed) {
      return false;
    }
    const changed = anchor.prepended && this.measurePrependedRows();
    const moved = restoreTranscriptPrependAnchor(
      anchor,
      virtualizer.scrollElement,
      virtualizer,
      this.messageElements.values(),
      this.onLayoutCorrection,
    );
    // Committed geometry can move before all row receipts arrive; retain its target meanwhile.
    if (!ready) {
      return moved;
    }
    if (anchor.measured && !changed && !moved) {
      this.pending = null;
    }
    anchor.measured = true;
    return true;
  }

  readerMoved(nativeInput: boolean): void {
    if (nativeInput && this.searchProjection && !this.searchProjection.empty) {
      this.searchReturn = null;
    }
  }

  /** Carry the viewport target with native reader movement, not layout growth. */
  moveWithReader(delta: number): void {
    if (this.pending) {
      this.pending.top -= delta;
    }
  }

  /** Retire pending restoration when the reader or another command takes over. */
  clear(): void {
    this.searchPlacement = null;
    this.pending = null;
  }

  /** Drop projection identity when the owning session is disposed. */
  reset(): void {
    this.clear();
    this.searchReturn = null;
    this.searchProjection = null;
    this.firstMessageKey = undefined;
    this.firstSourceMessage = undefined;
    this.source = undefined;
    this.messageKeys = new Set();
    this.committedMessageRows = new Map();
  }
}

/** Capture a retained message before history or regrouping changes its row. */
function captureTranscriptPrependAnchor(
  scrollElement: HTMLDivElement | null,
  next: TranscriptMessageKeys,
  messageElements: Iterable<HTMLElement>,
): ChatTranscriptPrependAnchor | null {
  if (!scrollElement) {
    return null;
  }
  const viewport = scrollElement.getBoundingClientRect();
  // Only rendered, retained bubbles can anchor the reader; overscan above the
  // viewport and messages removed by the new projection are not candidates.
  // Prepended refs register after retained ones; choose by DOM order, not insertion order.
  const bubbles = [...messageElements]
    .filter(
      (bubble) =>
        scrollElement.contains(bubble) &&
        !bubble.closest('.chat-virtual-row[data-prepared-row="true"]'),
    )
    .toSorted((left, right) => {
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      return position & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
  for (const bubble of bubbles) {
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
function restoreTranscriptPrependAnchor(
  anchor: ChatTranscriptPrependAnchor,
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
  messageElements: Iterable<HTMLElement>,
  onLayoutCorrection: (before: number, after: number) => void,
): boolean {
  if (!scrollElement) {
    return false;
  }
  // Group renderers may replace the bubble at an array index during prepend;
  // resolve its stable render key in the committed DOM, not an old element.
  const bubble = [...messageElements].find(
    (element) => scrollElement.contains(element) && element.dataset.messageId === anchor.messageKey,
  );
  if (!bubble) {
    return false;
  }
  const delta = bubble.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) <= 1) {
    return false;
  }
  const maxOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  const before = scrollElement.scrollTop;
  const offset = Math.max(0, Math.min(maxOffset, before + delta));
  // A retained message can become unreachable at an edge when provisional rows retire.
  // Reissuing that clamped correction would keep the measurement loop alive forever.
  if (Math.abs(offset - before) <= 1) {
    return false;
  }
  // The scroll owner retires deferred row corrections represented by the DOM.
  // An ignored native write must not keep the measurement loop alive.
  virtualizer.scrollToOffset(offset, { behavior: "instant" });
  onLayoutCorrection(before, scrollElement.scrollTop);
  return scrollElement.scrollTop !== before;
}
