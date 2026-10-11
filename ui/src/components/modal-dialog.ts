import type { JSX as SolidJSX } from "@solidjs/web";
import { createComponent, createEffect, onSettled, untrack } from "solid-js";
import { acquireNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { composedParent } from "../lib/navigation-click.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { createOverlay, findOverlayParent } from "./overlay-lifecycle.ts";
import { containsComposed } from "./overlay-registry.ts";
import { ModalDialogContent } from "./solid/modal-dialog.tsx";
import { retainShadowStyles } from "./solid/shadow-styles.ts";
import modalStyles from "./solid/modal-dialog.css?inline";
import modalScrollLockStyles from "./solid/modal-scroll-lock.css?inline";
import overlayStyles from "./solid/overlay.css?inline";

export type ModalDialogProperties = {
  open: boolean;
  manual: boolean;
  label: string;
  description: string;
  onOpenChange: ((open: boolean) => void) | undefined;
};

type ModalDialogMethods = {
  show(): void;
  hide(): void;
  setReturnFocusTarget(target: HTMLElement | null): void;
  getOverlayContainer(): HTMLElement | null;
};

export type OpenClawModalDialog = SolidBridgeElement<ModalDialogProperties, ModalDialogMethods>;

type ModalDialogAttributes = SolidJSX.HTMLAttributes<OpenClawModalDialog> & {
  label: string;
  manual?: boolean;
  description?: string;
  "onModal-cancel"?: (event: Event) => void;
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-modal-dialog": ModalDialogAttributes;
    }
  }
}

type ModalState = {
  policy?: ModalPolicy;
  returnTarget?: { value: HTMLElement | null };
};
const states = new WeakMap<OpenClawModalDialog, ModalState>();
function stateFor(host: OpenClawModalDialog): ModalState {
  let state = states.get(host);
  if (!state) {
    state = {};
    states.set(host, state);
  }
  return state;
}

const scrollLocks = new WeakMap<Document, Set<HTMLElement>>();

function setModalLayer(host: HTMLElement, open: boolean) {
  const doc = host.ownerDocument;
  const layers = (doc.openClawModalLayers ??= new Set<HTMLElement>());
  const wasOpen = layers.size > 0;
  layers.delete(host);
  if (open) {
    layers.add(host);
  }
  if (wasOpen !== layers.size > 0) {
    doc.defaultView?.dispatchEvent(
      new CustomEvent("openclaw:native-modal-state", { detail: { open: layers.size > 0 } }),
    );
  }
}

function acquirePresentation(host: HTMLElement): () => void {
  const doc = host.ownerDocument;
  const releaseScrollLockStyles = retainShadowStyles(doc, [modalScrollLockStyles]);
  let locks = scrollLocks.get(doc);
  if (!locks) {
    locks = new Set();
    scrollLocks.set(doc, locks);
  }
  locks.add(host);
  if (locks.size === 1) {
    const gutter = (doc.defaultView?.innerWidth ?? 0) - doc.documentElement.clientWidth;
    doc.documentElement.classList.toggle("oc-modal-scroll-gutter", gutter > 1);
  }
  doc.documentElement.classList.add("oc-modal-scroll-lock");
  const releaseOcclusion = acquireNativeOverlayOcclusion();
  return () => {
    releaseOcclusion();
    locks.delete(host);
    if (locks.size === 0) {
      doc.documentElement.classList.remove("oc-modal-scroll-lock");
      doc.documentElement.classList.remove("oc-modal-scroll-gutter");
    }
    releaseScrollLockStyles();
  };
}

function isHtmlElement(value: EventTarget | null): value is HTMLElement {
  // Namespace survives document adoption; realm-specific constructors do not.
  return (
    value !== null &&
    "namespaceURI" in value &&
    value.namespaceURI === "http://www.w3.org/1999/xhtml"
  );
}

