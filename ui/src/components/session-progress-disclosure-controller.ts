import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
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

export type ComposerProgressRunLifecycle = {
  gatewayScope?: object;
  sessionIdentity?: string;
  activeRunId?: string | null;
  completedRunId?: string | null;
  readingHistory?: boolean;
  onManipulate?: () => void;
};

type DisclosureInput = [
  sessionKey: string,
  initialOpen: boolean,
  collapseByDefault: boolean,
  lifecycle?: ComposerProgressRunLifecycle,
];

type ScrollGesture = {
  kind: "wheel" | "touch";
  valid: boolean;
  distancePx: number;
};

type RememberedChoice = boolean | { extent: number; runId: string };
const manualChoicesByGateway = new WeakMap<object, Map<string, RememberedChoice>>();

class ProgressDisclosureController {
  private state: ProgressDisclosureState;
  private sessionKey: string;
  private gatewayScope: object | undefined;
  private transcript: HTMLElement | null = null;
  private unsubscribeTranscript: (() => void) | undefined;
  private disposed = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollSettled = false;
  private lifecycle?: ComposerProgressRunLifecycle;
  private summary?: HTMLElement;
  private body?: HTMLElement;
  private listeners?: AbortController;
  private resizeObserver?: ResizeObserver;
  private drag?: { id: number; x: number; y: number; extent: number; active: boolean };
  private suppressClick = false;
  private lastWheelAt: number | undefined;
  private gesture: ScrollGesture | undefined;
  private touching = false;
  private scrolling = false;

  constructor(
    private readonly element: HTMLDetailsElement,
    input: DisclosureInput,
  ) {
    this.sessionKey = input[0];
    this.gatewayScope = input[3]?.gatewayScope;
    this.state = this.mount(input);
    this.element.addEventListener("click", this.click);
  }

  private mount([sessionKey, initialOpen, , lifecycle]: DisclosureInput): ProgressDisclosureState {
    this.resetScrollInput();
    this.cancelDrag();
    const remembered = this.gatewayScope
      ? manualChoicesByGateway.get(this.gatewayScope)?.get(sessionKey)
      : undefined;
    const runId = lifecycle?.activeRunId ?? lifecycle?.completedRunId;
    const manualOpen =
      typeof remembered === "object"
        ? remembered.runId === runId
          ? remembered.extent
          : undefined
        : remembered;
    return resolveProgressDisclosure(undefined, {
      type: "mount",
      open: initialOpen,
      manualOpen,
      activeRunId: lifecycle?.activeRunId ?? null,
      completedRunId: lifecycle?.completedRunId ?? null,
      readingHistory: lifecycle?.readingHistory === true,
    });
  }

  update(input: DisclosureInput): void {
    const [sessionKey, , collapseByDefault, lifecycle] = input;
    this.lifecycle = lifecycle;
    if (sessionKey !== this.sessionKey || lifecycle?.gatewayScope !== this.gatewayScope) {
      this.sessionKey = sessionKey;
      this.gatewayScope = lifecycle?.gatewayScope;
      this.state = this.mount(input);
    }
    if (lifecycle?.activeRunId && lifecycle.activeRunId !== this.state.activeRunId) {
      this.resetScrollInput();
      this.cancelDrag();
      this.dispatch({ type: "run", runId: lifecycle.activeRunId, open: !collapseByDefault });
    }
    const readingHistory = lifecycle?.readingHistory === true;
    if (readingHistory !== this.state.readingHistory) {
      if (!readingHistory) {
        this.resetScrollInput();
      }
      this.dispatch({ type: "history", readingHistory });
    }
    if (lifecycle?.completedRunId) {
      this.dispatch({ type: "complete", runId: lifecycle.completedRunId });
    }
    this.connectHeader();
    this.apply();
    // Lit attaches the surrounding transcript after committing this element part.
    queueMicrotask(() => {
      if (this.disposed) {
        return;
      }
      this.connectHeader();
      this.connectTranscript();
      this.apply();
    });
  }

