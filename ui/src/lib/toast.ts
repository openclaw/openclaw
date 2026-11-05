import type { AgentIdentity } from "./identity-avatar-view.ts";
import { listen } from "./reactive/listener.ts";

type ToastDismissReason = "action" | "dismiss" | "disconnected" | "replaced" | "timeout";

/** One signal per variant: the leading icon's color. Neutral toasts explicitly use undefined. */
export type ToastSeverity = "success" | "info" | "warning" | "error" | "progress";

export type ToastOptions = {
  /** The title. Rich content lets a message name a destination the operator can actually
   * open, instead of spelling out a settings path the toast then makes them find. */
  message: string | Node;
  /** Muted second line, for the sentence that follows the title. */
  description?: string;
  /** Raw error shown only when expanded; redacted by the shared error renderer. */
  detail?: unknown;
  /** Positions a compact toast at the top center of the owning panel. */
  anchor?: Element;
  /** Top center answers what the operator just did; top right holds arrivals they did
   * not trigger (a background session, the Gateway, a queue). */
  placement?: ToastPlacement;
  /** Errors announce through role="alert"; every other variant uses role="status". */
  severity: ToastSeverity | undefined;
  /** Agent identity shown for session notifications, using the shared avatar loader. */
  avatar?: AgentIdentity;
  actionLabel?: string;
  actionHref?: string;
  /** Terracotta fill, reserved for the required next step (Review…, Try again). */
  actionPrimary?: boolean;
  onAction?: (event?: MouseEvent) => void;
  onDismiss?: (reason: ToastDismissReason) => void;
  durationMs?: number;
};

export type ToastPlacement = "top-center" | "top-right";
export type ToastLane = ToastPlacement | "anchored";
export const TOAST_LANES = ["top-center", "top-right"] as const satisfies ToastPlacement[];

/** One presented toast. Entries are immutable; a state change publishes a new one. */
export type ToastEntry = {
  readonly id: number;
  readonly options: ToastOptions;
  readonly lane: ToastLane;
  /** Position among the lane's live toasts, newest first. Absent while leaving. */
  readonly depth?: number;
  readonly active: boolean;
};

/** A collapsed lane shows this many toasts; later ones wait hidden and paused. */
export const TOAST_VISIBLE_LIMIT = 3;
const TOAST_DURATION_MS: Record<ToastSeverity | "neutral", number> = {
  neutral: 6_000,
  success: 6_000,
  info: 6_000,
  progress: 6_000,
  warning: 8_000,
  error: 10_000,
};
const TOAST_EXIT_MS = 200;
const ANCHORED_EXIT_FALLBACK_MS = 450;

export function resolveToastAnchorRect(anchor: Element | undefined) {
  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  return rect && rect.width > 0 ? rect : null;
}

function activeModalToastLayer() {
  const owner = [...(document.openClawModalLayers ?? [])]
    .findLast((candidate) => candidate.isConnected)
    ?.closest("openclaw-modal-dialog");
  const container = owner?.getOverlayContainer();
  return owner && container ? { owner, container } : undefined;
}

function restingToastLayer() {
  const connected = [...toastContainers].filter(([element]) => element.isConnected);
  return (
    connected.findLast(
      ([element, role]) => role === "drawer" && element.ariaModal === "true",
    )?.[0] ?? connected.findLast(([, role]) => role === "shell")?.[0]
  );
}

const toastContainers = new Map<HTMLElement, "shell" | "drawer">();
const connectedHosts = new Set<OpenClawToastHost>();

export function registerToastContainer(element: HTMLElement, role: "shell" | "drawer") {
  toastContainers.set(element, role);
  return () => toastContainers.delete(element);
}

// Outcomes reported during startup (a restored post-update result, for example)
// race the shell that owns the host element. Hold them instead of dropping them,
// so no caller's message disappears because it arrived too early.
const queuedToasts: ToastOptions[] = [];