function activeElement(host: HTMLElement): HTMLElement | null {
  const view = host.ownerDocument.defaultView;
  const root = host.getRootNode();
  let active =
    (root instanceof ShadowRoot || (view && root instanceof view.ShadowRoot)
      ? root.activeElement
      : null) ?? host.ownerDocument.activeElement;
  while (isHtmlElement(active) && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return isHtmlElement(active) ? active : null;
}

function restoreFocus(target: HTMLElement) {
  target.focus({ preventScroll: true });
  target.dispatchEvent(new Event("openclaw:restore-focus"));
}

function isInert(target: Element): boolean {
  for (let element: Element | null = target; element; element = composedParent(element)) {
    if (element.hasAttribute("inert")) {
      return true;
    }
  }
  return false;
}

type ModalPolicy = {
  request(open: boolean): void;
  setReturnFocusTarget(target: HTMLElement | null): void;
  getOverlayContainer(): HTMLElement | null;
  bindDialog: (element: HTMLDialogElement) => void;
  bindOverlayContainer: (element: HTMLElement) => void;
  connect(): void;
  disconnect(): void;
};

function createModalPolicy(host: OpenClawModalDialog, props: ModalDialogProperties): ModalPolicy {
  let dialog!: HTMLDialogElement;
  let mounted = false;
  let disposed = false;
  let detaching = false;
  let overlayContainer: HTMLElement | null = null;
  let programmatic = false;
  let dismissing = false;
  let returnFocus: HTMLElement | null = null;
  let returnOverride: HTMLElement | null | undefined;
  let returnFocusPending = false;
  let openingInteraction = false;
  let initialFocusPending = false;
  let focusBeforeChrome: HTMLElement | null = null;
  let reportedOpen = false;
  let publication = 0;
  let focusReturnVersion = 0;

  const focusInitialContent = (initial = false) => {
    if (!host.isConnected || !dialog.open) {
      return;
    }
    const active = activeElement(host);
    const autofocus = dialog.querySelector<HTMLElement>("[autofocus]");
    if (
      active &&
      active !== dialog &&
      containsComposed(dialog, active) &&
      (!initial || !autofocus || active === autofocus)
    ) {
      return;
    }
    const target =
      focusBeforeChrome?.isConnected && containsComposed(dialog, focusBeforeChrome)
        ? focusBeforeChrome
        : (autofocus ?? dialog);
    target.focus({ preventScroll: true });
  };

  const clearReturnFocus = () => {
    returnFocus = null;
    returnOverride = undefined;
    returnFocusPending = false;
  };

  const restoreReturnFocus = () => {
    if (dialog.open) {
      return;
    }
    const target = returnOverride === undefined ? returnFocus : returnOverride;
    const original = returnFocus;
    const suppressed = returnOverride === null;
    const active = activeElement(host);
    const mayRestore =
      !active ||
      active === host.ownerDocument.body ||
      active === host.ownerDocument.documentElement ||
      active === returnFocus ||
      containsComposed(dialog, active);
    if (suppressed && active === original) {
      original?.blur();
    }
    if (!target?.isConnected || !mayRestore) {
      clearReturnFocus();
      return;
    }
    if (!isInert(target) && !target.matches(":disabled")) {
      clearReturnFocus();
      restoreFocus(target);
      return;
    }
    // Teardown can take over before the containing render makes the target focusable.
    returnFocusPending = true;
    const version = ++focusReturnVersion;
    const connected = host.isConnected;
    // A containing render may enable the target or release inertness after removal.
    queueMicrotask(() => {
      if (version !== focusReturnVersion || host.isConnected !== connected || dialog.open) {
        return;
      }
      if (!target.isConnected || activeElement(host) !== active) {
        clearReturnFocus();
        return;
      }
      if (!isInert(target) && !target.matches(":disabled")) {
        clearReturnFocus();
        restoreFocus(target);
      }
    });
  };

  const finishInitialFocus = () => {
    if (initialFocusPending) {
      focusInitialContent(!openingInteraction);
      initialFocusPending = false;
    }
  };

  const overlay = createOverlay("modal-dialog", undefined, {
    onRootChange: (root) => retainShadowStyles(root, [overlayStyles, modalStyles]),
    native: {
      isOpen: () => dialog.open,
      show: () => {
        focusReturnVersion += 1;
        // Reversing a pending close preserves the native dialog's original opener.
        if (!dialog.open) {
          if (returnFocusPending) {
            clearReturnFocus();
          }
          returnFocus = activeElement(host);
          if (returnFocus) {
            overlay.setReturnTarget(returnFocus);
          }
        }
        openingInteraction = false;
        initialFocusPending = true;
        focusBeforeChrome = null;
        dialog.showModal();
        // Native focus can reconcile this opening before request() resumes.
        if (overlay.open) {
          finishInitialFocus();
        }
      },
      hide: () => dialog.close(),
    },
    dismissOutsidePointer: false,
    dismissOutsideFocus: false,
    dismissEscape: false,
    onInitialFocus: finishInitialFocus,
    acquireOcclusion: () => acquirePresentation(host),
  });

  const publishOpen = (open: boolean, force = false) => {
    if (detaching || disposed || !host.isConnected) {
      return;
    }
    host.open = open;
    if (!force && reportedOpen === open) {
      return;
    }
    reportedOpen = open;
    publication += 1;
    untrack(() => props.onOpenChange?.(open));
  };

  const request = (next: boolean, controlled = true) => {
    if (disposed || (!next && dismissing)) {
      return;
    }
    if (!mounted || !host.isConnected) {
      host.open = next;
      return;
    }
    if (next) {
      overlay.setParent(findOverlayParent(host));
    }
    const previousProgrammatic = programmatic;
    programmatic = controlled;
    const beforePublication = publication;
    try {
      const accepted = overlay.request(next, next ? "first" : "none");
      if (beforePublication === publication) {
        publishOpen(overlay.open, !accepted && overlay.open !== next);
      }
    } finally {
      programmatic = previousProgrammatic;
    }
  };
  const policy: ModalPolicy = {
    request,
    setReturnFocusTarget(target) {
      if (returnFocusPending) {
        focusReturnVersion += 1;
        clearReturnFocus();
      }
      returnOverride = target;
    },
    getOverlayContainer: () => overlayContainer,
    bindDialog(element) {
      dialog = element;
    },
    bindOverlayContainer(element) {
      overlayContainer = element;
    },
    connect() {
      focusReturnVersion += 1;
      if (returnFocusPending) {
        clearReturnFocus();
      }
      request(host.open);
    },
    disconnect() {
      focusReturnVersion += 1;
      detaching = true;
      try {
        overlay.retire();
        setModalLayer(host, false);
        restoreReturnFocus();
      } finally {
        detaching = false;
      }
    },
  };
  const state = stateFor(host);
  state.policy = policy;

  createEffect(
    () => props.open,
    (open) => {
      if (mounted) {
        request(open);
      }
    },
  );

  const dispatch = (type: string, cancelable = false) =>
    host.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, cancelable }));

  const beforeShow = (event: Event) => {
    if (event.target === dialog) {
      event.stopPropagation();
      if (!dispatch("wa-show", true)) {
        event.preventDefault();
      }
    }
  };
  const beforeHide = (event: Event) => {
    if (event.target !== dialog) {
      return;
    }
    event.stopPropagation();
    dismissing = true;
    try {
      if (!programmatic && !detaching && event.cancelable) {
        const cancel = new CustomEvent("modal-cancel", {
          bubbles: true,
          composed: true,
          cancelable: true,
        });
        if (!host.dispatchEvent(cancel)) {
          event.preventDefault();
        }
      }
      if (!dispatch("wa-hide", event.cancelable)) {
        event.preventDefault();
      }
    } finally {
      dismissing = false;
    }
  };
  const afterShow = (event: Event) => {
    if (event.target === dialog) {
      event.stopPropagation();
      focusInitialContent();
      dispatch("wa-after-show");
    }
  };
  const afterHide = (event: Event) => {
    if (event.target === dialog) {
      event.stopPropagation();
      restoreReturnFocus();
      dispatch("wa-after-hide");
    }
  };
  const cancel = (event: Event) => {
    if (event.target === dialog) {
      event.preventDefault();
      event.stopPropagation();
      request(false, false);
    }
  };
  const pointerdown = (event: PointerEvent) => {
    if (initialFocusPending) {
      openingInteraction = true;
    }
    if (event.target === dialog) {
      request(false, false);
    }
  };
  const keydown = () => {
    if (initialFocusPending) {
      openingInteraction = true;
    }
  };
  const focusin = (event: FocusEvent) => {
    if (event.target === dialog) {
      focusBeforeChrome =
        isHtmlElement(event.relatedTarget) && containsComposed(dialog, event.relatedTarget)
          ? event.relatedTarget
          : null;
      focusInitialContent();
    }
  };
  onSettled(() => {
    mounted = true;
    dialog.addEventListener("overlay-show", beforeShow);
    dialog.addEventListener("overlay-hide", beforeHide);
    dialog.addEventListener("overlay-after-show", afterShow);
    dialog.addEventListener("overlay-after-hide", afterHide);
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("pointerdown", pointerdown, true);
    dialog.addEventListener("keydown", keydown, true);
    dialog.addEventListener("focusin", focusin);
    overlay.bindSurface(dialog);
    overlay.setParent(findOverlayParent(host));
    overlay.subscribe((open) => {
      setModalLayer(host, open && host.isConnected);
      if (!open) {
        initialFocusPending = false;
        restoreReturnFocus();
      }
      publishOpen(open);
    });
    if (state.returnTarget) {
      returnOverride = state.returnTarget.value;
      state.returnTarget = undefined;
    }
    request(host.open);
    return () => {
      disposed = true;
      detaching = true;
      mounted = false;
      overlay.dispose();
      setModalLayer(host, false);
      restoreReturnFocus();
      dialog.removeEventListener("overlay-show", beforeShow);
      dialog.removeEventListener("overlay-hide", beforeHide);
      dialog.removeEventListener("overlay-after-show", afterShow);
      dialog.removeEventListener("overlay-after-hide", afterHide);
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("pointerdown", pointerdown, true);
      dialog.removeEventListener("keydown", keydown, true);
      dialog.removeEventListener("focusin", focusin);
      if (state.policy === policy) {
        state.policy = undefined;
      }
    };
  });

  return policy;
}

