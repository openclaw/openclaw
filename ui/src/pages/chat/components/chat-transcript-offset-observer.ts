import { observeElementOffset, type Virtualizer } from "@tanstack/virtual-core";
import { isTranscriptScrollKey } from "../chat-scroll-input.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { ChatTranscriptInteractionAnchor } from "./chat-transcript-interaction-anchor.ts";
import type { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import type { ChatTranscriptPendingScrollOffset } from "./chat-transcript-session.ts";

type TranscriptOffsetState = {
  pendingScrollOffset: ChatTranscriptPendingScrollOffset | null;
  scrollCommand:
    | { behavior: ScrollBehavior; target: "end" | "index" }
    | { behavior: ScrollBehavior; target: "message"; messageId: string }
    | null;
  touching: boolean;
  touchScrolling: boolean;
  pendingInteractionAnchor: ChatTranscriptInteractionAnchor | null;
  syncNativeOffset: (() => void) | null;
};

/** Create the state shared by native input observation and transcript commands. */
export function createTranscriptOffsetState(): TranscriptOffsetState {
  return {
    pendingScrollOffset: null,
    scrollCommand: null,
    touching: false,
    touchScrolling: false,
    pendingInteractionAnchor: null,
    syncNativeOffset: null,
  };
}

type OffsetOwner = {
  state: TranscriptOffsetState;
  getScrollElement(): HTMLDivElement | null;
  readonly prependAnchor: TranscriptPrependAnchor;
  cancelScroll(): void;
  requestUpdate(): void;
  onReaderScroll(): void;
};

/** Observe native offsets and input with the transcript's touch and command lifecycle. */
export function observeTranscriptOffset(
  owner: OffsetOwner,
  instance: Virtualizer<HTMLDivElement, HTMLElement>,
  callback: (offset: number, scrolling: boolean) => void,
): () => void {
  const element = owner.getScrollElement();
  let nativeOffset = element?.scrollTop ?? 0;
  const publishOffset = (offset: number, scrolling: boolean) => {
    if (
      scrolling &&
      offset !== nativeOffset &&
      (owner.state.touching || owner.state.touchScrolling)
    ) {
      owner.state.touchScrolling = true;
      owner.prependAnchor.moveWithReader(offset - nativeOffset);
    }
    nativeOffset = offset;
    const changed = offset !== instance.scrollOffset;
    callback(offset, scrolling);
    // Range notifications are memoized: the viewport midpoint can cross
    // a rail landmark without changing the visible rows. Lit coalesces
    // this request with the virtualizer's own update when both fire.
    if (changed) {
      owner.requestUpdate();
    }
  };
  const syncOffset = () => {
    if (!element || element !== owner.getScrollElement() || instance.scrollElement !== element) {
      return;
    }
    const offset = element.scrollTop;
    if (offset !== instance.scrollOffset) {
      publishOffset(offset, instance.isScrolling);
    }
  };
  owner.state.syncNativeOffset = syncOffset;
  const finishTouch = () => {
    owner.state.touching = false;
    // Idle may have arrived while the finger was still down; no further
    // offset notification is guaranteed after releasing a stationary touch.
    if (!instance.isScrolling) {
      owner.state.touchScrolling = false;
    }
    owner.requestUpdate();
  };
  const finishScroll = () => {
    if (!owner.state.touching) {
      owner.state.touchScrolling = false;
      owner.requestUpdate();
    }
  };
  const interrupt = (event: Event) => {
    if (!element || element !== owner.getScrollElement() || instance.scrollElement !== element) {
      return;
    }
    if (event instanceof KeyboardEvent && !isTranscriptScrollKey(event)) {
      return;
    }
    if (event instanceof PointerEvent && event.target !== element) {
      return;
    }
    if (event.type === "touchstart") {
      owner.state.touching = true;
    }
    owner.state.pendingInteractionAnchor = null;
    // Contact alone does not supersede a captured message. Actual native
    // movement carries its viewport target through the gesture below.
    if (
      event.type !== "touchstart" ||
      owner.state.scrollCommand ||
      owner.state.pendingScrollOffset
    ) {
      owner.cancelScroll();
    }
    syncOffset();
    owner.onReaderScroll();
  };
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
    element?.addEventListener(type, interrupt, { passive: true });
  }
  element?.addEventListener("scrollend", finishScroll, { passive: true });
  element?.addEventListener("touchend", finishTouch, { passive: true });
  element?.addEventListener("touchcancel", finishTouch, { passive: true });
  const cleanup = observeElementOffset(instance, (offset, scrolling) => {
    if (element !== owner.getScrollElement()) {
      return;
    }
    publishOffset(offset, scrolling);
    // The offset observer already owns idle detection on browsers without
    // scrollend. Release touch-held history through that same lifecycle.
    if (!scrolling) {
      finishScroll();
    }
    if (!scrolling && owner.prependAnchor.hasPrepend) {
      owner.requestUpdate();
    }
    // Idle can arrive between smooth retargets. Completion needs the
    // restore path's 1px precision, not the 8px UI-follow boundary.
    // The input listeners above own reader takeover.
    const settledAtEnd =
      !scrolling &&
      Math.abs((maxTranscriptScrollOffset(element) ?? 0) - (element?.scrollTop ?? 0)) <= 1;
    // End-idle cannot retire a message reveal still waiting for its DOM commit.
    if (settledAtEnd && owner.state.scrollCommand?.target === "end") {
      if (owner.state.scrollCommand.behavior === "smooth") {
        owner.cancelScroll();
      } else {
        owner.state.scrollCommand = null;
      }
    }
  });
  return () => {
    if (owner.state.syncNativeOffset === syncOffset) {
      owner.state.syncNativeOffset = null;
    }
    cleanup?.();
    owner.state.touching = false;
    owner.state.touchScrolling = false;
    element?.removeEventListener("scrollend", finishScroll);
    element?.removeEventListener("touchend", finishTouch);
    element?.removeEventListener("touchcancel", finishTouch);
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
      element?.removeEventListener(type, interrupt);
    }
  };
}