type LiveToast = {
  id: number;
  options: ToastOptions;
  lane: ToastLane;
  remainingMs: number;
  deadline: number;
  timer?: ReturnType<typeof globalThis.setTimeout>;
  exitTimer?: ReturnType<typeof globalThis.setTimeout>;
  leaving: boolean;
};

let nextToastId = 1;

function toastLane(options: ToastOptions): ToastLane {
  return resolveToastAnchorRect(options.anchor) ? "anchored" : (options.placement ?? "top-center");
}

/** Keeps every toast's deadline, the lanes' open state and queued outcomes alive
 * across native host moves. Each lane stacks newest first; hover or focus opens it
 * and pauses its timers, and only the first three of a closed lane count down. */
class ToastOwner {
  constructor(private readonly host: OpenClawToastHost) {}
  private live: LiveToast[] = [];
  private readonly hovered = new Set<ToastLane>();
  private readonly focused = new Set<ToastLane>();
  private readonly lanes = new Map<ToastLane, HTMLElement>();
  private touchOpen: ToastLane | undefined;
  private stopTouchClose: (() => void) | undefined;
  private publishPending = false;
  private homeLayer: HTMLElement | undefined;
  private stopPlacementSync: (() => void) | undefined;

  laneElement(lane: ToastLane, element: HTMLElement | undefined) {
    if (element) {
      this.lanes.set(lane, element);
    } else {
      this.lanes.delete(lane);
    }
  }

  hover(lane: ToastLane, hovered: boolean) {
    this.setHeld(this.hovered, lane, hovered);
  }

  focus(lane: ToastLane, focused: boolean) {
    this.setHeld(this.focused, lane, focused);
  }

  /** Touch has no hover: a tap opens the stack, and a tap outside closes it. */
  touch(lane: ToastLane) {
    if (this.touchOpen === lane) {
      return;
    }
    this.closeTouch();
    this.touchOpen = lane;
    this.stopTouchClose = listen(this.host.ownerDocument, "pointerdown", (event) => {
      const element = this.lanes.get(lane);
      if (!(event.target instanceof Node && element?.contains(event.target))) {
        this.closeTouch();
        this.publish();
      }
    });
    this.publish();
  }

  private closeTouch() {
    this.stopTouchClose?.();
    this.stopTouchClose = undefined;
    this.touchOpen = undefined;
  }

  private setHeld(set: Set<ToastLane>, lane: ToastLane, held: boolean) {
    if (set.has(lane) === held) {
      return;
    }
    if (held) {
      set.add(lane);
    } else {
      set.delete(lane);
    }
    this.publish();
  }

  private laneHasFocus(lane: ToastLane) {
    const element = this.lanes.get(lane);
    const root = element?.getRootNode();
    const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
    return Boolean(element?.isConnected && active && element.contains(active));
  }

  private isOpen(lane: ToastLane) {
    return this.hovered.has(lane) || this.focused.has(lane) || this.touchOpen === lane;
  }

  connect() {
    connectedHosts.add(this.host);
    this.stopPlacementSync?.();
    this.stopPlacementSync = undefined;
    const inModal = Boolean(this.host.closest("openclaw-modal-dialog"));
    if (!inModal) {
      const parent = this.host.parentElement;
      // Document roots survive app teardown and must not resurrect removed hosts.
      this.homeLayer =
        parent !== this.host.ownerDocument.body &&
        parent !== this.host.ownerDocument.documentElement
          ? (parent ?? undefined)
          : undefined;
    }
    // Modal layers can be siblings of the shell. Keep its responsive chrome
    // offset while the host is away, then return to ordinary CSS inheritance.
    const homeLayer = this.homeLayer;
    if (inModal && homeLayer) {
      const syncPlacement = () =>
        this.host.style.setProperty(
          "--app-toast-shell-top",
          getComputedStyle(homeLayer).getPropertyValue("--app-toast-shell-top"),
        );
      syncPlacement();
      this.stopPlacementSync = listen(window, "resize", syncPlacement);
    } else {
      this.host.style.removeProperty("--app-toast-shell-top");
    }
    this.host.popover = "manual";
    this.host.dataset.toastPlacement = this.homeLayer?.matches(".shell") ? "shell" : "overlay";
    this.syncPresentation();
    // Moving the light-DOM host can drop focus and hover without leave events.
    this.focused.clear();
    for (const [lane, element] of this.lanes) {
      if (element.matches(":hover")) {
        this.hovered.add(lane);
      } else {
        this.hovered.delete(lane);
      }
    }
    this.publish();
    for (const pending of queuedToasts.splice(0)) {
      this.show(pending);
    }
  }

