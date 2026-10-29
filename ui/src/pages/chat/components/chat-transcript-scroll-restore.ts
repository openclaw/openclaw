import type { Virtualizer } from "@tanstack/virtual-core";
import {
  captureChatSessionScrollPosition,
  CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  type ChatSessionScrollPosition,
} from "../scroll.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { TranscriptInitialRange } from "./chat-transcript-initial-range.ts";
import { captureTranscriptMessageAnchor } from "./chat-transcript-prepend-anchor.ts";
import {
  CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES,
  CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES,
  type ChatTranscriptPendingScrollOffset,
} from "./chat-transcript-session.ts";

export type TranscriptScrollRestoreHost = {
  readonly offsetState: { pendingScrollOffset: ChatTranscriptPendingScrollOffset | null };
  getScrollElement(): HTMLDivElement | null;
  isContentReady(): boolean;
  getRowCount(): number;
  getMessageElement(key: string): HTMLElement | undefined;
  readonly virtualizer: Pick<Virtualizer<HTMLDivElement, HTMLElement>, "scrollToOffset">;
  isConnected(): boolean;
  pendingScrollFrame: number | null;
  onReaderScroll(): void;
};

export function applyPendingScrollOffset(owner: TranscriptScrollRestoreHost): void {
  const pending = owner.offsetState.pendingScrollOffset;
  if (!pending || !owner.isConnected()) {
    return;
  }
  if (owner.isContentReady() && owner.getRowCount() === 0) {
    settlePendingScroll(owner, 0);
    return;
  }
  const element = owner.getScrollElement();
  if (pending.anchor && element) {
    const { messageKey, offset } = pending.anchor;
    const bubble = owner.getMessageElement(messageKey);
    if (bubble && element.contains(bubble)) {
      pending.offset = Math.max(
        0,
        element.scrollTop +
          bubble.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          offset,
      );
    } else if (!owner.isContentReady()) {
      return;
    } else {
      // A ready committed row may no longer expose the saved bubble (reset,
      // folded work, or bounded refill). Preserve the numeric fallback.
      pending.anchor = undefined;
    }
  }
  const maxOffset = maxTranscriptScrollOffset(element);
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
    ...(pending.anchor ? { anchor: pending.anchor } : {}),
    anchorToEnd:
      maxScrollTop === null
        ? owner.isContentReady() && owner.getRowCount() === 0
        : maxScrollTop - scrollTop <= CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  });
  // Publish the restored reader before queued hydration/resize follow runs.
  owner.onReaderScroll();
}

export function createTranscriptScrollRestoreHost(
  owner: Omit<TranscriptScrollRestoreHost, "pendingScrollFrame"> & {
    initialRange: Pick<TranscriptInitialRange, "pending" | "finish">;
    invalidate(): void;
  },
): TranscriptScrollRestoreHost {
  return {
    ...owner,
    pendingScrollFrame: null,
    onReaderScroll() {
      if (owner.initialRange.pending) {
        owner.initialRange.finish();
        owner.invalidate();
      }
      owner.onReaderScroll();
    },
  };
}

export function cancelPendingScrollRetry(owner: TranscriptScrollRestoreHost): void {
  if (owner.pendingScrollFrame !== null) {
    cancelAnimationFrame(owner.pendingScrollFrame);
    owner.pendingScrollFrame = null;
  }
}

export function captureTranscriptScrollPosition(
  element: HTMLDivElement | null,
  viewport: Parameters<typeof captureChatSessionScrollPosition>[0],
  messageElements: ReadonlyMap<string, HTMLElement>,
): ChatSessionScrollPosition {
  const position = captureChatSessionScrollPosition(viewport);
  if (!position.anchorToEnd && element) {
    const anchor = captureTranscriptMessageAnchor(
      element,
      messageElements,
      messageElements.values(),
    );
    if (anchor) {
      position.anchor = {
        messageKey: anchor.messageKey,
        offset: anchor.top - element.getBoundingClientRect().top,
      };
    }
  }
  return position;
}
