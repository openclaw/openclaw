import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";

type ToastDismissReason =
  | "action"
  | "cancelled"
  | "dismiss"
  | "disconnected"
  | "replaced"
  | "timeout";

export type ToastOptions = {
  /** A template lets a message name a destination the operator can actually open,
   * instead of spelling out a settings path the toast then makes them find. */
  message: string | TemplateResult;
  /** A heading gives notifications a compact card with a separate action row. */
  title?: string | TemplateResult;
  /** Retire transient notifications when their owning view or access changes. */
  signal?: AbortSignal;
  /** Positions a compact toast at the top center of the owning surface. */
  anchor?: Element;
  anchorTopOffset?: number;
  /** Bottom placement suits settings feedback without covering the page heading. */
  placement?: "top" | "bottom";
  icon?: TemplateResult;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: (reason: ToastDismissReason) => void;
  durationMs?: number;
  /** Wait behind the active toast instead of replacing it. */
  fifo?: boolean;
};

const DEFAULT_TOAST_DURATION_MS = 6_000;
const TOAST_EXIT_FALLBACK_MS = 450;

function resolveToastAnchorRect(anchor: Element | undefined) {
  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  return rect && rect.width > 0 ? rect : null;
}

function activeModalToastLayer() {
  return [...(document.openClawModalLayers ?? [])].findLast((candidate) => candidate.isConnected);
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

class OpenClawToastHost extends OpenClawLightDomContentsElement {
  @state() private toast: ToastOptions | null = null;
  @state() private active = false;
  private readonly toastQueue: { options: ToastOptions; abort: () => void }[] = [];
  private dismissTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private exitTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private exitReason: ToastDismissReason | null = null;
  private remainingMs = 0;
  private deadline = 0;
  private hovered = false;
  private renderToast?: typeof import("./toast-view.ts").renderToast;
  private viewLoadFailed = false;
  private visibleToast: ToastOptions | null = null;

  protected override async scheduleUpdate() {
    if (this.toast && !this.renderToast && !this.viewLoadFailed) {
      try {
        this.renderToast = (await import("./toast-view.ts")).renderToast;
      } catch {
        this.viewLoadFailed = true;
      }
    }
    // Read live state in render(), never the toast that began the import.
    await super.scheduleUpdate();
  }

  private syncPlacement() {
    this.dataset.toastPlacement = this.parentElement?.matches(".shell") ? "shell" : "overlay";
  }

  override connectedCallback() {
    super.connectedCallback();
    this.syncPlacement();
    // Moving the light-DOM host can drop focus without a focusout event.
    this.hovered = this.querySelector(".app-toast")?.matches(":hover") ?? false;
    this.syncDismissTimer();
    const pending = queuedToast;
    queuedToast = null;
    if (pending) {
      this.show(pending);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    // append() relocations reconnect before reactions run. Keep the notification
    // and its deadline; only a real removal dismisses or returns it from a modal.
    if (this.isConnected) {
      return;
    }
    const target = activeModalToastLayer() ?? restingToastLayer();
    if (this.parentElement?.localName === "openclaw-modal-dialog" && target) {
      target.append(this);
    } else {
      this.dismiss("disconnected");
    }
  }

  private readonly abortActive = () => this.dismiss("cancelled");

  show(options: ToastOptions) {
    if (options.signal?.aborted) {
      options.onDismiss?.("cancelled");
      return;
    }
    if (options.fifo && this.toast) {
      const pending = {
        options,
        abort: () => {
          const index = this.toastQueue.indexOf(pending);
          if (index >= 0) {
            this.toastQueue.splice(index, 1);
            options.onDismiss?.("cancelled");
          }
        },
      };
      this.toastQueue.push(pending);
      options.signal?.addEventListener("abort", pending.abort, { once: true });
      return;
    }
    // A replacement keeps FIFO entries queued even when the old toast is exiting.
    this.finishDismiss(this.exitReason ?? "replaced", false);
    this.toast = options;
    this.viewLoadFailed = false;
    options.signal?.addEventListener("abort", this.abortActive, { once: true });
    this.active = true;
    this.exitReason = null;
    this.remainingMs = options.durationMs ?? DEFAULT_TOAST_DURATION_MS;
  }

  override updated() {
    // Lit can retain a focused child on replacement, or remove the action that
    // held focus. Reconcile after rendering rather than inheriting stale focus.
    if (!this.toast) {
      this.hovered = false;
    }
    this.visibleToast = this.renderToast ? this.toast : null;
    this.syncDismissTimer();
  }

  private syncDismissTimer(focused?: boolean) {
    if (!this.toast || this.visibleToast !== this.toast || !this.active || !this.isConnected) {
      return;
    }
    const root = this.getRootNode();
    const active =
      root instanceof ShadowRoot ? root.activeElement : this.ownerDocument.activeElement;
    const hasFocus = focused ?? this.contains(active);
    if (this.hovered || hasFocus) {
      if (this.dismissTimer !== null) {
        this.remainingMs = Math.max(0, this.deadline - performance.now());
        globalThis.clearTimeout(this.dismissTimer);
        this.dismissTimer = null;
      }
    } else if (this.dismissTimer === null) {
      this.deadline = performance.now() + this.remainingMs;
      this.dismissTimer = globalThis.setTimeout(() => this.dismiss("timeout"), this.remainingMs);
    }
  }

  private clearDismissTimer() {
    if (this.dismissTimer !== null) {
      globalThis.clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    if (this.exitTimer !== null) {
      globalThis.clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
  }

  private finishDismiss(reason: ToastDismissReason, promoteNext = true) {
    const toast = this.toast;
    toast?.signal?.removeEventListener("abort", this.abortActive);
    this.clearDismissTimer();
    this.active = false;
    this.exitReason = null;
    this.toast = null;
    this.visibleToast = null;
    toast?.onDismiss?.(reason);
    if (reason === "disconnected") {
      this.hovered = false;
      const queued = this.toastQueue.splice(0);
      for (const pending of queued) {
        pending.options.signal?.removeEventListener("abort", pending.abort);
        pending.options.onDismiss?.("disconnected");
      }
    } else if (promoteNext) {
      while (this.toastQueue.length) {
        const next = this.toastQueue.shift()!;
        next.options.signal?.removeEventListener("abort", next.abort);
        if (next.options.signal?.aborted) {
          next.options.onDismiss?.("cancelled");
          continue;
        }
        this.show(next.options);
        break;
      }
    }
  }

  private dismiss(reason: ToastDismissReason) {
    const toast = this.toast;
    if (!toast) {
      return;
    }
    this.clearDismissTimer();
    if (
      (reason !== "dismiss" && reason !== "timeout") ||
      !this.isConnected ||
      this.visibleToast !== toast ||
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
      (!toast.title && !resolveToastAnchorRect(toast.anchor))
    ) {
      this.finishDismiss(reason);
      return;
    }
    this.active = false;
    this.exitReason = reason;
    this.exitTimer = globalThis.setTimeout(() => {
      if (this.toast === toast) {
        this.finishDismiss(reason);
      }
    }, TOAST_EXIT_FALLBACK_MS);
  }

  override render() {
    const toast = this.toast;
    if (!toast) {
      return nothing;
    }
    if (!this.renderToast) {
      // Retain the original outcome and FIFO queue until the operator can load
      // the view. The failure notice never consumes the outcome's duration.
      return html`<div class="app-toast" role="status" aria-live="polite">
        <span class="app-toast__message">${t("lazyView.staleTitle")}</span>
        <button
          type="button"
          class="app-toast__action"
          @click=${() => {
            this.viewLoadFailed = false;
            this.requestUpdate();
          }}
        >
          ${t("common.retry")}
        </button>
        <button type="button" class="app-toast__dismiss" @click=${() => this.dismiss("dismiss")}>
          ${t("common.dismiss")}
        </button>
      </div>`;
    }
    return this.renderToast(toast, this.active, resolveToastAnchorRect(toast.anchor), {
      action: () => {
        this.dismiss("action");
        toast.onAction?.();
      },
      dismiss: () => this.dismiss("dismiss"),
      hover: (hovered) => {
        this.hovered = hovered;
        this.syncDismissTimer();
      },
      focus: (focused) => this.syncDismissTimer(focused),
      focusOut: (event) => {
        // relatedTarget keeps transfers between Undo, links, and Dismiss paused.
        this.syncDismissTimer(
          event.relatedTarget instanceof Node && this.contains(event.relatedTarget),
        );
      },
      transitionEnd: (event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === "opacity" &&
          !this.active &&
          this.exitReason
        ) {
          this.finishDismiss(this.exitReason);
        }
      },
    });
  }
}

export function showToast(options: ToastOptions): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const host = document.querySelector<OpenClawToastHost>("openclaw-toast-host");
  if (!host) {
    queuedToast = options;
    return false;
  }
  const modal = activeModalToastLayer();
  if (modal && host.parentElement !== modal) {
    modal.append(host);
    const handoff = (event: Event) => {
      if (event.target !== modal) {
        return;
      }
      modal.removeEventListener("wa-after-hide", handoff);
      queueMicrotask(() => (activeModalToastLayer() ?? restingToastLayer())?.append(host));
    };
    modal.addEventListener("wa-after-hide", handoff);
  }
  host.show(options);
  return true;
}

// Guarded so DOM-free (node) consumers of send-failure surfacing can load this module.
if (typeof customElements !== "undefined" && !customElements.get("openclaw-toast-host")) {
  customElements.define("openclaw-toast-host", OpenClawToastHost);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-toast-host": OpenClawToastHost;
  }
}