  disconnect() {
    // append() relocations reconnect before reactions run. Keep the notifications
    // and their deadlines; only a real removal dismisses or returns them from a modal.
    if (this.host.isConnected) {
      return;
    }
    this.stopPlacementSync?.();
    this.stopPlacementSync = undefined;
    connectedHosts.delete(this.host);
    if (this.host.closest("openclaw-modal-dialog") && this.restorePresentationLayer()) {
      return;
    }
    this.homeLayer = undefined;
    this.hovered.clear();
    this.focused.clear();
    this.closeTouch();
    for (const toast of this.live.slice()) {
      this.finish(toast, "disconnected");
    }
  }

  restorePresentationLayer(): boolean {
    // Native hosts can present a toast before their shell registers its layers.
    const target =
      activeModalToastLayer()?.container ??
      restingToastLayer() ??
      (this.homeLayer?.isConnected ? this.homeLayer : undefined);
    if (!target) {
      return false;
    }
    target.append(this.host);
    return true;
  }

  show(options: ToastOptions) {
    const lane = toastLane(options);
    // A panel holds one notice, and a repeated message restarts instead of stacking.
    for (const toast of this.live) {
      if (
        !toast.leaving &&
        toast.lane === lane &&
        (lane === "anchored" ||
          (typeof options.message === "string" && toast.options.message === options.message))
      ) {
        this.finish(toast, "replaced");
      }
    }
    this.live.unshift({
      id: nextToastId++,
      options,
      lane,
      remainingMs: options.durationMs ?? TOAST_DURATION_MS[options.severity ?? "neutral"],
      deadline: 0,
      leaving: false,
    });
    this.publish();
  }

  dismiss(id: number, reason: ToastDismissReason) {
    const toast = this.live.find((candidate) => candidate.id === id);
    if (!toast || toast.leaving) {
      return;
    }
    this.pause(toast);
    if (
      (reason !== "dismiss" && reason !== "timeout") ||
      !this.host.isConnected ||
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      this.finish(toast, reason);
      return;
    }
    toast.leaving = true;
    toast.exitTimer = globalThis.setTimeout(
      () => this.finish(toast, reason),
      toast.lane === "anchored" ? ANCHORED_EXIT_FALLBACK_MS : TOAST_EXIT_MS,
    );
    this.publish();
  }

  dismissAll(reason: ToastDismissReason) {
    for (const toast of this.live.slice()) {
      this.finish(toast, reason);
    }
  }

  /** The anchored exit transition ends before its fallback when motion runs. */
  transitionEnd(id: number) {
    const toast = this.live.find((candidate) => candidate.id === id);
    if (toast?.leaving) {
      this.finish(toast, "dismiss");
    }
  }

  private finish(toast: LiveToast, reason: ToastDismissReason) {
    if (!this.live.includes(toast)) {
      return;
    }
    this.pause(toast);
    globalThis.clearTimeout(toast.exitTimer);
    this.live = this.live.filter((candidate) => candidate !== toast);
    if (!this.live.some((candidate) => candidate.lane === toast.lane)) {
      this.hovered.delete(toast.lane);
      this.focused.delete(toast.lane);
      if (this.touchOpen === toast.lane) {
        this.closeTouch();
      }
    }
    toast.options.onDismiss?.(reason);
    this.publish();
  }

