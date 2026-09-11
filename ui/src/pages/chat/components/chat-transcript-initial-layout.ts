import type { Virtualizer } from "@tanstack/virtual-core";
import type { ReactiveControllerHost } from "lit";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";

/** The measured initial range must commit before its cold presentation reveals. */
export class ChatTranscriptInitialLayout {
  private committed = false;
  private renderedGeometry = "[]";
  private implicitEndAnchorPending: boolean;

  constructor(
    private readonly options: {
      host: ReactiveControllerHost;
      virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
      scrollElement: () => HTMLDivElement | null;
      pending: () => boolean;
      initialOffset: number | null;
      onReady?: () => void;
    },
  ) {
    this.implicitEndAnchorPending = options.initialOffset === null;
  }

  get ready(): boolean {
    return this.committed;
  }

  cancelEndAnchor(): void {
    this.implicitEndAnchorPending = false;
  }

  rendered(): void {
    if (!this.committed) {
      this.renderedGeometry = this.geometry();
    }
  }

  private geometry(): string {
    // Only the bounded rendered range participates, never the full history.
    return JSON.stringify(
      this.options.virtualizer.getVirtualItems().map(({ key, start, size }) => [key, start, size]),
    );
  }

  update(): void {
    const { host, virtualizer, scrollElement, pending, onReady } = this.options;
    if (this.committed || pending()) {
      return;
    }
    this.reconcileImplicitEndAnchor();
    const commit = host.updateComplete;
    void commit.then((complete) => {
      const element = scrollElement();
      // Measurement can queue another Lit commit. Publish only the measured
      // range actually committed to this viewport, after initial anchoring.
      if (
        !complete ||
        commit !== host.updateComplete ||
        this.committed ||
        pending() ||
        !element ||
        !element.clientHeight ||
        this.implicitEndAnchorPending ||
        this.renderedGeometry !== this.geometry() ||
        virtualizer.getVirtualItems().some(({ key, size }) => {
          // The size cache stores corrections, so an exact estimate need not
          // have an entry. Compare the committed vertical border box instead.
          const row = virtualizer.elementsCache.get(key);
          return !row?.isConnected || row.offsetHeight !== size;
        })
      ) {
        return;
      }
      this.committed = true;
      onReady?.();
    });
  }

  private reconcileImplicitEndAnchor(): void {
    if (!this.implicitEndAnchorPending) {
      return;
    }
    const { host, virtualizer, scrollElement } = this.options;
    const maxOffset = maxTranscriptScrollOffset(scrollElement());
    const scrollOffset = virtualizer.scrollOffset;
    if (maxOffset === null || scrollOffset === null) {
      return;
    }
    if (scrollOffset >= 0 && scrollOffset <= maxOffset) {
      this.implicitEndAnchorPending = false;
      return;
    }
    if (maxOffset !== 0) {
      return;
    }
    this.implicitEndAnchorPending = false;
    // The DOM clamps an underfilled end anchor to zero without a scroll event,
    // so TanStack cannot reconcile its maximum-integer initial offset itself.
    virtualizer.scrollOffset = 0;
    virtualizer.scrollToOffset(0);
    host.requestUpdate();
  }
}