export const ModalDialog = defineSolidBridge<ModalDialogProperties, ModalDialogMethods>(
  "openclaw-modal-dialog",
  (props, host) => {
    const policy = createModalPolicy(host, props);
    return createComponent(ModalDialogContent, {
      bindDialog: policy.bindDialog,
      bindOverlayContainer: policy.bindOverlayContainer,
      get label() {
        return props.label;
      },
      get description() {
        return props.description;
      },
      get children() {
        return props.children;
      },
    });
  },
  {
    properties: {
      open: { default: true, type: Boolean },
      manual: { default: false, type: Boolean, reflect: true },
      label: { default: "", type: String },
      description: { default: "", type: String },
      onOpenChange: { default: undefined, attribute: false },
    },
    connected(host) {
      if (host.manual) {
        host.open = false;
      }
      states.get(host)?.policy?.connect();
    },
    disconnected(host) {
      states.get(host)?.policy?.disconnect();
    },
    methods: {
      show(host) {
        const policy = states.get(host)?.policy;
        if (policy) {
          policy.request(true);
        } else {
          host.open = true;
        }
      },
      hide(host) {
        const policy = states.get(host)?.policy;
        if (policy) {
          policy.request(false);
        } else {
          host.open = false;
        }
      },
      setReturnFocusTarget(host, target) {
        const state = stateFor(host);
        if (state.policy) {
          state.policy.setReturnFocusTarget(target);
        } else {
          state.returnTarget = { value: target };
        }
      },
      getOverlayContainer(host) {
        return states.get(host)?.policy?.getOverlayContainer() ?? null;
      },
    },
  },
);

export const OpenClawModalDialog = ModalDialog.Element;

declare global {
  interface Document {
    openClawModalLayers?: Set<HTMLElement>;
  }
  interface HTMLElementTagNameMap {
    "openclaw-modal-dialog": OpenClawModalDialog;
  }
}