  private pause(toast: LiveToast) {
    if (toast.timer !== undefined) {
      toast.remainingMs = Math.max(0, toast.deadline - performance.now());
      globalThis.clearTimeout(toast.timer);
      toast.timer = undefined;
    }
  }

  /** Only the first three toasts of a closed lane count down; an open lane holds all. */
  private syncTimers() {
    if (!this.host.isConnected) {
      return;
    }
    const depth = new Map<ToastLane, number>();
    for (const toast of this.live) {
      if (toast.leaving) {
        continue;
      }
      const index = depth.get(toast.lane) ?? 0;
      depth.set(toast.lane, index + 1);
      if (this.isOpen(toast.lane) || index >= TOAST_VISIBLE_LIMIT) {
        this.pause(toast);
      } else if (toast.timer === undefined) {
        toast.deadline = performance.now() + toast.remainingMs;
        toast.timer = globalThis.setTimeout(() => {
          toast.timer = undefined;
          this.dismiss(toast.id, "timeout");
        }, toast.remainingMs);
      }
    }
  }

  private publish() {
    const depth = new Map<ToastLane, number>();
    this.host.toasts = this.live.map((toast) => {
      if (toast.leaving) {
        return { id: toast.id, options: toast.options, lane: toast.lane, active: false };
      }
      const index = depth.get(toast.lane) ?? 0;
      depth.set(toast.lane, index + 1);
      return { id: toast.id, options: toast.options, lane: toast.lane, depth: index, active: true };
    });
    this.host.open = TOAST_LANES.filter((lane) => this.isOpen(lane));
    this.syncTimers();
  }

  private syncPresentation() {
    if (!this.host.isConnected) {
      return;
    }
    // Stay inside the modal's non-inert subtree, but escape its transformed
    // containing block so fixed toast coordinates still refer to the viewport.
    if (this.host.toasts.length > 0) {
      this.host.showPopover();
    } else {
      this.host.hidePopover();
    }
  }

  afterPropertyChange() {
    if (this.publishPending) {
      return;
    }
    this.publishPending = true;
    queueMicrotask(() => {
      void this.host.updateComplete.then(() => {
        this.publishPending = false;
        this.syncPresentation();
        // Removing a focused toast moves focus without a focusout event.
        const lost = [...this.focused].filter((lane) => !this.laneHasFocus(lane));
        if (lost.length > 0) {
          for (const lane of lost) {
            this.focused.delete(lane);
          }
          this.publish();
        }
      });
    });
  }
}

export type ToastProperties = { toasts: readonly ToastEntry[]; open: readonly ToastPlacement[] };
export type ToastMethods = { show(options: ToastOptions): void };
type OpenClawToastHost = HTMLElement &
  ToastProperties &
  ToastMethods & {
    readonly updateComplete: Promise<boolean>;
  };
const owners = new WeakMap<OpenClawToastHost, ToastOwner>();
export function toastOwnerFor(host: OpenClawToastHost) {
  let owner = owners.get(host);
  if (!owner) {
    owner = new ToastOwner(host);
    owners.set(host, owner);
  }
  return owner;
}

export function showToast(options: ToastOptions): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const host = [...connectedHosts].find((candidate) => candidate.isConnected);
  if (!host) {
    queuedToasts.push(options);
    return false;
  }
  const modal = activeModalToastLayer();
  if (modal && host.parentElement !== modal.container) {
    modal.container.append(host);
    const handoff = (event: Event) => {
      if (event.target !== modal.owner) {
        return;
      }
      stopHandoff();
      queueMicrotask(() => toastOwnerFor(host).restorePresentationLayer());
    };
    const stopHandoff = listen(modal.owner, "overlay-after-hide", handoff);
  }
  host.show(options);
  return true;
}
