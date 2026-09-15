import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
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

type TouchScrollGesture = {
  contactIds: Set<number>;
  multipleContacts: boolean;
  recognized: boolean;
  startY: number;
  lastY: number;
  distancePx: number;
};

const manualChoicesByGateway = new WeakMap<object, Map<string, boolean>>();

class ProgressDisclosureController {
  private state: ProgressDisclosureState;
  private sessionKey: string;
  private gatewayScope: object | undefined;
  private transcript: HTMLElement | null = null;
  private listeners = new AbortController();
  private disposed = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollSettled = false;
  private settleFrame: number | undefined;
  private lastWheelAt: number | undefined;
  private wheelGestureCounted = false;
  private touchGesture: TouchScrollGesture | undefined;

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
    this.wheelGestureCounted = false;
    this.touchGesture = undefined;
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

  private settleDisclosure(): void {
    if (this.touchGesture) {
      return;
    }
    this.dispatch({ type: "settle" });
    this.element.open = this.state.open;
  }

  private readonly handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey) {
      return;
    }
    // Some browsers adjust delta units when deltaMode is first read.
    const { deltaMode, deltaY } = event;
    this.scheduleCollapse();
    const now = performance.now();
    if (
      this.lastWheelAt === undefined ||
      now - this.lastWheelAt > PROGRESS_DISCLOSURE.gesturePauseMs
    ) {
      this.wheelGestureCounted = false;
    }
    this.lastWheelAt = now;
    if (deltaY < 0) {
      const newGesture = !this.wheelGestureCounted;
      this.wheelGestureCounted = true;
      let unitPx = 1;
      if (deltaMode === WheelEvent.DOM_DELTA_LINE && this.transcript) {
        const style = getComputedStyle(this.transcript);
        unitPx = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize);
      } else if (deltaMode === WheelEvent.DOM_DELTA_PAGE && this.transcript) {
        unitPx = this.transcript.clientHeight;
      }
      this.dispatch({ type: "gesture", distancePx: -deltaY * unitPx, newGesture });
    }
  };

  private readonly handleTouchStart = (event: TouchEvent) => {
    const contact = event.changedTouches[0];
    if (!contact) {
      return;
    }
    const gesture = (this.touchGesture ??= {
      contactIds: new Set<number>(),
      multipleContacts: false,
      recognized: false,
      startY: contact.clientY,
      lastY: contact.clientY,
      distancePx: 0,
    });
    for (const touch of event.changedTouches) {
      gesture.contactIds.add(touch.identifier);
    }
    gesture.multipleContacts ||= event.touches.length > 1;
  };

  private readonly handleTouchEnd = (event: TouchEvent) => {
    const gesture = this.touchGesture;
    if (!gesture) {
      return;
    }
    for (const touch of event.changedTouches) {
      gesture.contactIds.delete(touch.identifier);
    }
    if (gesture.contactIds.size > 0) {
      return;
    }
    this.touchGesture = undefined;
    if (
      event.type === "touchend" &&
      event.touches.length === 0 &&
      !gesture.multipleContacts &&
      gesture.recognized
    ) {
      this.dispatch({ type: "gesture", distancePx: gesture.distancePx, newGesture: true });
    }
    if (this.scrollSettled) {
      this.settleDisclosure();
    }
  };

  private readonly handleTouchMove = (event: TouchEvent) => {
    const gesture = this.touchGesture;
    const contact = event.touches[0];
    if (!gesture || !contact) {
      return;
    }
    gesture.multipleContacts ||= event.touches.length > 1;
    if (gesture.multipleContacts) {
      return;
    }
    this.scheduleCollapse();
    const y = contact.clientY;
    gesture.distancePx += Math.max(0, y - gesture.lastY);
    gesture.lastY = y;
    gesture.recognized ||= y - gesture.startY > PROGRESS_DISCLOSURE.touchGesturePx;
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
    this.listeners.abort();
    this.listeners = new AbortController();
    this.transcript = transcript;
    const options = { passive: true, signal: this.listeners.signal };
    transcript?.addEventListener("wheel", this.handleWheel, options);
    transcript?.addEventListener("touchstart", this.handleTouchStart, options);
    transcript?.addEventListener("touchmove", this.handleTouchMove, options);
    transcript?.addEventListener("touchend", this.handleTouchEnd, options);
    transcript?.addEventListener("touchcancel", this.handleTouchEnd, options);
    transcript?.addEventListener("scroll", this.scheduleCollapse, options);
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
    this.listeners.abort();
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
