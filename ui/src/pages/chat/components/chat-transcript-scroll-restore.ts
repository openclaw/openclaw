import type { Virtualizer } from "@tanstack/virtual-core";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../scroll.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
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
  readonly virtualizer: Pick<Virtualizer<HTMLDivElement, HTMLElement>, "scrollToOffset">;
  isConnected(): boolean;
  getPendingScrollFrame(): number | null;
  setPendingScrollFrame(frame: number | null): void;
  requestUpdate(): void;
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
  const maxOffset = maxTranscriptScrollOffset(owner.getScrollElement());
  if (maxOffset === null) {
    pending.observedMaxOffset = undefined;
    pending.stableFrames = 0;
    pending.zeroMaxFrames = 0;
    return;
  }
  if (maxOffset === 0 && pending.offset > 0) {
    pending.observedMaxOffset = undefined;
    pending.stableFrames = 0;
    if (owner.isContentReady()) {
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
  if (!owner.isConnected() || owner.getPendingScrollFrame() !== null) {
    return;
  }
  owner.setPendingScrollFrame(
    requestAnimationFrame(() => {
      owner.setPendingScrollFrame(null);
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
        owner.requestUpdate();
      }
    }),
  );
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