  private dispatch(event: ProgressDisclosureEvent): void {
    const previous = this.state;
    this.state = resolveProgressDisclosure(previous, event);
    if (!this.gatewayScope) {
      return;
    }
    const choices =
      manualChoicesByGateway.get(this.gatewayScope) ?? new Map<string, RememberedChoice>();
    if (event.type === "click") {
      choices.set(this.sessionKey, this.state.open);
      manualChoicesByGateway.set(this.gatewayScope, choices);
    } else if (
      (event.type === "extent" || event.type === "clamp") &&
      typeof this.state.manualOpen === "number"
    ) {
      const runId = this.state.activeRunId ?? this.state.completedRunId;
      if (runId) {
        choices.set(this.sessionKey, { extent: this.state.manualOpen, runId });
        manualChoicesByGateway.set(this.gatewayScope, choices);
      }
    } else if (event.type === "settle" && previous.open && !this.state.open) {
      const remembered = choices.get(this.sessionKey);
      // Do not erase a newer choice made in another pane.
      if (
        remembered === true ||
        (typeof remembered === "object" &&
          remembered.runId === this.state.activeRunId &&
          remembered.extent === previous.manualOpen)
      ) {
        choices.delete(this.sessionKey);
      }
    }
  }

  private resetScrollInput(): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    this.scrollSettled = false;
    this.lastWheelAt = undefined;
    this.gesture = undefined;
    this.touching = false;
    this.scrolling = false;
  }

  private readonly scheduleCollapse = () => {
    clearTimeout(this.settleTimer);
    this.scrollSettled = false;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.scrollSettled = true;
      this.settleDisclosure();
    }, PROGRESS_DISCLOSURE.scrollSettleMs);
  };

  private flushGesture(): void {
    const gesture = this.gesture;
    this.gesture = undefined;
    if (
      gesture?.valid &&
      gesture.distancePx > 0 &&
      (gesture.kind === "wheel" || gesture.distancePx > PROGRESS_DISCLOSURE.touchGesturePx)
    ) {
      this.dispatch({ type: "gesture", distancePx: gesture.distancePx });
    }
  }

  private settleDisclosure(): void {
    if (this.touching || this.scrolling) {
      return;
    }
    this.flushGesture();
    if (this.state.distancePx > 0) {
      this.dispatch({ type: "settle" });
      this.apply();
    }
  }

  private readonly handleTranscriptScroll = (observation: TranscriptScrollObservation) => {
    if (observation.type === "resize") {
      return;
    }
    this.touching = observation.touching;
    if (observation.type === "offset") {
      this.scrolling = observation.scrolling;
      if (!observation.programmatic && observation.delta !== 0) {
        if (this.gesture) {
          this.gesture.distancePx += Math.max(0, -observation.delta);
        }
        this.scheduleCollapse();
      }
      if (!this.scrolling && this.scrollSettled) {
        this.settleDisclosure();
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
        this.gesture?.kind !== "wheel" ||
        this.lastWheelAt === undefined ||
        now - this.lastWheelAt > PROGRESS_DISCLOSURE.gesturePauseMs
      ) {
        this.flushGesture();
        this.scrollSettled = false;
        this.gesture = { kind: "wheel", valid: true, distancePx: 0 };
      }
      this.lastWheelAt = now;
      // Keep the gesture alive before offsets arrive or while clamped at an edge.
      this.scheduleCollapse();
    } else if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
      if (event.type === "touchstart" && event.touches.length === 1) {
        this.flushGesture();
        this.scrollSettled = false;
        this.gesture = { kind: "touch", valid: true, distancePx: 0 };
      }
      if (
        this.gesture?.kind === "touch" &&
        (event.touches.length > 1 ||
          event.type === "touchcancel" ||
          (event.type === "touchend" && event.touches.length > 0))
      ) {
        this.gesture.valid = false;
      }
      // Keep the same gesture through inertia. A stationary release may be
      // the last notification after the native offset has already settled.
      if (!this.touching && this.scrollSettled) {
        this.settleDisclosure();
      }
    } else {
      this.flushGesture();
    }
  };

  private connectTranscript(): void {
    if (this.disposed) {
      return;
    }
    const transcript =
      this.element.closest(".chat-main")?.querySelector<HTMLElement>(".chat-thread") ?? null;
    if (transcript === this.transcript) {
      return;
    }
    this.resetScrollInput();
    this.unsubscribeTranscript?.();
    this.transcript = transcript;
    this.unsubscribeTranscript = transcript
      ? subscribeTranscriptScroll(transcript, this.handleTranscriptScroll)
      : undefined;
  }

  private connectHeader(): void {
    if (this.disposed) {
      return;
    }
    this.summary ??= this.element.querySelector<HTMLElement>("summary") ?? undefined;
    this.body ??=
      this.element.querySelector<HTMLElement>(".session-progress-card__body") ?? undefined;
    if (!this.summary || this.listeners) {
      return;
    }
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    this.summary.addEventListener("wheel", this.wheel, { passive: false, signal });
    this.summary.addEventListener("pointerdown", this.pointerDown, { signal });
    this.summary.addEventListener("pointermove", this.pointerMove, { signal });
    this.summary.addEventListener("pointerup", this.pointerEnd, { signal });
    this.summary.addEventListener("pointercancel", this.pointerEnd, { signal });
    this.summary.addEventListener("lostpointercapture", this.pointerEnd, { signal });
    this.summary.ownerDocument.addEventListener("pointerdown", this.otherPointer, {
      capture: true,
      signal,
    });
    this.summary.ownerDocument.defaultView?.addEventListener("blur", this.cancelDrag, { signal });
    // Only viewport changes can clamp a retained manual extent. Streamed card
    // revisions cannot resize it, even when the revised note is shorter.
    this.summary.ownerDocument.defaultView?.addEventListener("resize", this.clampExtent, {
      signal,
    });
    if (typeof ResizeObserver !== "undefined" && this.body) {
      this.resizeObserver = new ResizeObserver(this.clampExtent);
      this.resizeObserver.observe(this.body);
    }
  }

  private disconnectHeader(): void {
    this.cancelDrag();
    this.listeners?.abort();
    this.listeners = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }

  private chosen(): boolean | number {
    return this.state.manualOpen ?? this.state.open;
  }

  private limit(): number {
    return this.body ? Number.parseFloat(getComputedStyle(this.body).maxHeight) || 300 : 300;
  }

  private extent(): number {
    const chosen = this.chosen();
    return typeof chosen === "number"
      ? Math.min(chosen, this.limit())
      : chosen
        ? (this.body?.getBoundingClientRect().height ?? 0)
        : 0;
  }

  private apply(): void {
    this.body ??=
      this.element.querySelector<HTMLElement>(".session-progress-card__body") ?? undefined;
    const chosen = this.chosen();
    const partial = typeof chosen === "number";
    const extent = partial ? Math.min(chosen, this.limit()) : 0;
    this.element.open = partial ? extent > 0 : chosen;
    if (this.body) {
      this.body.style.height = partial ? extent + "px" : "";
      this.body.style.minHeight = partial ? extent + "px" : "";
    }
    this.element.dataset.reveal = partial ? "partial" : chosen ? "open" : "closed";
  }

  private readonly clampExtent = () => {
    if (typeof this.state.manualOpen === "number" && this.state.manualOpen > this.limit()) {
      this.dispatch({ type: "clamp", limit: this.limit() });
      this.cancelDrag();
    }
    this.apply();
  };

  private isControl(event: Event): boolean {
    return (
      event.target instanceof Element &&
      Boolean(event.target.closest("button, a, input, select, textarea"))
    );
  }

  private readonly click = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      this.isControl(event) ||
      !(event.target instanceof Element) ||
      event.target.closest("summary")?.parentElement !== this.element
    ) {
      return;
    }
    event.preventDefault();
    if (this.suppressClick && event.detail !== 0) {
      this.suppressClick = false;
      return;
    }
    this.cancelDrag();
    // Partial sheets expand first, but a gesture can already reveal the full
    // viewport (or all short content) without choosing the boolean open state.
    const chosen = this.chosen();
    const fullyRevealed =
      (typeof chosen === "boolean" && this.element.open) ||
      (typeof chosen === "number" &&
        chosen > 0 &&
        (chosen >= this.limit() ||
          Boolean(
            this.body &&
            this.body.clientHeight > 0 &&
            this.body.scrollHeight <= this.body.clientHeight + 1,
          )));
    this.resetScrollInput();
    this.dispatch({ type: "click", open: !fullyRevealed });
    this.apply();
  };

  private move(extent: number): void {
    this.takeover();
    this.dispatch({ type: "extent", extent: Math.max(0, Math.min(this.limit(), extent)) });
    this.lifecycle?.onManipulate?.();
    this.apply();
  }

  private takeover(): void {
    this.resetScrollInput();
    this.dispatch({ type: "takeover" });
  }

  private readonly wheel = (event: WheelEvent) => {
    if (
      event.defaultPrevented ||
      this.isControl(event) ||
      this.drag ||
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
        ? Number.parseFloat(getComputedStyle(this.summary!).lineHeight) || 18
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? this.limit()
          : 1;
    const extent = this.extent();
    const next = Math.max(0, Math.min(this.limit(), extent - event.deltaY * unit));
    // The header is the only wheel target. Body and transcript scrolling stay native.
    event.preventDefault();
    // Accepted input owns the panel even when its extent is already clamped.
    this.move(next);
  };

  private readonly pointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || this.isControl(event) || event.defaultPrevented) {
      return;
    }
    this.suppressClick = false;
    this.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      extent: this.extent(),
      active: false,
    };
    this.summary?.setPointerCapture(event.pointerId);
  };

  private readonly pointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 3) {
        return;
      }
      if (Math.abs(dx) >= Math.abs(dy)) {
        this.cancelDrag();
        return;
      }
      this.takeover();
      drag.active = true;
      this.suppressClick = true;
    }
    event.preventDefault();
    const requested = drag.extent - dy;
    this.move(requested);
    // Discard excess travel at a hard boundary so reversal responds immediately.
    if (requested < 0 || requested > this.limit()) {
      drag.extent = this.extent();
      drag.y = event.clientY;
    }
  };

  private readonly otherPointer = (event: PointerEvent) => {
    if (this.drag && event.pointerId !== this.drag.id) {
      this.cancelDrag();
    }
  };

  private readonly pointerEnd = (event: PointerEvent) => {
    if (event.pointerId === this.drag?.id) {
      this.cancelDrag();
    }
  };

  private readonly cancelDrag = () => {
    const drag = this.drag;
    this.drag = undefined;
    if (drag && this.summary?.hasPointerCapture(drag.id)) {
      this.summary.releasePointerCapture(drag.id);
    }
  };

  dispose(): void {
    this.disposed = true;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = undefined;
    this.element.removeEventListener("click", this.click);
    this.disconnectHeader();
    this.resetScrollInput();
  }
}

class ProgressDisclosureDirective extends AsyncDirective {
  private controller: ProgressDisclosureController | undefined;
  private element: HTMLDetailsElement | undefined;
  private input: DisclosureInput | undefined;

  render(..._input: DisclosureInput) {
    return nothing;
  }

  override update(part: ElementPart, input: DisclosureInput) {
    if (part.element instanceof HTMLDetailsElement) {
      this.element = part.element;
      this.input = input;
      if (this.isConnected) {
        this.reconnected();
      }
    }
    return nothing;
  }

  protected override disconnected(): void {
    this.controller?.dispose();
    this.controller = undefined;
  }

  protected override reconnected(): void {
    if (this.element && this.input) {
      this.controller ??= new ProgressDisclosureController(this.element, this.input);
      this.controller.update(this.input);
    }
  }
}

export const composerDisclosure = directive(ProgressDisclosureDirective);
