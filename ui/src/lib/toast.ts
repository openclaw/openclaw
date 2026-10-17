import type { IconName } from "../components/solid/icon.tsx";
import type { AgentIdentity } from "./identity-avatar-view.ts";
import { listen } from "./reactive/listener.ts";

export type ToastDismissReason = "action" | "dismiss" | "disconnected" | "replaced" | "timeout";

export type ToastOptions = {
  /** Rich content lets a message name a destination the operator can actually open,
   * instead of spelling out a settings path the toast then makes them find. */
  message: string | Node;
  /** Positions a compact toast at the top center of the owning surface. */
  anchor?: Element;
  /** Bottom placement suits settings feedback without covering the page heading. */
  placement?: "top" | "bottom";
  icon?: IconName;
  /** Agent identity shown for session notifications, using the shared avatar loader. */
  avatar?: AgentIdentity;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: (reason: ToastDismissReason) => void;
  durationMs?: number;
  /** Wait behind the active toast instead of replacing it. */
  fifo?: boolean;
};

const DEFAULT_TOAST_DURATION_MS = 6_000;
const TOAST_EXIT_FALLBACK_MS = 450;

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
  return (
    document.querySelector(".shell-nav[aria-modal='true']") ?? document.querySelector(".shell")
  );
}

// Outcomes reported during startup (a restored post-update result, for example)
// race the shell that owns the host element. Hold the latest one instead of
// dropping it, so no caller's message disappears because it arrived too early.
let queuedToast: ToastOptions | null = null;

/** Keeps deadlines and queued outcomes alive across native host moves. */
class ToastOwner {
  constructor(private readonly host: OpenClawToastHost) {}
  body: HTMLElement | undefined;
  private readonly toastQueue: ToastOptions[] = [];
  private dismissTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private exitTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private exitReason: ToastDismissReason | null = null;
  private remainingMs = 0;
  private deadline = 0;
  private hovered = false;

  hover(hovered: boolean) {
    this.hovered = hovered;
    this.syncDismissTimer();
  }

  transitionEnd() {
    if (!this.host.active && this.exitReason) {
      this.finishDismiss(this.exitReason);
    }
  }

  connect() {
    this.host.style.display = "contents";
    this.host.dataset.toastPlacement = this.host.parentElement?.matches(".shell")
      ? "shell"
      : "overlay";
    // Moving the light-DOM host can drop focus without a focusout event.
    this.hovered = this.body?.matches(":hover") ?? false;
    this.syncDismissTimer();
    const pending = queuedToast;
    queuedToast = null;
    if (pending) {
      this.show(pending);
    }
  }

  disconnect() {
    // append() relocations reconnect before reactions run. Keep the notification
    // and its deadline; only a real removal dismisses or returns it from a modal.
    if (this.host.isConnected) {
      return;
    }
    const target = activeModalToastLayer()?.container ?? restingToastLayer();
    if (this.host.closest("openclaw-modal-dialog") && target) {
      target.append(this.host);
    } else {
      this.dismiss("disconnected");
    }
  }

  show(options: ToastOptions) {
    if (options.fifo && this.host.toast) {
      this.toastQueue.push(options);
      return;
    }
    this.finishDismiss(this.exitReason ?? "replaced");
    this.host.toast = options;
    this.host.active = true;
    this.exitReason = null;
    this.remainingMs = options.durationMs ?? DEFAULT_TOAST_DURATION_MS;
    this.syncDismissTimer();
  }

  syncDismissTimer(focused?: boolean) {
    if (!this.host.toast || !this.host.active || !this.host.isConnected) {
      return;
    }
    const root = this.host.getRootNode();
    const active =
      root instanceof ShadowRoot ? root.activeElement : this.host.ownerDocument.activeElement;
    const hasFocus = focused ?? this.host.contains(active);
    if (this.hovered || hasFocus) {
      if (this.dismissTimer !== undefined) {
        this.remainingMs = Math.max(0, this.deadline - performance.now());
        globalThis.clearTimeout(this.dismissTimer);
        this.dismissTimer = undefined;
      }
    } else if (this.dismissTimer === undefined) {
      this.deadline = performance.now() + this.remainingMs;
      this.dismissTimer = globalThis.setTimeout(() => this.dismiss("timeout"), this.remainingMs);
    }
  }

  private clearDismissTimer() {
    for (const key of ["dismissTimer", "exitTimer"] as const) {
      globalThis.clearTimeout(this[key]);
      this[key] = undefined;
    }
  }

  finishDismiss(reason: ToastDismissReason) {
    const toast = this.host.toast;
    this.clearDismissTimer();
    this.host.active = false;
    this.exitReason = null;
    this.host.toast = null;
    toast?.onDismiss?.(reason);
    if (reason === "disconnected") {
      this.hovered = false;
      for (const pending of this.toastQueue.splice(0)) {
        pending.onDismiss?.("disconnected");
      }
    } else if (reason !== "replaced") {
      const next = this.toastQueue.shift();
      if (next) {
        this.show(next);
      }
    }
  }

  dismiss(reason: ToastDismissReason) {
    const toast = this.host.toast;
    if (!toast) {
      return;
    }
    this.clearDismissTimer();
    if (
      (reason !== "dismiss" && reason !== "timeout") ||
      !this.host.isConnected ||
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
      !resolveToastAnchorRect(toast.anchor)
    ) {
      this.finishDismiss(reason);
      return;
    }
    this.host.active = false;
    this.exitReason = reason;
    this.exitTimer = globalThis.setTimeout(() => {
      if (this.host.toast === toast) {
        this.finishDismiss(reason);
      }
    }, TOAST_EXIT_FALLBACK_MS);
  }
}

export type ToastProperties = { toast: ToastOptions | null; active: boolean };
export type ToastMethods = { show(options: ToastOptions): void };
type OpenClawToastHost = HTMLElement & ToastProperties & ToastMethods;
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
  // A modal can carry the host into a shadow root, outside document queries.
  const host =
    document.querySelector<OpenClawToastHost>("openclaw-toast-host") ??
    [...(document.openClawModalLayers ?? [])]
      .map((layer) => layer.querySelector<OpenClawToastHost>("openclaw-toast-host"))
      .find((candidate) => candidate?.isConnected);
  if (!host) {
    queuedToast = options;
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
      queueMicrotask(() =>
        (activeModalToastLayer()?.container ?? restingToastLayer())?.append(host),
      );
    };
    const stopHandoff = listen(modal.owner, "overlay-after-hide", handoff);
  }
  host.show(options);
  return true;
}
