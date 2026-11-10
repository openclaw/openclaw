import type { Virtualizer } from "@tanstack/virtual-core";
import type { ChatReadingBookmark, ChatScrollToEndOptions } from "../scroll.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../scroll.ts";
import type { ChatMessageReveal } from "./chat-message-reveal.ts";
import type { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import {
  isTranscriptRangeCommitted,
  maxTranscriptScrollOffset,
} from "./chat-transcript-geometry.ts";
import type { TranscriptInitialRange } from "./chat-transcript-initial-range.ts";
import type { ChatTranscriptRenderer } from "./chat-transcript-layout-solid.tsx";
import type { TranscriptMessageElements } from "./chat-transcript-message-elements.ts";
import type { TranscriptOffsetState } from "./chat-transcript-offset-observer.ts";
import type { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import {
  type TranscriptCallbacks,
  type createTranscriptPresentation,
  CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES,
  CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES,
  type ChatTranscriptPendingScrollOffset,
} from "./chat-transcript-session.ts";

export type TranscriptScrollRestoreHost = {
  readonly offsetState: { pendingScrollOffset: ChatTranscriptPendingScrollOffset | null };
  getScrollElement(): HTMLDivElement | null;
  isContentReady(): boolean;
  getRowCount(): number;
  readonly virtualizer: Pick<Virtualizer<HTMLDivElement, HTMLElement>, "scrollToOffset">;
  isConnected(): boolean;
  pendingScrollFrame: number | null;
  onReaderScroll(): void;
};

export function cancelPendingScrollRetry(
  owner: Pick<TranscriptScrollRestoreHost, "pendingScrollFrame">,
): void {
  if (owner.pendingScrollFrame !== null) {
    cancelAnimationFrame(owner.pendingScrollFrame);
    owner.pendingScrollFrame = null;
  }
}

type TranscriptScrollCancellationOwner = {
  readonly offsetState: TranscriptOffsetState;
  readonly bookmarkState: { bookmark?: ChatReadingBookmark };
  readonly virtualizer: Pick<
    Virtualizer<HTMLDivElement, HTMLElement>,
    "cancelScroll" | "scrollToOffset"
  >;
  readonly initialRange: Pick<TranscriptInitialRange, "finishEnd" | "finishEndWhenSettled">;
  readonly endAnchor: Pick<TranscriptEndAnchor, "capture" | "clear">;
  readonly prependAnchor: Pick<TranscriptPrependAnchor, "clear">;
  readonly scrollRestoreHost: Pick<TranscriptScrollRestoreHost, "pendingScrollFrame">;
  getScrollElement(): HTMLDivElement | null;
  getLifecycle(): unknown;
  measureRowsWithoutScrollAdjustment(): void;
};

export function cancelTranscriptScroll(
  owner: TranscriptScrollCancellationOwner,
  preserveEnd = false,
): void {
  const command = owner.offsetState.scrollCommand;
  const pendingOffset = owner.offsetState.pendingScrollOffset;
  const unissuedEnd = command?.target === "end" && command.offset === undefined && !pendingOffset;
  const element = owner.getScrollElement();
  const lifecycle = owner.getLifecycle();
  owner.bookmarkState.bookmark = undefined;
  // Retire the old owner before range work can refresh and admit another command.
  owner.offsetState.scrollCommand = null;
  owner.offsetState.pendingScrollOffset = null;
  cancelPendingScrollRetry(owner.scrollRestoreHost);
  // Completing a smooth journey can reveal skipped row sizes. Retain its
  // resting edge before that measurement moves the end; reader input clears it.
  if (preserveEnd) {
    owner.endAnchor.capture(element);
  } else {
    owner.endAnchor.clear();
  }
  owner.prependAnchor.clear();
  if (!preserveEnd || unissuedEnd) {
    // Retire the vendor target before range work can admit a replacement.
    // Unissued preparation must not manufacture a native offset target.
    owner.virtualizer.cancelScroll();
  }
  if (preserveEnd) {
    owner.initialRange.finishEndWhenSettled();
  } else {
    owner.initialRange.finishEnd();
  }
  if (
    unissuedEnd ||
    (!command && !pendingOffset) ||
    owner.offsetState.hasPendingCommand ||
    element !== owner.getScrollElement() ||
    lifecycle !== owner.getLifecycle()
  ) {
    return;
  }
  // An issued smooth journey keeps its established measurement/instant-stop order.
  if (command?.behavior === "smooth") {
    owner.measureRowsWithoutScrollAdjustment();
  }
  if (
    element &&
    !owner.offsetState.hasPendingCommand &&
    element === owner.getScrollElement() &&
    lifecycle === owner.getLifecycle()
  ) {
    // The measured end owner renews later; a dynamic destination would also
    // follow new rows before end preparation admits their native geometry.
    owner.virtualizer.scrollToOffset(element.scrollTop, { behavior: "instant" });
  }
}

export function applyPendingScrollOffset(owner: TranscriptScrollRestoreHost): void {
  const pending = owner.offsetState.pendingScrollOffset;
  if (!pending || !owner.isConnected()) {
    return;
  }
  if (owner.isContentReady() && owner.getRowCount() === 0) {
    settlePendingScroll(owner, 0);
    return;
  }
  const maxOffset = maxTranscriptScrollOffset(owner.getScrollElement());
  if (maxOffset === null || (maxOffset === 0 && pending.offset > 0)) {
    pending.observedMaxOffset = undefined;
    pending.stableFrames = 0;
    if (maxOffset === null) {
      pending.zeroMaxFrames = 0;
    } else if (owner.isContentReady()) {
      if (pending.zeroMaxFrames >= CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES) {
        settlePendingScroll(owner, 0);
      } else {
        schedulePendingScrollRetry(owner);
      }
    }
    return;
  }
  pending.zeroMaxFrames = 0;
  if (maxOffset < pending.offset) {
    if (pending.observedMaxOffset !== maxOffset) {
      pending.observedMaxOffset = maxOffset;
      pending.stableFrames = 0;
    }
    if (pending.stableFrames <= CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES) {
      schedulePendingScrollRetry(owner);
      return;
    }
  }
  const targetOffset = Math.min(pending.offset, maxOffset);
  const element = owner.getScrollElement();
  if (element) {
    element.scrollTop = targetOffset;
  }
  owner.virtualizer.scrollToOffset(targetOffset);
  const currentOffset = owner.getScrollElement()?.scrollTop;
  if (currentOffset != null) {
    settlePendingScroll(owner, currentOffset);
  } else {
    schedulePendingScrollRetry(owner);
  }
}

function schedulePendingScrollRetry(owner: TranscriptScrollRestoreHost): void {
  if (!owner.isConnected() || owner.pendingScrollFrame !== null) {
    return;
  }
  owner.pendingScrollFrame = requestAnimationFrame(() => {
    owner.pendingScrollFrame = null;
    const pending = owner.offsetState.pendingScrollOffset;
    if (owner.isConnected() && pending) {
      const maxOffset = maxTranscriptScrollOffset(owner.getScrollElement());
      if (maxOffset === 0 && pending.offset > 0 && owner.isContentReady()) {
        pending.zeroMaxFrames += 1;
      } else if (
        maxOffset !== null &&
        maxOffset > 0 &&
        maxOffset < pending.offset &&
        maxOffset === pending.observedMaxOffset
      ) {
        pending.stableFrames += 1;
      }
      // Geometry notifications and settled reader policy own their renders.
      applyPendingScrollOffset(owner);
    }
  });
}

function settlePendingScroll(owner: TranscriptScrollRestoreHost, scrollTop: number): void {
  const pending = owner.offsetState.pendingScrollOffset;
  owner.offsetState.pendingScrollOffset = null;
  if (!pending) {
    return;
  }
  const maxScrollTop = maxTranscriptScrollOffset(owner.getScrollElement());
  pending.onSettled?.({
    scrollTop,
    anchorToEnd:
      maxScrollTop === null
        ? owner.isContentReady() && owner.getRowCount() === 0
        : maxScrollTop - scrollTop <= CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  });
  // Publish the restored reader before queued hydration/resize follow runs.
  owner.onReaderScroll();
}

type TranscriptLayoutRestoreHost = {
  bookmarkState: { bookmark?: ChatReadingBookmark; pending: boolean };
  isConnected(): boolean;
  scrollElement: HTMLDivElement | null;
  threadInnerElement: HTMLDivElement | null;
  rowCount: number;
  callbacks: TranscriptCallbacks;
  prependAnchor: TranscriptPrependAnchor;
  rowIndexesByKey: ReadonlyMap<string, number>;
  offsetState: TranscriptOffsetState;
  initialRange: TranscriptInitialRange;
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>;
  messageReveal: ChatMessageReveal;
  messageRowKeysById: ReadonlyMap<string, string>;
  presentation: ReturnType<typeof createTranscriptPresentation>;
  messageElements: TranscriptMessageElements;
  renderer: ChatTranscriptRenderer;
  scrollRestoreHost: TranscriptScrollRestoreHost;
  canAutoFollow(): boolean;
  scrollToEnd(options: ChatScrollToEndOptions): boolean;
  invalidate(): void;
};

/** One restoration flow owns saved semantic and measured initial positioning. */
export function completeTranscriptLayout(owner: TranscriptLayoutRestoreHost): void {
  if (!owner.isConnected() || owner.virtualizer.scrollElement !== owner.scrollElement) {
    return;
  }
  // A recorded manual command owns the next frame; an older bookmark must not
  // reclaim the reader and cancel that command while its history read settles.
  if (owner.callbacks.hasPendingScrollCommand?.()) {
    owner.bookmarkState.bookmark = undefined;
    owner.bookmarkState.pending = false;
    owner.offsetState.pendingScrollOffset = null;
  }
  const bookmark = owner.bookmarkState.bookmark;
  if (bookmark) {
    const sessionId = owner.callbacks.getSessionId?.();
    if (!sessionId) {
      return;
    }
    if (sessionId !== bookmark.sessionId) {
      owner.bookmarkState.bookmark = undefined;
      owner.offsetState.pendingScrollOffset = null;
    } else {
      const rowKey = owner.prependAnchor.committedMessageRows.get(bookmark.messageKey);
      const index = rowKey ? owner.rowIndexesByKey.get(rowKey) : undefined;
      if (index !== undefined && owner.scrollElement) {
        // Reuse the measured prepend owner after a remount; cached pixels
        // alone cannot identify a reader in a different resident window.
        owner.offsetState.pendingScrollOffset = null;
        owner.initialRange.finish();
        owner.prependAnchor.restoreBookmark(bookmark, owner.scrollElement);
        owner.virtualizer.scrollToIndex(index, { align: "start", behavior: "instant" });
        // A saved reader owns follow policy even while the initial range is clamped.
        owner.callbacks.onReaderScroll?.(false, "bookmark");
        owner.bookmarkState.bookmark = undefined;
        owner.invalidate();
      } else if (!owner.bookmarkState.pending && owner.callbacks.canRestoreBookmark?.() !== false) {
        owner.bookmarkState.pending = true;
        void (
          owner.callbacks.restoreBookmark?.(
            bookmark,
            () =>
              owner.bookmarkState.bookmark === bookmark &&
              !owner.callbacks.hasPendingScrollCommand?.(),
          ) ?? Promise.resolve(false)
        ).then((restored) => {
          if (owner.bookmarkState.bookmark === bookmark) {
            owner.bookmarkState.pending = false;
            if (restored === false) {
              owner.bookmarkState.bookmark = undefined;
            }
            if (owner.isConnected() && owner.callbacks.canRestoreBookmark?.() !== false) {
              owner.invalidate();
            }
          }
        });
      }
      return;
    }
  }
  owner.messageReveal.complete(
    owner.threadInnerElement,
    owner.offsetState,
    owner.virtualizer,
    owner.messageRowKeysById,
    owner.rowIndexesByKey,
  );
  if (!owner.initialRange.pending || !owner.rowCount || !owner.scrollElement?.clientHeight) {
    return;
  }
  const [measured, applyRail] = owner.presentation.measureInitialRows(owner.messageElements);
  if ((owner.initialRange.pending && owner.initialRange.extend(owner.scrollElement)) || measured) {
    owner.invalidate();
    return;
  }
  if (owner.offsetState.pendingScrollOffset) {
    applyPendingScrollOffset(owner.scrollRestoreHost);
    return;
  }
  if (
    owner.canAutoFollow() &&
    !(owner.offsetState.pendingInteractionAnchor || owner.offsetState.touchActive)
  ) {
    const behavior = owner.offsetState.scrollCommand?.behavior ?? "instant";
    owner.scrollToEnd({ source: "auto", behavior });
    owner.offsetState.syncNativeOffset?.();
  }
  if (isTranscriptRangeCommitted(owner.threadInnerElement, owner.virtualizer)) {
    applyRail?.();
    owner.initialRange.complete();
    owner.renderer.syncInitialPosition();
  }
  owner.invalidate();
}

export function canFollowTranscriptEnd(
  bookmarkState: { bookmark?: ChatReadingBookmark },
  offsetState: Pick<TranscriptOffsetState, "scrollCommand">,
  callbacks: Pick<TranscriptCallbacks, "canFollowEnd">,
): boolean {
  const command = offsetState.scrollCommand;
  return (
    !bookmarkState.bookmark &&
    (!command || command.target === "end") &&
    (callbacks.canFollowEnd?.() ?? true)
  );
}
