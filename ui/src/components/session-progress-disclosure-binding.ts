import { createEffect, onCleanup, useContext, type Accessor } from "solid-js";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import {
  subscribeTranscriptScroll,
  type TranscriptScrollObservation,
} from "../pages/chat/components/chat-transcript-scroll-events.ts";
import {
  PROGRESS_DISCLOSURE,
  resolveProgressDisclosure,
  type ProgressDisclosureEvent,
  type ProgressDisclosureState,
} from "./session-progress-disclosure.ts";

export type ComposerProgressDisclosureContext = {
  presented?: boolean;
  /** Details is a user-opened surface, not a transcript-scroll sheet. */
  manualOnly?: boolean;
  gatewayScope?: object;
  sessionIdentity?: string;
  cardLifetime?: object;
  readingHistory?: boolean;
  onManipulate?: () => void;
};

type DisclosureInput = [
  sessionKey: string,
  initialOpen: boolean,
  lifecycle?: ComposerProgressDisclosureContext,
];

type ScrollGesture = {
  kind: "wheel" | "touch";
  valid: boolean;
  distancePx: number;
};

type RememberedChoice = { choice: boolean | number };
const choicesByCard = new WeakMap<object, RememberedChoice>();

function createDisclosure(
  element: HTMLDetailsElement,
  summary: HTMLElement,
  body: HTMLElement,
  initialInput: DisclosureInput,
) {
  let currentSessionKey = initialInput[0];
  let gatewayScope = initialInput[2]?.gatewayScope;
  let cardLifetime = initialInput[2]?.cardLifetime;
  let rememberedChoice: RememberedChoice | undefined;
  let currentTranscript: HTMLElement | null = null;
  let unsubscribeTranscript: (() => void) | undefined;
  let disposed = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollSettled = false;
  let lifecycle: ComposerProgressDisclosureContext | undefined;
  let listeners: AbortController | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let drag: { id: number; x: number; y: number; extent: number; active: boolean } | undefined;
  let suppressClick = false;
  let lastWheelAt: number | undefined;
  let gesture: ScrollGesture | undefined;
  let touching = false;
  let scrolling = false;
  let state = mount(initialInput);

  function mount([, initialOpen, initialLifecycle]: DisclosureInput): ProgressDisclosureState {
    resetScrollInput();
    cancelDrag();
    rememberedChoice = cardLifetime ? choicesByCard.get(cardLifetime) : undefined;
    return resolveProgressDisclosure(undefined, {
      type: "mount",
      open: initialOpen && (initialLifecycle?.manualOnly === true || !isMobileNavLayout()),
      manualOpen: rememberedChoice?.choice,
      readingHistory: initialLifecycle?.readingHistory === true,
    });
  }

  function update(input: DisclosureInput): void {
    const [sessionKey, , nextLifecycle] = input;
    lifecycle = nextLifecycle;
    if (
      sessionKey !== currentSessionKey ||
      lifecycle?.gatewayScope !== gatewayScope ||
      lifecycle?.cardLifetime !== cardLifetime
    ) {
      currentSessionKey = sessionKey;
      gatewayScope = lifecycle?.gatewayScope;
      cardLifetime = lifecycle?.cardLifetime;
      state = mount(input);
    }
    const readingHistory = lifecycle?.readingHistory === true;
    if (readingHistory !== state.readingHistory) {
      if (!readingHistory) {
        resetScrollInput();
      }
      dispatch({ type: "history", readingHistory });
    }
    // A question retains the card but takes over its input surface. Hidden
    // transcript gestures must not change the disclosure restored afterward.
    if (lifecycle?.presented === false) {
      takeover();
      disconnectHeader();
    }
    connectHeader();
    apply();
    // The surrounding transcript may be inserted after this disclosure ref settles.
    queueMicrotask(() => {
      if (disposed) {
        return;
      }
      connectHeader();
      connectTranscript();
      apply();
    });
  }

  function dispatch(event: ProgressDisclosureEvent): void {
    const previous = state;
    state = resolveProgressDisclosure(previous, event);
    if (!cardLifetime) {
      return;
    }
    const manual = event.type === "click" || event.type === "extent" || event.type === "clamp";
    const collapsed = event.type === "settle" && previous.open && !state.open;
    // Another pane may have made a newer choice while this pane was scrolling.
    if (manual || (collapsed && choicesByCard.get(cardLifetime) === rememberedChoice)) {
      rememberedChoice = { choice: state.manualOpen ?? state.open };
      choicesByCard.set(cardLifetime, rememberedChoice);
    }
  }

  function resetScrollInput(): void {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    scrollSettled = false;
    lastWheelAt = undefined;
    gesture = undefined;
    touching = false;
    scrolling = false;
  }

  function scheduleCollapse() {
    if (settleTimer !== undefined) {
      clearTimeout(settleTimer);
    }
    scrollSettled = false;
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      scrollSettled = true;
      settleDisclosure();
    }, PROGRESS_DISCLOSURE.scrollSettleMs);
  }

  function flushGesture(): void {
    const completedGesture = gesture;
    gesture = undefined;
    if (
      completedGesture?.valid &&
      completedGesture.distancePx > 0 &&
      (completedGesture.kind === "wheel" ||
        completedGesture.distancePx > PROGRESS_DISCLOSURE.touchGesturePx)
    ) {
      dispatch({ type: "gesture", distancePx: completedGesture.distancePx });
    }
  }

  function settleDisclosure(): void {
    if (touching || scrolling) {
      return;
    }
    // The idle timer can precede the first native offset; no movement has settled yet.
    if (!gesture?.valid || gesture.distancePx > 0) {
      flushGesture();
    }
    if (state.distancePx > 0) {
      dispatch({ type: "settle" });
      apply();
    }
  }

  function handleTranscriptScroll(observation: TranscriptScrollObservation) {
    if (observation.type !== "input" && observation.type !== "offset") {
      return;
    }
    touching = observation.touching;
    if (observation.type === "offset") {
      scrolling = observation.scrolling;
      if (observation.programmatic && gesture?.distancePx === 0) {
        gesture = undefined;
      }
      if (!observation.programmatic && observation.delta !== 0) {
        if (gesture) {
          gesture.distancePx += Math.max(0, -observation.delta);
        }
        scheduleCollapse();
      }
      if (!scrolling && scrollSettled) {
        settleDisclosure();
      }
      return;
    }
    const { event } = observation;
    if (event instanceof WheelEvent) {
      if (event.ctrlKey) {
        return;
      }
      const now = performance.now();
      if (
        gesture?.kind !== "wheel" ||
        lastWheelAt === undefined ||
        now - lastWheelAt > PROGRESS_DISCLOSURE.gesturePauseMs
      ) {
        flushGesture();
        scrollSettled = false;
        gesture = { kind: "wheel", valid: true, distancePx: 0 };
      }
      lastWheelAt = now;
      // Keep the gesture alive before offsets arrive or while clamped at an edge.
      scheduleCollapse();
    } else if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
      if (event.type === "touchstart" && event.touches.length === 1) {
        flushGesture();
        scrollSettled = false;
        gesture = { kind: "touch", valid: true, distancePx: 0 };
      }
      if (
        gesture?.kind === "touch" &&
        (event.touches.length > 1 ||
          event.type === "touchcancel" ||
          (event.type === "touchend" && event.touches.length > 0))
      ) {
        gesture.valid = false;
      }
      // Keep the same gesture through inertia. A stationary release may be
      // the last notification after the native offset has already settled.
      if (!touching && scrollSettled) {
        settleDisclosure();
      }
    } else {
      flushGesture();
    }
  }

  function connectTranscript(): void {
    if (disposed) {
      return;
    }
    const transcript =
      lifecycle?.presented === false || lifecycle?.manualOnly
        ? null
        : (element.closest(".chat-main")?.querySelector<HTMLElement>(".chat-thread") ?? null);
    if (transcript === currentTranscript) {
      return;
    }
    resetScrollInput();
    unsubscribeTranscript?.();
    currentTranscript = transcript;
    unsubscribeTranscript = transcript
      ? subscribeTranscriptScroll(transcript, handleTranscriptScroll)
      : undefined;
  }

  function connectHeader(): void {
    if (disposed || lifecycle?.presented === false || lifecycle?.manualOnly) {
      return;
    }
    if (listeners) {
      return;
    }
    listeners = new AbortController();
    const signal = listeners.signal;
    summary.addEventListener("wheel", wheel, { passive: false, signal });
    summary.addEventListener("pointerdown", pointerDown, { signal });
    summary.addEventListener("pointermove", pointerMove, { signal });
    summary.addEventListener("pointerup", pointerEnd, { signal });
    summary.addEventListener("pointercancel", pointerEnd, { signal });
    summary.addEventListener("lostpointercapture", pointerEnd, { signal });
    summary.ownerDocument.addEventListener("pointerdown", otherPointer, {
      capture: true,
      signal,
    });
    summary.ownerDocument.defaultView?.addEventListener("blur", cancelDrag, { signal });
    // Only viewport changes can clamp a retained manual extent. Streamed card
    // revisions cannot resize it, even when the revised note is shorter.
    summary.ownerDocument.defaultView?.addEventListener("resize", clampExtent, {
      signal,
    });
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(clampExtent);
      resizeObserver.observe(body);
    }
  }

  function disconnectHeader(): void {
    cancelDrag();
    listeners?.abort();
    listeners = undefined;
    resizeObserver?.disconnect();
    resizeObserver = undefined;
  }

  function readChoice(): boolean | number {
    return state.manualOpen ?? state.open;
  }

  function limit(): number {
    return Number.parseFloat(getComputedStyle(body).maxHeight) || 300;
  }

  function readExtent(): number {
    const chosen = readChoice();
    return typeof chosen === "number"
      ? Math.min(chosen, limit())
      : chosen
        ? body.getBoundingClientRect().height
        : 0;
  }

  function apply(): void {
    const chosen = readChoice();
    const partial = typeof chosen === "number";
    const extent = partial ? Math.min(chosen, limit()) : 0;
    const open = partial ? extent > 0 : chosen;
    if (element.open !== open) {
      element.open = open;
    }
    body.style.height = partial ? extent + "px" : "";
    body.style.minHeight = partial ? extent + "px" : "";
    const reveal = partial ? "partial" : chosen ? "open" : "closed";
    if (element.dataset.reveal !== reveal) {
      element.dataset.reveal = reveal;
    }
  }

  function clampExtent() {
    if (typeof state.manualOpen === "number" && state.manualOpen > limit()) {
      dispatch({ type: "clamp", limit: limit() });
      cancelDrag();
    }
    apply();
  }

  function isControl(event: Event): boolean {
    return (
      event.target instanceof Element &&
      Boolean(event.target.closest("button, a, input, select, textarea"))
    );
  }

  function click(event: MouseEvent) {
    if (
      event.defaultPrevented ||
      isControl(event) ||
      !(event.target instanceof Element) ||
      event.target.closest("summary")?.parentElement !== element
    ) {
      return;
    }
    event.preventDefault();
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      return;
    }
    cancelDrag();
    // Partial sheets expand first, but a gesture can already reveal the full
    // viewport (or all short content) without choosing the boolean open state.
    const chosen = readChoice();
    const fullyRevealed =
      (typeof chosen === "boolean" && element.open) ||
      (typeof chosen === "number" &&
        chosen > 0 &&
        (chosen >= limit() ||
          (body.clientHeight > 0 && body.scrollHeight <= body.clientHeight + 1)));
    resetScrollInput();
    dispatch({ type: "click", open: !fullyRevealed });
    apply();
  }

  function move(extent: number): void {
    takeover();
    dispatch({ type: "extent", extent: Math.max(0, Math.min(limit(), extent)) });
    lifecycle?.onManipulate?.();
    apply();
  }

  function takeover(): void {
    resetScrollInput();
    dispatch({ type: "takeover" });
  }

  function wheel(event: WheelEvent) {
    if (
      event.defaultPrevented ||
      isControl(event) ||
      drag ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !Number.isFinite(event.deltaY) ||
      !Number.isFinite(event.deltaX) ||
      !event.deltaY ||
      Math.abs(event.deltaX) >= Math.abs(event.deltaY)
    ) {
      return;
    }
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? Number.parseFloat(getComputedStyle(summary).lineHeight) || 18
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? limit()
          : 1;
    const next = readExtent() - event.deltaY * unit;
    // The header is the only wheel target. Body and transcript scrolling stay native.
    event.preventDefault();
    // Accepted input owns the panel even when its extent is already clamped.
    move(next);
  }

  function pointerDown(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || isControl(event) || event.defaultPrevented) {
      return;
    }
    suppressClick = false;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      extent: readExtent(),
      active: false,
    };
    summary.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent) {
    const activeDrag = drag;
    if (!activeDrag || activeDrag.id !== event.pointerId) {
      return;
    }
    const dx = event.clientX - activeDrag.x;
    const dy = event.clientY - activeDrag.y;
    if (!activeDrag.active) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 3) {
        return;
      }
      if (Math.abs(dx) >= Math.abs(dy)) {
        cancelDrag();
        return;
      }
      takeover();
      activeDrag.active = true;
      suppressClick = true;
    }
    event.preventDefault();
    const requested = activeDrag.extent - dy;
    move(requested);
    // Discard excess travel at a hard boundary so reversal responds immediately.
    if (requested < 0 || requested > limit()) {
      activeDrag.extent = readExtent();
      activeDrag.y = event.clientY;
    }
  }

  function otherPointer(event: PointerEvent) {
    if (drag && event.pointerId !== drag.id) {
      cancelDrag();
    }
  }

  function pointerEnd(event: PointerEvent) {
    if (event.pointerId === drag?.id) {
      cancelDrag();
    }
  }

  function cancelDrag() {
    const activeDrag = drag;
    drag = undefined;
    if (activeDrag && summary.hasPointerCapture(activeDrag.id)) {
      summary.releasePointerCapture(activeDrag.id);
    }
  }

  function dispose(): void {
    disposed = true;
    unsubscribeTranscript?.();
    unsubscribeTranscript = undefined;
    disconnectHeader();
    resetScrollInput();
  }

  return { update, click, dispose };
}

/** Retains gesture and resource ownership across progress snapshots. */
export function createComposerProgressDisclosure(input: Accessor<DisclosureInput>) {
  const presented = useContext(ContentPresentation);
  let element: HTMLDetailsElement;
  let summary: HTMLElement;
  let body: HTMLElement;
  let disclosure: ReturnType<typeof createDisclosure> | undefined;
  createEffect(
    () => [presented(), input()] as const,
    ([active, value]) => {
      if (!active) {
        disclosure?.dispose();
        disclosure = undefined;
        return;
      }
      disclosure ??= createDisclosure(element, summary, body, value);
      disclosure.update(value);
    },
  );
  onCleanup(() => disclosure?.dispose());
  return {
    details: (value: HTMLDetailsElement) => {
      element = value;
    },
    summary: (value: HTMLElement) => {
      summary = value;
    },
    body: (value: HTMLElement) => {
      body = value;
    },
    onClick: (event: MouseEvent) => disclosure?.click(event),
  };
}
