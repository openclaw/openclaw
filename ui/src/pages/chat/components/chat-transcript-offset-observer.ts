import { observeElementOffset, type Virtualizer } from "@tanstack/virtual-core";
import { isTranscriptScrollKey } from "../chat-scroll-input.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { ChatTranscriptInteractionAnchor } from "./chat-transcript-interaction-anchor.ts";
import type { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import {
  publishTranscriptScroll,
  type TranscriptScrollObservation,
} from "./chat-transcript-scroll-events.ts";
import type { ChatTranscriptPendingScrollOffset } from "./chat-transcript-session.ts";

type TranscriptOffsetState = {
  pendingScrollOffset: ChatTranscriptPendingScrollOffset | null;
  scrollCommand:
    | { behavior: ScrollBehavior; target: "end" | "index" }
    | { behavior: ScrollBehavior; target: "message"; messageId: string }
    | null;
  touching: boolean;
  touchScrolling: boolean;
  maintenanceScrollOffset: number | null;
  pendingInteractionAnchor: ChatTranscriptInteractionAnchor | null;
  syncNativeOffset: (() => void) | null;
  recordProgrammaticScroll: ((before: number, after: number) => void) | null;
};

/** Create the state shared by native input observation and transcript commands. */
export function createTranscriptOffsetState(): TranscriptOffsetState {
  return {
    pendingScrollOffset: null,
    scrollCommand: null,
    touching: false,
    touchScrolling: false,
    maintenanceScrollOffset: null,
    pendingInteractionAnchor: null,
    syncNativeOffset: null,
    recordProgrammaticScroll: null,
  };
}

type OffsetOwner = {
  state: TranscriptOffsetState;
  getScrollElement(): HTMLDivElement | null;
  readonly prependAnchor: TranscriptPrependAnchor;
  isProgrammaticScroll(): boolean;
  cancelScroll(): void;
  requestUpdate(): void;
  onReaderScroll(towardEnd?: boolean): void;
};

/** Observe native offsets and input with the transcript's touch and command lifecycle. */
export function observeTranscriptOffset(
  owner: OffsetOwner,
  instance: Virtualizer<HTMLDivElement, HTMLElement>,
  callback: (offset: number, scrolling: boolean) => void,
): () => void {
  const element = owner.getScrollElement();
  let nativeOffset = element?.scrollTop ?? 0;
  let touchY: number | undefined;
  const contactIds = new Set<number>();
  const localTouchY = (event: TouchEvent) =>
    Array.from(event.touches).find((touch) => contactIds.has(touch.identifier))?.clientY;
  const publish = (event: TranscriptScrollObservation) => {
    if (element) {
      publishTranscriptScroll(element, event);
    }
  };
  const publishInput = (event: Event) => {
    publish({ type: "input", event, touching: owner.state.touching });
  };
  const recordProgrammaticScroll = (before: number, after: number) => {
    const delta = before - nativeOffset;
    nativeOffset = after;
    publish({
      type: "offset",
      delta,
      scrolling: instance.isScrolling,
      touching: owner.state.touching,
      programmatic: owner.isProgrammaticScroll(),
    });
    // Commands own completion. Record maintenance movement after publishing preceding native input.
    if (owner.state.scrollCommand || owner.state.pendingScrollOffset) {
      owner.state.maintenanceScrollOffset = null;
    } else if (before !== after) {
      owner.state.maintenanceScrollOffset = after;
    }
  };
  owner.state.recordProgrammaticScroll = recordProgrammaticScroll;
  const publishOffset = (offset: number, scrolling: boolean) => {
    if (
      scrolling &&
      offset !== nativeOffset &&
      (owner.state.touching || owner.state.touchScrolling)
    ) {
      owner.state.touchScrolling = true;
      owner.prependAnchor.moveWithReader(offset - nativeOffset);
    }
    const delta = offset - nativeOffset;
    nativeOffset = offset;
    const programmatic = owner.isProgrammaticScroll();
    if (scrolling && owner.state.maintenanceScrollOffset !== null) {
      owner.state.maintenanceScrollOffset = programmatic ? offset : null;
    }
    publish({
      type: "offset",
      delta,
      scrolling,
      touching: owner.state.touching,
      programmatic,
    });
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
  const finishTouch = (event: TouchEvent) => {
    for (const touch of event.changedTouches) {
      contactIds.delete(touch.identifier);
    }
    owner.state.touching = contactIds.size > 0;
    if (owner.state.touching) {
      touchY = localTouchY(event);
      publishInput(event);
      return;
    }
    touchY = undefined;
    // Idle may have arrived while the finger was still down; no further
    // offset notification is guaranteed after releasing a stationary touch.
    if (!instance.isScrolling) {
      owner.state.touchScrolling = false;
    }
    publishInput(event);
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
    if (event.type === "touchstart" && event instanceof TouchEvent) {
      // Global touches include fingers on other panes. Only contacts that
      // began within this transcript can hold its pending history projection.
      for (const touch of event.changedTouches) {
        if (touch.target instanceof Node && element.contains(touch.target)) {
          contactIds.add(touch.identifier);
        }
      }
      owner.state.touching = contactIds.size > 0;
      touchY = localTouchY(event);
    }
    owner.state.pendingInteractionAnchor = null;
    owner.state.maintenanceScrollOffset = null;
    // Native scrolling may precede input delivery. Attribute the gesture before
    // cancellation or offset synchronization publishes that consumed movement.
    publishInput(event);
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
    const towardEnd =
      (event instanceof WheelEvent && event.deltaY > 0) ||
      (event instanceof KeyboardEvent &&
        (["ArrowDown", "PageDown", "End"].includes(event.key) ||
          (event.key === " " && !event.shiftKey)));
    owner.onReaderScroll(towardEnd);
  };
  const moveTouch = (event: TouchEvent) => {
    const nextY = localTouchY(event);
    // At a resize-clamped end there may be no offset event. Contact alone is
    // not a return; only a gesture moving toward the end can resume following.
    if (touchY !== undefined && nextY !== undefined && nextY < touchY) {
      owner.onReaderScroll(true);
    }
    touchY = nextY;
    publishInput(event);
  };
  element?.addEventListener("touchmove", moveTouch, { passive: true });
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
    if (owner.state.recordProgrammaticScroll === recordProgrammaticScroll) {
      owner.state.recordProgrammaticScroll = null;
      owner.state.maintenanceScrollOffset = null;
    }
    cleanup?.();
    contactIds.clear();
    owner.state.touching = false;
    owner.state.touchScrolling = false;
    element?.removeEventListener("scrollend", finishScroll);
    element?.removeEventListener("touchend", finishTouch);
    element?.removeEventListener("touchmove", moveTouch);
    element?.removeEventListener("touchcancel", finishTouch);
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
      element?.removeEventListener(type, interrupt);
    }
  };
}
