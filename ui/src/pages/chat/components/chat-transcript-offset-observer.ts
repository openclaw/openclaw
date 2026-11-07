import { elementScroll, observeElementOffset, type Virtualizer } from "@tanstack/virtual-core";
import { listen } from "../../../lib/reactive/listener.ts";
import { isTranscriptScrollKey } from "../chat-scroll-input.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX, type ChatScrollToEndOptions } from "../scroll.ts";
import type { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { maxTranscriptScrollOffset } from "./chat-transcript-geometry.ts";
import {
  reconcileChatTranscriptInteractionResize,
  type ChatTranscriptInteractionAnchor,
} from "./chat-transcript-interaction-anchor.ts";
import type { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import type { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import {
  publishTranscriptScroll,
  subscribeTranscriptScroll,
  type TranscriptScrollObservation,
  type TranscriptNativeScroll,
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
  syncNativeOffset: ((measurement?: boolean) => void) | null = null;
  measuringOffset = false;
  recordProgrammaticScroll: ((before: number, after: number, maintenance: boolean) => void) | null =
    null;

  get hasPendingCommand(): boolean {
    return this.pendingScrollOffset !== null || this.scrollCommand !== null;
  }

  get touchActive(): boolean {
    return this.touching || this.touchScrolling;
  }

  get hasPendingAnchor(): boolean {
    return Boolean(this.pendingScrollOffset || this.scrollCommand || this.pendingInteractionAnchor);
  }

  reconcileInteractionResize(
    scrollElement: HTMLDivElement | null,
    virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
    target?: EventTarget | null,
  ): void {
    if (
      reconcileChatTranscriptInteractionResize(
        this.pendingInteractionAnchor,
        target,
        scrollElement,
        virtualizer,
      )
    ) {
      this.pendingInteractionAnchor = null;
    }
  }
}

export function isTranscriptMaintenanceScroll(
  state: TranscriptOffsetState,
  element: HTMLDivElement | null,
  offset?: number,
  maintenanceTarget = state.maintenanceScrollOffset,
): boolean {
  return (
    element !== null &&
    maintenanceTarget !== null &&
    Math.min(maintenanceTarget, maxTranscriptScrollOffset(element) ?? 0) ===
      (offset ?? element.scrollTop)
  );
}

export function isTranscriptProgrammaticScroll(
  state: TranscriptOffsetState,
  element: HTMLDivElement | null,
  offset?: number,
  maintenanceTarget = state.maintenanceScrollOffset,
  command = state.scrollCommand,
): boolean {
  return (
    state.pendingScrollOffset !== null ||
    isTranscriptMaintenanceScroll(state, element, offset, maintenanceTarget) ||
    (command !== null &&
      (maxTranscriptScrollOffset(element) ?? 0) - (offset ?? element?.scrollTop ?? 0) >
        CHAT_TRANSCRIPT_END_THRESHOLD_PX)
  );
}

export function scrollTranscriptToEnd(
  state: TranscriptOffsetState,
  instance: Virtualizer<HTMLDivElement, HTMLElement>,
  { source, behavior }: Required<ChatScrollToEndOptions>,
  cancelScroll: (preserveEnd?: boolean) => void,
  measureSkippedRows: () => void,
  endAnchor: TranscriptEndAnchor,
  prepareEnd: (ready: () => void, isCurrent: () => boolean, native: boolean) => void,
): void {
  if (source === "auto" && endAnchor.capture(instance.scrollElement)) {
    return;
  }
  // Retargeting retains native motion and its issued destination during preparation.
  if (source !== "auto" || state.scrollCommand?.target !== "end") {
    cancelScroll();
  } else if (state.scrollCommand.behavior === "smooth" && behavior !== "smooth") {
    // Retargeting bypasses cancellation, which normally replays the row sizes
    // TanStack suppressed outside the outgoing smooth command’s target buffer.
    measureSkippedRows();
  }
  const command = (state.scrollCommand = {
    behavior,
    target: "end",
    offset: state.scrollCommand?.target === "end" ? state.scrollCommand.offset : undefined,
  });
  const scroll = () => {
    instance.scrollToEnd({ behavior });
    // Instant commands and smooth no-ops can reach their target before any
    // native offset event. Do not let delayed idle reclaim a departed reader.
    const element = instance.scrollElement;
    const max = maxTranscriptScrollOffset(element);
    if (element && max !== null && Math.abs(max - element.scrollTop) <= 1) {
      cancelScroll(true);
    }
    // A smooth no-op emits no native idle event to capture the end. Preserve
    // that actual resting edge before a later row measurement grows the range.
    if (behavior !== "smooth" || endAnchor.recordViewport(element)) {
      endAnchor.capture(element);
    }
  };
  if (source === "auto" || behavior === "smooth") {
    // Measure the bounded destination before native motion. A late estimate
    // contraction otherwise clamps the journey backward.
    prepareEnd(scroll, () => state.scrollCommand === command, source === "auto");
  } else {
    scroll();
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
  isMaintenanceScroll(command?: TranscriptOffsetState["scrollCommand"]): boolean;
  cancelScroll(preserveEnd?: boolean): void;
  onLayoutCorrection(before: number, after: number): void;
  invalidate(): void;
  onOffset(readerDelta: number): void;
  onReaderScroll(towardEnd?: boolean): void;
  onNativeScroll?: (scroll: TranscriptNativeScroll) => void;
  onHistoryIntent?: (event: Event) => void;
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
  // Measurement may synchronize TanStack before the native event arrives.
  // Only delivered native movement or an owned write may consume pane policy's baseline.
  let nativePolicyOffset = nativeOffset;
  // Late native echoes must not become reader intent after the event receipt retires.
  let maintenanceTarget: number | null = null;
  let maintenanceRevision = 0;
  let maintenanceFrame: number | null = null;
  type CapturedNativeScroll = {
    scroll: TranscriptNativeScroll;
    before: number;
    acknowledgedOffset: number;
    retiring: boolean;
    command: TranscriptOffsetState["scrollCommand"];
  };
  let capturedNativeScroll: CapturedNativeScroll | null = null;
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
    // Writers report after moving the element. Classify preceding movement at
    // its old coordinate/target, before the new correction owns the viewport.
    const programmatic = isTranscriptProgrammaticScroll(
      owner.state,
      element,
      before,
      maintenanceTarget,
    );
    nativeOffset = after;
    // Record a real write before subscribers can remap the viewport. An exact
    // composer correction can cover a browser clamp captured before layout.
    if (before !== after) {
      nativePolicyOffset = after;
      maintenanceTarget = owner.state.maintenanceScrollOffset = after;
      maintenanceRevision += 1;
      const captured = capturedNativeScroll;
      if (captured) {
        // Publishing the original root fact must not rewind a newer owned write.
        captured.acknowledgedOffset = after;
      }
      if (
        captured &&
        !captured.retiring &&
        ((before === captured.before && after === captured.scroll.viewport.scrollTop) ||
          (after === captured.before && before === captured.scroll.viewport.scrollTop))
      ) {
        captured.scroll = { ...captured.scroll, programmatic: true, maintenance: true };
      }
    }
    publish({
      type: "offset",
      delta,
      scrolling: instance.isScrolling,
      touching: owner.state.touching,
      programmatic,
    });
  };
  const recordVirtualizerScroll = (before: number, after: number, maintenance: boolean) => {
    // Measurement retries can move the old end after the grown range commits.
    // Layout/composer receipts already carry their anchor correction separately.
    if (maintenance && before !== after) {
      owner.onLayoutCorrection(before, after);
    }
    recordProgrammaticScroll(before, after);
    // A native no-op has no scroll event to acknowledge an explicit command.
    if (!maintenance && before === after && after !== instance.scrollOffset) {
      publishOffset(after, instance.isScrolling);
    }
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
  const reconcileMaintenanceOffset = () => {
    if (maintenanceTarget !== null) {
      const target = Math.min(maintenanceTarget, maxTranscriptScrollOffset(element) ?? 0);
      const actualOffset = element?.scrollTop;
      maintenanceTarget = owner.state.maintenanceScrollOffset =
        actualOffset === target ? actualOffset : null;
      maintenanceRevision += 1;
    }
  };
  const readNativeScroll = (offset: number): CapturedNativeScroll => {
    reconcileMaintenanceOffset();
    const viewport = {
      scrollTop: offset,
      clientHeight: element?.clientHeight ?? 0,
      scrollHeight: element?.scrollHeight ?? 0,
    };
    const delta = offset - nativePolicyOffset;
    const command = owner.state.scrollCommand;
    // Measurement sync can consume the numeric offset before this event. Decide
    // retirement from pane policy's movement and the OLD maintenance target.
    const retiringCommand =
      delta !== 0 &&
      command?.target === "end" &&
      command.offset === undefined &&
      owner.state.pendingScrollOffset === null &&
      !isTranscriptMaintenanceScroll(owner.state, element, offset, maintenanceTarget)
        ? command
        : null;
    const preparedCommand = retiringCommand ? null : command;
    return {
      scroll: {
        viewport,
        delta,
        programmatic: isTranscriptProgrammaticScroll(
          owner.state,
          element,
          offset,
          maintenanceTarget,
          preparedCommand,
        ),
        maintenance: owner.isMaintenanceScroll(preparedCommand),
      },
      before: nativeOffset,
      acknowledgedOffset: offset,
      retiring: false,
      command: retiringCommand,
    };
  };
  const publishOffset = (offset: number, scrolling: boolean, captured?: CapturedNativeScroll) => {
    const scroll = captured?.scroll;
    if (captured) {
      nativePolicyOffset = captured.acknowledgedOffset;
    }
    // Native policy uses only the root event's captured geometry. Explicit
    // synchronization and idle notifications do not manufacture reader input.
    if (scrolling && offset !== nativeOffset && owner.state.touchActive) {
      owner.state.touchScrolling = true;
    }
    const delta = offset - nativeOffset;
    nativeOffset = offset;
    reconcileMaintenanceOffset();
    const programmatic = owner.isProgrammaticScroll();
    // The follow threshold releases pane policy before a command's last pixels settle.
    const readerDelta = programmatic || owner.state.scrollCommand !== null ? 0 : delta;
    const reachedRecordedEnd = owner.endAnchor.isRecordedEnd(offset);
    // Capture arrival before the new window can grow the native extent.
    const atEnd = owner.endAnchor.recordViewport(element);
    if (delta !== 0 && !programmatic) {
      // Measurement can observe arrival before the native event unlocks pane following.
      if (delta > 0 && !owner.canFollowEnd() && (reachedRecordedEnd || atEnd)) {
        owner.onReaderScroll(true);
      }
      if (delta > 0 && owner.canFollowEnd()) {
        owner.endAnchor.capture(element);
      } else {
        owner.endAnchor.clear();
      }
      // Input can precede projection capture; carry its later native movement.
      if (scrolling) {
        owner.prependAnchor.moveWithReader(delta);
      }
    }
    // Preparation receives movement before vendor range selection; pane policy
    // consumes the captured viewport before subscribers can replace that range.
    owner.onOffset(readerDelta);
    if (scroll) {
      owner.onNativeScroll?.(scroll);
    }
    publish({
      type: "offset",
      delta,
      scrolling,
      touching: owner.state.touching,
      programmatic,
    });
    callback(offset, scrolling);
    // Range/isScrolling and pane follow policy already invalidate themselves.
    // The rail observes offsets directly; only touch-held history needs a geometry commit.
    if (owner.state.touchActive !== owner.state.renderedTouchActive) {
      owner.invalidate();
    }
    if (owner.state.maintenanceScrollOffset !== null) {
      const revision = maintenanceRevision;
      if (maintenanceFrame !== null) {
        cancelAnimationFrame(maintenanceFrame);
      }
      // Later native listeners can run after microtasks from this observer.
      // Retire every delivered receipt, including idle and explicit synchronization.
      maintenanceFrame = requestAnimationFrame(() => {
        maintenanceFrame = null;
        if (revision === maintenanceRevision) {
          owner.state.maintenanceScrollOffset = null;
        }
      });
    }
  };
  const syncOffset = (measurement = false) => {
    if (!element || element !== owner.getScrollElement() || instance.scrollElement !== element) {
      return;
    }
    const offset = element.scrollTop;
    const logicalOffset = instance.scrollOffset;
    if (offset === logicalOffset) {
      return;
    }
    // Preserve reachable compensation at an end clamp until the sizer commits.
    if (
      offset === nativeOffset &&
      logicalOffset !== null &&
      logicalOffset > offset &&
      offset === maxTranscriptScrollOffset(element)
    ) {
      const modeledHeight =
        instance.getTotalSize() +
        instance.options.scrollMargin +
        (Number.parseFloat(element.style.paddingBottom) || 0);
      if (logicalOffset <= modeledHeight - element.clientHeight) {
        return;
      }
    }
    owner.state.measuringOffset = measurement;
    try {
      publishOffset(offset, instance.isScrolling);
    } finally {
      owner.state.measuringOffset = false;
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
      owner.onHistoryIntent?.(event);
      return;
    }
    touchY = undefined;
    // Idle may have arrived while the finger was still down; no further
    // offset notification is guaranteed after releasing a stationary touch.
    if (!instance.isScrolling) {
      owner.state.touchScrolling = false;
    }
    publishInput(event);
    owner.onHistoryIntent?.(event);
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
    if (
      event.defaultPrevented ||
      !element ||
      element !== owner.getScrollElement() ||
      instance.scrollElement !== element
    ) {
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
    maintenanceTarget = owner.state.maintenanceScrollOffset = null;
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
    // Keydown policy runs after the thread's delegated link handling instead.
    if (event.type === "wheel" || event.type === "touchstart") {
      owner.onHistoryIntent?.(event);
    }
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
    owner.onHistoryIntent?.(event);
  };
  const currentViewport = () =>
    element !== null && element === owner.getScrollElement() && instance.scrollElement === element;
  const captureScroll = (event: Event) => {
    if (event.target !== element || !element) {
      // Child scrolling can resize the composer without becoming transcript input.
      owner.onComposerLayout(true);
      return;
    }
    if (!currentViewport()) {
      return;
    }
    // Assign before callbacks: a nested delivery or disconnect wins this identity.
    const captured = (capturedNativeScroll = readNativeScroll(element.scrollTop));
    owner.onComposerLayout(true);
    if (capturedNativeScroll !== captured || !currentViewport()) {
      if (capturedNativeScroll === captured) {
        capturedNativeScroll = null;
      }
      return;
    }
    if (
      captured.command &&
      owner.state.scrollCommand === captured.command &&
      !captured.scroll.maintenance
    ) {
      // Only genuine composer corrections may promote the original fact. A
      // cancellation writing the inverse pair must remain a later owned write.
      captured.retiring = true;
      try {
        owner.cancelScroll();
      } finally {
        captured.retiring = false;
      }
      if (!currentViewport() && capturedNativeScroll === captured) {
        capturedNativeScroll = null;
      }
    }
  };
  const listeners = new AbortController();
  const passive = { passive: true, signal: listeners.signal };
  if (element) {
    listen(element, "scroll", captureScroll, { ...passive, capture: true });
    listen(element, "touchmove", moveTouch, passive);
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
      listen(element, type, interrupt, passive);
    }
    listen(element, "scrollend", finishScroll, passive);
    listen(element, "touchend", finishTouch, passive);
    listen(element, "touchcancel", finishTouch, passive);
  }
  const cleanup = observeElementOffset(instance, (offset, scrolling) => {
    const captured = scrolling ? capturedNativeScroll : null;
    if (scrolling) {
      capturedNativeScroll = null;
    }
    // A newer nested native delivery already published this observer's state.
    if (scrolling && captured === null) {
      return;
    }
    if (element !== owner.getScrollElement()) {
      return;
    }
    publishOffset(offset, scrolling, captured ?? undefined);
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
      owner.cancelScroll(true);
    }
  });
  return () => {
    capturedNativeScroll = null;
    maintenanceTarget = null;
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
