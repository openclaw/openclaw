import { elementScroll, observeElementOffset, type Virtualizer } from "@tanstack/virtual-core";
import { isTranscriptScrollKey } from "../chat-scroll-input.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX, type ChatScrollToEndOptions } from "../scroll.ts";
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
    | { behavior: ScrollBehavior; target: "end"; source: "auto" | "manual" }
    | { behavior: ScrollBehavior; target: "index" }
    | { behavior: ScrollBehavior; target: "message"; messageId: string }
    | null;
  touching: boolean;
  touchScrolling: boolean;
  maintenanceScrollOffset: number | null;
  pendingInteractionAnchor: ChatTranscriptInteractionAnchor | null;
  syncNativeOffset: (() => void) | null;
  recordProgrammaticScroll: ((before: number, after: number, maintenance: boolean) => void) | null;
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

export function isTranscriptMaintenanceScroll(
  state: TranscriptOffsetState,
  element: HTMLDivElement | null,
): boolean {
  return (
    element !== null &&
    state.maintenanceScrollOffset !== null &&
    Math.min(state.maintenanceScrollOffset, maxTranscriptScrollOffset(element) ?? 0) ===
      element.scrollTop
  );
}

export function isTranscriptProgrammaticScroll(
  state: TranscriptOffsetState,
  element: HTMLDivElement | null,
): boolean {
  // Lit’s listener can precede the offset observer. Read the committed viewport
  // so the final event publishes settled follow policy.
  const distanceFromEnd = (maxTranscriptScrollOffset(element) ?? 0) - (element?.scrollTop ?? 0);
  return (
    isTranscriptMaintenanceScroll(state, element) ||
    state.pendingScrollOffset !== null ||
    (state.scrollCommand !== null && distanceFromEnd > CHAT_TRANSCRIPT_END_THRESHOLD_PX)
  );
}

export function isTranscriptManualScroll(
  state: TranscriptOffsetState,
  element: HTMLDivElement | null,
): boolean {
  const command = state.scrollCommand;
  if (!command || (command.target === "end" && command.source !== "manual")) {
    return false;
  }
  // Native idle can lag a completed journey or never fire for a no-op.
  return (
    command.target !== "end" ||
    Math.abs((maxTranscriptScrollOffset(element) ?? 0) - (element?.scrollTop ?? 0)) > 1
  );
}

export function scrollTranscriptToEnd(
  state: TranscriptOffsetState,
  instance: Virtualizer<HTMLDivElement, HTMLElement>,
  { source, behavior }: Required<ChatScrollToEndOptions>,
  cancelScroll: () => void,
): void {
  // Retargeting automatic follow must not insert an instant stop or lose manual ownership.
  if (source !== "auto" || state.scrollCommand?.target !== "end") {
    cancelScroll();
  }
  const current = state.scrollCommand;
  state.scrollCommand = {
    behavior,
    target: "end",
    source: source === "auto" && current?.target === "end" ? current.source : source,
  };
  instance.scrollToEnd({ behavior });
}

export function scrollTranscriptOffset(
  state: TranscriptOffsetState,
  offset: number,
  options: Parameters<typeof elementScroll>[1],
  instance: Virtualizer<HTMLDivElement, HTMLElement>,
): void {
  const element = instance.scrollElement;
  const before = element?.scrollTop ?? 0;
  elementScroll(offset, options, instance);
  // TanStack omits behavior for measurement, anchor sync, and compensation retries.
  // Explicit commands carry their resolved behavior.
  state.recordProgrammaticScroll?.(before, element?.scrollTop ?? 0, options.behavior === undefined);
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
  const recordProgrammaticScroll = (before: number, after: number, maintenance: boolean) => {
    const delta = before - nativeOffset;
    nativeOffset = after;
    publish({
      type: "offset",
      delta,
      scrolling: instance.isScrolling,
      touching: owner.state.touching,
      programmatic: owner.isProgrammaticScroll(),
    });
    // Measurement and clamped retries can run during an outstanding end command.
    // Keep their provenance after publishing any preceding native input.
    if (!maintenance && (owner.state.scrollCommand || owner.state.pendingScrollOffset)) {
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
    }
    const delta = offset - nativeOffset;
    nativeOffset = offset;
    if (owner.state.maintenanceScrollOffset !== null) {
      const target = Math.min(
        owner.state.maintenanceScrollOffset,
        maxTranscriptScrollOffset(element) ?? 0,
      );
      const actualOffset = element?.scrollTop;
      owner.state.maintenanceScrollOffset = actualOffset === target ? actualOffset : null;
    }
    const programmatic = owner.isProgrammaticScroll();
    // Input can precede a projection capture while its native movement arrives
    // afterward. Carry that movement for wheel/keys as well as touch.
    if (scrolling && delta !== 0 && !programmatic) {
      owner.prependAnchor.moveWithReader(delta);
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
    if (settledAtEnd && element && owner.state.scrollCommand?.target === "end") {
      if (owner.state.scrollCommand.behavior === "smooth") {
        owner.cancelScroll();
      } else {
        owner.state.scrollCommand = null;
        // Native idle can precede the queued reconciliation frame. Retire its
        // index target too, without cancelling the reader’s end-follow intent.
        // The idle notification can lag a newer native write; hold the current viewport.
        instance.scrollToOffset(element.scrollTop, { behavior: "instant" });
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
