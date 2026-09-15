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
  activeRunId?: string | null;
  completedRunId?: string | null;
  readingHistory?: boolean;
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

const manualChoicesByGateway = new WeakMap<object, Map<string, boolean>>();

class ProgressDisclosureController {
  private state: ProgressDisclosureState;
  private sessionKey: string;
  private gatewayScope: object | undefined;
  private transcript: HTMLElement | null = null;
  private unsubscribeTranscript: (() => void) | undefined;
  private disposed = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollSettled = false;
  private settleFrame: number | undefined;
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
    this.element.addEventListener("click", this.handleClick);
  }

  private mount([sessionKey, initialOpen, , lifecycle]: DisclosureInput): ProgressDisclosureState {
    this.resetScrollInput();
    this.settleWithoutTransition();
    return resolveProgressDisclosure(undefined, {
      type: "mount",
      open: initialOpen,
      manualOpen: this.gatewayScope
        ? manualChoicesByGateway.get(this.gatewayScope)?.get(sessionKey)
        : undefined,
      activeRunId: lifecycle?.activeRunId ?? null,
      completedRunId: lifecycle?.completedRunId ?? null,
      readingHistory: lifecycle?.readingHistory === true,
    });
  }

  update(input: DisclosureInput): void {
    const [sessionKey, , collapseByDefault, lifecycle] = input;
    if (sessionKey !== this.sessionKey || lifecycle?.gatewayScope !== this.gatewayScope) {
      this.sessionKey = sessionKey;
      this.gatewayScope = lifecycle?.gatewayScope;
      this.state = this.mount(input);
    }
    if (lifecycle?.activeRunId && lifecycle.activeRunId !== this.state.activeRunId) {
      this.resetScrollInput();
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
    this.element.open = this.state.open;
    // Lit attaches the surrounding transcript after committing this element part.
    queueMicrotask(() => this.connectTranscript());
  }

  private dispatch(event: ProgressDisclosureEvent): void {
    const previous = this.state;
    this.state = resolveProgressDisclosure(previous, event);
    if (!this.gatewayScope) {
      return;
    }
    if (event.type === "click") {
      const choices = manualChoicesByGateway.get(this.gatewayScope) ?? new Map<string, boolean>();
      choices.set(this.sessionKey, this.state.open);
      manualChoicesByGateway.set(this.gatewayScope, choices);
    } else if (event.type === "settle" && previous.open && !this.state.open) {
      manualChoicesByGateway.get(this.gatewayScope)?.delete(this.sessionKey);
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
      this.dispatch({ type: "gesture", distancePx: gesture.distancePx, newGesture: true });
    }
  }

  private settleDisclosure(): void {
    if (this.touching || this.scrolling) {
      return;
    }
    this.flushGesture();
    if (this.state.distancePx > 0) {
      this.dispatch({ type: "settle" });
      this.element.open = this.state.open;
    }
  }

  private readonly handleTranscriptScroll = (observation: TranscriptScrollObservation) => {
    this.touching = observation.touching;
    if (observation.type === "offset") {
      this.scrolling = observation.scrolling;
      if (!this.scrolling && this.scrollSettled) {
        this.settleDisclosure();
      }
      if (observation.programmatic || !this.gesture || observation.delta === 0) {
        return;
      }
      this.gesture.distancePx += Math.max(0, -observation.delta);
      this.scheduleCollapse();
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

  private readonly handleClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      !(event.target instanceof Element) ||
      event.target.closest("summary")?.parentElement !== this.element
    ) {
      return;
    }
    // Let native summary activation apply the toggle, including Enter and Space.
    this.resetScrollInput();
    this.dispatch({ type: "click", open: !this.element.open });
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

  private settleWithoutTransition(): void {
    if (this.settleFrame !== undefined) {
      cancelAnimationFrame(this.settleFrame);
    }
    this.element.classList.add("session-progress-card--settling");
    this.settleFrame = requestAnimationFrame(() => {
      this.settleFrame = requestAnimationFrame(() => {
        this.settleFrame = undefined;
        this.element.classList.remove("session-progress-card--settling");
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeTranscript?.();
    this.unsubscribeTranscript = undefined;
    this.element.removeEventListener("click", this.handleClick);
    this.resetScrollInput();
    if (this.settleFrame !== undefined) {
      cancelAnimationFrame(this.settleFrame);
    }
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
