import type { Virtualizer } from "@tanstack/virtual-core";

type ChatTranscriptPrependAnchor = { messageKey: string; rowKey: string | null; top: number };

/** Own the message anchor across projection capture, measurement, and restoration. */
export class TranscriptPrependAnchor {
  messageKeys: ReadonlySet<string> = new Set();
  private firstMessageKey: string | undefined;
  private pending: (ChatTranscriptPrependAnchor & { measured: boolean }) | null = null;

  /** Stable message identity used to resolve its row in the committed projection. */
  get messageKey(): string | null {
    return this.pending?.messageKey ?? null;
  }

  /** Keep the retained row mounted while virtual and native offsets reconcile. */
  get rowKey(): string | null {
    return this.pending?.rowKey ?? null;
  }

  /** Whether the next projection inserts history before the committed first message. */
  get hasPrepend(): boolean {
    return Boolean(
      this.firstMessageKey &&
      this.firstMessageKey !== this.messageKeys.keys().next().value &&
      this.messageKeys.has(this.firstMessageKey),
    );
  }

  /** Capture only a committed prepend that is not superseded by a scroll command. */
  capture(element: HTMLDivElement | null, commanded: boolean): void {
    const anchor = commanded
      ? null
      : captureTranscriptPrependAnchor(element, this.firstMessageKey, this.messageKeys);
    if (anchor) {
      this.pending = { ...anchor, measured: false };
    }
    this.firstMessageKey = this.messageKeys.keys().next().value;
  }

  /** Measure estimated rows before restoring the retained message on the next commit. */
  update(
    element: HTMLDivElement | null,
    virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    measureRows: () => void,
  ): boolean {
    const anchor = this.pending;
    if (!anchor) {
      return false;
    }
    if (!anchor.measured) {
      measureRows();
      anchor.measured = true;
      return true;
    }
    this.pending = null;
    return restoreTranscriptPrependAnchor(anchor, element, virtualizer);
  }

  /** Carry the viewport target with native reader movement, not layout growth. */
  moveWithReader(delta: number): void {
    if (this.pending) {
      this.pending.top -= delta;
    }
  }

  /** Retire pending restoration when the reader or another command takes over. */
  clear(): void {
    this.pending = null;
  }

  /** Drop projection identity when the owning session is disposed. */
  reset(): void {
    this.clear();
    this.firstMessageKey = undefined;
    this.messageKeys = new Set();
  }
}

/** Capture the message being read before older history changes its containing row. */
function captureTranscriptPrependAnchor(
  scrollElement: HTMLDivElement | null,
  previousFirstMessageKey: string | undefined,
  next: ReadonlySet<string>,
): ChatTranscriptPrependAnchor | null {
  const first = previousFirstMessageKey;
  if (!scrollElement || !first || first === next.keys().next().value || !next.has(first)) {
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
function restoreTranscriptPrependAnchor(
  anchor: ChatTranscriptPrependAnchor | null,
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): boolean {
  if (!anchor || !scrollElement) {
    return false;
  }
  // Group renderers may replace the bubble at an array index during prepend;
  // resolve its stable render key in the committed DOM, not an old element.
  const bubble = [
    ...scrollElement.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
  ].find((element) => element.dataset.messageId === anchor.messageKey);
  if (!bubble) {
    return false;
  }
  const delta = bubble.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) <= 1) {
    return false;
  }
  const offset = Math.max(0, scrollElement.scrollTop + delta);
  // Commit one measured message target through the scroll owner. This also
  // retires deferred row corrections already represented by the measured DOM.
  virtualizer.scrollToOffset(offset, { behavior: "instant" });
  return true;
}
