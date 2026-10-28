import { elementScroll, observeElementOffset, type Virtualizer } from "@tanstack/virtual-core";
import { listen } from "../../../lib/reactive/listener.ts";
import { isTranscriptScrollKey } from "../chat-scroll-input.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX, type ChatScrollToEndOptions } from "../scroll.ts";
import type { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import type { ChatTranscriptInteractionAnchor } from "./chat-transcript-interaction-anchor.ts";
import type { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import type { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import {
  publishTranscriptScroll,
  subscribeTranscriptScroll,
  type TranscriptScrollObservation,
} from "./chat-transcript-scroll-events.ts";
import type { ChatTranscriptPendingScrollOffset } from "./chat-transcript-session.ts";

/** State shared by native input observation and transcript commands. */
export class TranscriptOffsetState {
  pendingScrollOffset: ChatTranscriptPendingScrollOffset | null = null;
  scrollCommand:
    | { behavior: ScrollBehavior; target: "end"; offset?: number }
    | { behavior: ScrollBehavior; target: "index" }
    | { behavior: ScrollBehavior; target: "message"; messageId: string }
    | null = null;
  touching = false;
  touchScrolling = false;
  renderedTouchActive = false;
  maintenanceScrollOffset: number | null = null;
  pendingInteractionAnchor: ChatTranscriptInteractionAnchor | null = null;
  syncNativeOffset: (() => void) | null = null;
  recordProgrammaticScroll: ((before: number, after: number, maintenance: boolean) => void) | null =
    null;

  get touchActive(): boolean {
    return this.touching || this.touchScrolling;
  }
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
  return (
    state.pendingScrollOffset !== null ||
    isTranscriptMaintenanceScroll(state, element) ||
    (state.scrollCommand !== null &&
      (maxTranscriptScrollOffset(element) ?? 0) - (element?.scrollTop ?? 0) >
        CHAT_TRANSCRIPT_END_THRESHOLD_PX)
  );
}

export function scrollTranscriptToEnd(
  state: TranscriptOffsetState,
  instance: Virtualizer<HTMLDivElement, HTMLElement>,
  { source, behavior }: Required<ChatScrollToEndOptions>,
  cancelScroll: () => void,
  measureSkippedRows: () => void,
): void {
  // Retargeting automatic follow must not insert an instant stop.
  if (source !== "auto" || state.scrollCommand?.target !== "end") {
    cancelScroll();
  } else if (state.scrollCommand.behavior === "smooth" && behavior !== "smooth") {
    // Retargeting bypasses cancellation, which normally replays the row sizes
    // TanStack suppressed outside the outgoing smooth command’s target buffer.
    measureSkippedRows();
  }
  state.scrollCommand = {
    behavior,
    target: "end",
  };
  instance.scrollToEnd({ behavior });
  // Instant commands and smooth no-ops can reach their target before any
  // native offset event. Do not let delayed idle reclaim a departed reader.
  const element = instance.scrollElement;
  const max = maxTranscriptScrollOffset(element);
  if (element && max !== null && Math.abs(max - element.scrollTop) <= 1) {
    cancelScroll();
  }
}

export function scrollTranscriptOffset(
  state: TranscriptOffsetState,
  host: { layout: TranscriptLayoutOwner; contentElement: HTMLElement | null },
  headerHeight: number,
  offset: number,
  options: Parameters<typeof elementScroll>[1],
  instance: Virtualizer<HTMLDivElement, HTMLElement>,
): void {
  if (options.behavior === undefined && host.contentElement) {
    // Resize compensation must not clamp against the previous native extent.
    host.layout.commitRange(host.contentElement, instance.getTotalSize() + headerHeight);
  }
  const element = instance.scrollElement;
  const before = element?.scrollTop ?? 0;
  const command = state.scrollCommand;
  // An ACK can remove wrapped delivery metadata during a smooth send. Keep a
  // shrinking endpoint smooth instead of taking virtual-core's instant final approach.
  const shrinkingSmoothEnd =
    command?.target === "end" &&
    command.behavior === "smooth" &&
    options.behavior === "auto" &&
    command.offset !== undefined &&
    offset < command.offset &&
    offset > before;
  if (command?.target === "end" && options.behavior !== undefined) {
    command.offset = offset;
  }
  elementScroll(
    offset,
    shrinkingSmoothEnd ? { ...options, behavior: "smooth" } : options,
    instance,
  );
  // TanStack omits behavior for measurement, anchor sync, and compensation retries.
  // Explicit commands carry their resolved behavior.
  state.recordProgrammaticScroll?.(before, element?.scrollTop ?? 0, options.behavior === undefined);
}

type OffsetOwner = {
  state: TranscriptOffsetState;
  getScrollElement(): HTMLDivElement | null;
  readonly prependAnchor: TranscriptPrependAnchor;
  readonly endAnchor: TranscriptEndAnchor;
  canFollowEnd(): boolean;
  isProgrammaticScroll(): boolean;
  cancelScroll(): void;
  onLayoutCorrection(before: number, after: number): void;
  invalidate(): void;
  onOffset(readerMoved: boolean): void;
  onReaderScroll(towardEnd?: boolean): void;
  onComposerLayout(changed: boolean): void;
};

/** Observe native offsets and input with the transcript's touch and command lifecycle. */
export function observeTranscriptOffset(
  owner: OffsetOwner,
  instance: Virtualizer<HTMLDivElement, HTMLElement>,
  callback: (offset: number, scrolling: boolean) => void,
): () => void {
  const element = owner.getScrollElement();
  let nativeOffset = element?.scrollTop ?? 0;
  let maintenanceRevision = 0;
  let maintenanceFrame: number | null = null;
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
    // Commands can move upward as rows retire. Keep the actual write's
    // provenance until its native event arrives, even after command retirement.
    if (before !== after) {
      owner.state.maintenanceScrollOffset = after;
      maintenanceRevision += 1;
    }
  };
  const recordVirtualizerScroll = (before: number, after: number, maintenance: boolean) => {
    // Measurement retries can move the old end after the grown range commits.
    // Layout/composer receipts already carry their anchor correction separately.
    if (maintenance && before !== after) {
      owner.onLayoutCorrection(before, after);
    }
    recordProgrammaticScroll(before, after);
  };
  owner.state.recordProgrammaticScroll = recordVirtualizerScroll;
  const stopCorrections = element
    ? subscribeTranscriptScroll(element, (observation) => {
        if (observation.type === "composer-input") {
          owner.endAnchor.invalidateComposerResize(owner.canFollowEnd());
        } else if (observation.type === "composer-layout") {
          owner.onComposerLayout(observation.changed);
        } else if (observation.type === "before-resize") {
          owner.onComposerLayout(true);
        }
        if (observation.type === "resize" && observation.scrollCorrection) {
          const { before, after } = observation.scrollCorrection;
          recordProgrammaticScroll(before, after);
        }
      })
    : undefined;
  const publishOffset = (offset: number, scrolling: boolean) => {
    if (scrolling && offset !== nativeOffset && owner.state.touchActive) {
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
    if (scrolling && delta !== 0 && !programmatic) {
      if (delta > 0 && owner.canFollowEnd()) {
        owner.endAnchor.capture(element);
      } else {
        owner.endAnchor.clear();
      }
      // Input can precede projection capture; carry its later native movement.
      owner.prependAnchor.moveWithReader(delta);
    }
    publish({
      type: "offset",
      delta,
      scrolling,
      touching: owner.state.touching,
      programmatic,
    });
    callback(offset, scrolling);
    owner.onOffset(delta !== 0 && !programmatic);
    // Range/isScrolling and pane follow policy already invalidate themselves.
    // The rail observes offsets directly; only touch-held history needs a geometry commit.
    if (owner.state.touchActive !== owner.state.renderedTouchActive) {
      owner.invalidate();
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
    const wasTouchActive = owner.state.touchActive;
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
    if (wasTouchActive !== owner.state.touchActive) {
      owner.invalidate();
    }
  };
  const finishScroll = () => {
    // Only touch scrolling holds history; wheel and trackpad settles need no render.
    if (!owner.state.touching && owner.state.touchScrolling) {
      owner.state.touchScrolling = false;
      owner.invalidate();
    }
  };
  const publishReaderIntent = (towardEnd: boolean) => {
    owner.endAnchor.clear();
    owner.onReaderScroll(towardEnd);
    // Downward input at the physical end need not emit another offset event.
    if (towardEnd && owner.canFollowEnd()) {
      owner.endAnchor.capture(element);
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
    owner.endAnchor.cancelComposerResize();
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
    publishReaderIntent(towardEnd);
  };
  const moveTouch = (event: TouchEvent) => {
    const nextY = localTouchY(event);
    // At a resize-clamped end there may be no offset event. Contact alone is
    // not a return; only a gesture moving toward the end can resume following.
    if (touchY !== undefined && nextY !== undefined && nextY < touchY) {
      publishReaderIntent(true);
    }
    touchY = nextY;
    publishInput(event);
  };
  // Commit editor-induced geometry before the pane's bubble listener classifies
  // the native offset. Only the actual correction carries maintenance provenance.
  const commitComposerResize = () => owner.onComposerLayout(true);
  const listeners = new AbortController();
  const passive = { passive: true, signal: listeners.signal };
  if (element) {
    listen(element, "scroll", commitComposerResize, { ...passive, capture: true });
    listen(element, "touchmove", moveTouch, passive);
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
      listen(element, type, interrupt, passive);
    }
    listen(element, "scrollend", finishScroll, passive);
    listen(element, "touchend", finishTouch, passive);
    listen(element, "touchcancel", finishTouch, passive);
  }
  const cleanup = observeElementOffset(instance, (offset, scrolling) => {
    if (element !== owner.getScrollElement()) {
      return;
    }
    publishOffset(offset, scrolling);
    if (scrolling && owner.state.maintenanceScrollOffset !== null) {
      const revision = maintenanceRevision;
      if (maintenanceFrame !== null) {
        cancelAnimationFrame(maintenanceFrame);
      }
      // Later native listeners can run after microtasks from this observer.
      // Retire this delivered receipt only after the entire event has finished.
      maintenanceFrame = requestAnimationFrame(() => {
        maintenanceFrame = null;
        if (revision === maintenanceRevision) {
          owner.state.maintenanceScrollOffset = null;
        }
      });
    }
    // The offset observer already owns idle detection on browsers without
    // scrollend. Release touch-held history through that same lifecycle.
    if (!scrolling) {
      finishScroll();
    }
    if (!scrolling && owner.prependAnchor.hasPrepend) {
      owner.invalidate();
    }
    // Retire a completed journey before delayed native idle can recapture a
    // reader who has since been resize-clamped to a different end. Completion
    // must not stop a smooth animation on its penultimate 1px frame; retain
    // the restore path's rounding tolerance only after native scrolling settles.
    // Reaching the end cannot retire a message reveal awaiting its DOM commit.
    if (
      element &&
      owner.state.scrollCommand?.target === "end" &&
      Math.abs((maxTranscriptScrollOffset(element) ?? 0) - element.scrollTop) <= (scrolling ? 0 : 1)
    ) {
      if (owner.state.scrollCommand.behavior === "smooth") {
        owner.cancelScroll();
      } else {
        owner.state.scrollCommand = null;
        // Arrival can precede the queued reconciliation frame. Retire its
        // index target too, without cancelling the reader’s end-follow intent.
        // The notification can lag a newer native write; hold the current viewport.
        instance.scrollToOffset(element.scrollTop, { behavior: "instant" });
      }
      owner.endAnchor.capture(element);
    }
  });
  return () => {
    if (maintenanceFrame !== null) {
      cancelAnimationFrame(maintenanceFrame);
    }
    if (owner.state.syncNativeOffset === syncOffset) {
      owner.state.syncNativeOffset = null;
    }
    if (owner.state.recordProgrammaticScroll === recordVirtualizerScroll) {
      owner.state.recordProgrammaticScroll = null;
      owner.state.maintenanceScrollOffset = null;
    }
    cleanup?.();
    stopCorrections?.();
    contactIds.clear();
    owner.state.touching = false;
    owner.state.touchScrolling = false;
    listeners.abort();
  };
}
