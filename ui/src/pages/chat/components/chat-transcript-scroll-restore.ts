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
    return;
  }
  if (maxOffset === 0 && pending.offset > 0) {
    if (owner.isContentReady()) {
      if (++pending.zeroMaxFrames > CHAT_TRANSCRIPT_ZERO_MAX_SETTLE_FRAMES) {
        settlePendingScroll(owner, 0);
      } else {
        schedulePendingScrollRetry(owner);
      }
    }
    return;
  }
  pending.zeroMaxFrames = 0;
  const targetOffset = Math.min(pending.offset, maxOffset);
  const element = owner.getScrollElement();
  if (element) {
    element.scrollTop = targetOffset;
  }
  owner.virtualizer.scrollToOffset(targetOffset);
  const currentOffset = owner.getScrollElement()?.scrollTop;
  const atTarget = currentOffset != null && Math.abs(currentOffset - targetOffset) <= 1;
  pending.stableFrames = atTarget ? pending.stableFrames + 1 : 0;
  if (
    currentOffset != null &&
    pending.stableFrames > CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES
  ) {
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
      if (owner.isConnected() && owner.offsetState.pendingScrollOffset) {
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
