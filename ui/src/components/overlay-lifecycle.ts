import { hideOverlayAnchor, showOverlayAnchor } from "./overlay-anchor.ts";
import {
  branchRevision,
  containsComposed,
  orderStack,
  prepareClosures,
  reconcileNative,
  refreshOverlayRoots,
  registerOverlay,
  registryFor,
  type OverlayRegistry,
} from "./overlay-registry.ts";

export { findOverlayParent, installOverlayKeyboard } from "./overlay-registry.ts";

export type OverlayPhase = "opening" | "open" | "closing" | "hidden";
export type OverlayFocusIntent = "first" | "last" | "return" | "none";

export interface OverlayNativeAdapter {
  isOpen(surface: HTMLElement): boolean;
  show(surface: HTMLElement, source?: HTMLElement): void;
  hide(surface: HTMLElement): void;
}

export interface OverlayOptions {
  native?: OverlayNativeAdapter;
  /** Tooltips describe their invoker without exposing expandable-control semantics. */
  reflectTriggerExpanded?: boolean;
  /** Only members of the same group displace one another. Dialogs have no group. */
  exclusiveGroup?: string;
  isValid?(surface: HTMLElement, trigger?: HTMLElement): boolean;
  dismissOutsidePointer?: boolean;
  dismissOutsideFocus?: boolean;
  dismissEscape?: boolean;
  interactionElements?(): Iterable<Element>;
  onRootChange?(root: Document | ShadowRoot): void | (() => void);
  /** Root-correct input facts; the surface's policy decides whether to dismiss. */
  onInteraction?(event: PointerEvent | FocusEvent, target: Node | null): void;
  /** Return true when an embedded control consumed Escape without dismissing. */
  onEscape?(event: KeyboardEvent): boolean;
  onInitialFocus?(intent: "first" | "last"): void;
  onReturnFocus?(target: HTMLElement): void;
  beforeNativeHide?(): void;
  acquireOcclusion?(surface: HTMLElement): () => void;
}

export interface Overlay {
  readonly id: string;
  readonly parent?: Overlay;
  readonly children: Set<Overlay>;
  readonly surface: HTMLElement;
  readonly trigger: HTMLElement | undefined;
  /** Accepted state is synchronous; phase tracks the remaining presentation work. */
  readonly open: boolean;
  readonly phase: OverlayPhase;
  readonly revision: number;
  contains(target: Node | null): boolean;
  containsFocus(): boolean;
  retire(): void;
  /** Bind after mounting so subscriptions use the live document, not a template document. */
  bindSurface(node: HTMLElement): void;
  bindTrigger(node: HTMLElement | undefined): void;
  setParent(parent?: Overlay): void;
  setReturnTarget(node: HTMLElement): void;
  subscribe(listener: (open: boolean) => void): () => void;
  request(next: boolean, focus?: OverlayFocusIntent): boolean;
  prepareClose(): (() => boolean) | null;
  nativeToggle(): void;
  keydown(event: KeyboardEvent): void;
  dispose(): void;
}

export const popoverOverlayAdapter: OverlayNativeAdapter = {
  isOpen: (surface) => surface.matches(":popover-open"),
  show: (surface, source) => {
    showOverlayAnchor(surface);
    try {
      surface.showPopover(source ? { source } : undefined);
    } finally {
      if (!surface.matches(":popover-open")) {
        hideOverlayAnchor(surface);
      }
    }
  },
  hide: (surface) => surface.hidePopover(),
};

export function createOverlay(
  id: string,
  initialParent?: Overlay,
  options: OverlayOptions = {},
): Overlay {
  let parent = initialParent;
  const native = options.native ?? popoverOverlayAdapter;
  let surface: HTMLElement;
  let trigger: HTMLElement | undefined;
  let returnTarget: HTMLElement | undefined;
  let registry: OverlayRegistry;
  let unregister: (() => void) | undefined;
  let releaseOcclusion: (() => void) | undefined;
  let opened = false;
  let phase: OverlayPhase = "hidden";
  let disposed = false;
  let intent = 0;
  let intentTarget = false;
  let intentFocus: OverlayFocusIntent = "none";
  let notifyingRetirement = false;
  let nativeMutation = false;
  let generation = 0;
  let frame: number | undefined;
  const children = new Set<Overlay>();
  const listeners = new Set<(open: boolean) => void>();
  function* ownedElements(): Iterable<Element | undefined> {
    yield surface;
    yield trigger;
    yield returnTarget;
    yield* options.interactionElements?.() ?? [];
  }
  const notifyClosed = () => listeners.forEach((listener) => listener(false));
  const valid = () =>
    !disposed &&
    surface.isConnected &&
    (!trigger || trigger.isConnected) &&
    (!parent || (parent.open && parent.phase !== "closing")) &&
    (options.isValid?.(surface, trigger) ?? true);
  const beforeToggle = (event: Event) => {
    if (event.target !== surface) {
      return;
    }
    if ((event as ToggleEvent).newState === "open") {
      registry.nativeOrder.set(api, ++registry.nextOrder);
    }
    // A coalesced native close/open must not inherit children from the old opening.
    children.forEach((child) => child.retire());
    if ((event as ToggleEvent).newState === "closed") {
      surface.inert = true;
    }
  };
  const api: Overlay = {
    id,
    get parent() {
      return parent;
    },
    children,
    get surface() {
      return surface;
    },
    get trigger() {
      return trigger;
    },
    get open() {
      return opened;
    },
    get phase() {
      return phase;
    },
    get revision() {
      return generation + intent + (registry?.nativeOrder.get(api) ?? 0);
    },
    contains(target) {
      return Boolean(
        target &&
        (Array.from(ownedElements()).some((element) => containsComposed(element, target)) ||
          [...children].some((child) => child.contains(target))),
      );
    },
    containsFocus() {
      return (
        Array.from(ownedElements()).some((element) => {
          if (!element) {
            return false;
          }
          const root = element.getRootNode();
          const view = element.ownerDocument.defaultView;
          const active =
            view && root instanceof view.ShadowRoot
              ? root.activeElement
              : element.ownerDocument.activeElement;
          return api.contains(active);
        }) || [...children].some((child) => child.containsFocus())
      );
    },
    retire() {
      if (notifyingRetirement) {
        if (disposed) {
          intent += 1;
          intentTarget = false;
          if (native.isOpen(surface)) {
            setNativeOpen(false);
          }
          publish(false);
        }
        return;
      }
      if (surface) {
        nativeToggle();
      }
      const requested = ++intent;
      intentTarget = false;
      notifyingRetirement = true;
      try {
        children.forEach((child) => child.retire());
        if (opened && surface.isConnected) {
          surface.dispatchEvent(new CustomEvent("overlay-hide", { bubbles: true, composed: true }));
        }
      } finally {
        notifyingRetirement = false;
      }
      if (requested !== intent) {
        return;
      }
      if (!opened) {
        notifyClosed();
        if (surface && (disposed || !surface.isConnected || phase !== "closing")) {
          if (native.isOpen(surface)) {
            setNativeOpen(false);
          }
          setPhase("hidden");
        }
        return;
      }
      setPhase("closing");
      if (
        native.isOpen(surface) &&
        (disposed || !surface.isConnected || !hasPendingPresentation())
      ) {
        setNativeOpen(false);
      }
      if (requested !== intent) {
        const reopen = intentTarget;
        const focus = intentFocus;
        publish(false);
        if (reopen) {
          api.request(true, focus);
        }
        return;
      }
      const token = ++generation;
      publish(false);
      if (surface.isConnected) {
        complete(false, token);
      } else {
        setPhase("hidden");
      }
    },
    bindSurface(node) {
      if (disposed || surface === node) {
        return;
      }
      if (parent?.surface && parent.surface.ownerDocument !== node.ownerDocument) {
        throw new Error("Overlay parent belongs to another document");
      }
      if (surface) {
        api.retire();
        unbindSurface();
        generation += 1;
      }
      surface = node;
      registry = registryFor(node.ownerDocument);
      unregister = registerOverlay(registry, api, {
        options,
        valid,
        elements: ownedElements,
      });
      node.addEventListener("beforetoggle", beforeToggle);
      node.addEventListener("toggle", nativeToggle);
      setPhase("hidden");
      refreshOverlayRoots(registry, api);
      if (!disposed) {
        nativeToggle();
      }
    },
    bindTrigger(node) {
      if (trigger === node) {
        return;
      }
      if (options.reflectTriggerExpanded !== false) {
        trigger?.setAttribute("aria-expanded", "false");
      }
      trigger = node;
      if (options.reflectTriggerExpanded !== false) {
        trigger?.setAttribute("aria-expanded", String(opened));
      }
      if (registry) {
        refreshOverlayRoots(registry, api);
      }
    },
    setParent(next) {
      if (disposed || parent === next) {
        return;
      }
      if (surface && next?.surface && next.surface.ownerDocument !== surface.ownerDocument) {
        throw new Error("Overlay parent belongs to another document");
      }
      for (let ancestor = next; ancestor; ancestor = ancestor.parent) {
        if (ancestor === api) {
          throw new Error("An overlay cannot be its own ancestor");
        }
      }
      api.retire();
      parent?.children.delete(api);
      parent = next;
      parent?.children.add(api);
    },
    setReturnTarget(node) {
      returnTarget = node;
      if (registry) {
        refreshOverlayRoots(registry, api);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request(next, focus = "none") {
      if (disposed || !surface) {
        return false;
      }
      refreshOverlayRoots(registry, api);
      if (disposed) {
        return false;
      }
      if ((next && !valid()) || (!next && notifyingRetirement)) {
        return !next;
      }
      if (nativeMutation && next === intentTarget) {
        return true;
      }
      reconcileNative(registry);
      if (next === opened && next === intentTarget) {
        if (!next) {
          notifyClosed();
        }
        return true;
      }
      const requested = ++intent;
      intentTarget = next;
      intentFocus = focus;
      if (next === opened) {
        if (!next) {
          notifyClosed();
        }
        return true;
      }
      if (!next) {
        const commit = api.prepareClose();
        if (!commit?.()) {
          return false;
        }
        const target = returnTarget ?? trigger;
        if (focus === "return" && target?.isConnected) {
          if (options.onReturnFocus) {
            options.onReturnFocus(target);
          } else {
            target.focus({ preventScroll: true });
          }
        }
        return true;
      }
      const admitted = new Set(registry.members.keys());
      if (!propose("overlay-show") || requested !== intent || !valid()) {
        return false;
      }
      reconcileNative(registry);
      if (requested !== intent) {
        return false;
      }
      const ancestors = new Set<Overlay>();
      for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
        ancestors.add(ancestor);
      }
      const displaced = () =>
        registry.stack.filter(
          (candidate) =>
            candidate !== api &&
            !ancestors.has(candidate) &&
            options.exclusiveGroup !== undefined &&
            registry.members.get(candidate)?.options.exclusiveGroup === options.exclusiveGroup,
        );
      const closes = prepareClosures(
        registry,
        () => {
          const owners = displaced();
          return owners.filter((owner) => !owner.parent || !owners.includes(owner.parent));
        },
        admitted,
      );
      if (!closes?.current() || requested !== intent || !valid() || !closes.commit()) {
        return false;
      }
      reconcileNative(registry);
      if (displaced().length || requested !== intent || !valid()) {
        return false;
      }
      refreshOverlayRoots(registry, api);
      setPhase("opening");
      if (!setNativeOpen(true)) {
        setPhase("hidden");
        return false;
      }
      reconcileNative(registry, api);
      if (displaced().length || !valid() || (requested !== intent && !opened)) {
        children.forEach((child) => child.retire());
        setNativeOpen(false);
        generation += 1;
        publish(false);
        setPhase("hidden");
        return false;
      }
      if (requested !== intent) {
        return false;
      }
      const token = ++generation;
      publish(true);
      complete(true, token);
      if ((focus === "first" || focus === "last") && requested === intent && opened) {
        options.onInitialFocus?.(focus);
      }
      return requested === intent && !disposed && opened;
    },
    prepareClose() {
      nativeToggle();
      const requested = ++intent;
      intentTarget = false;
      if (!opened) {
        return () => true;
      }
      if (!propose("overlay-hide") || requested !== intent) {
        return null;
      }
      const closes = prepareClosures(
        registry,
        () => [...children].filter((child) => child.open),
        new Set(children),
      );
      if (!closes?.current() || requested !== intent) {
        return null;
      }
      const revision = branchRevision(api);
      return () => {
        if (requested !== intent || revision !== branchRevision(api) || !closes.current()) {
          return false;
        }
        if (!closes.commit()) {
          return false;
        }
        reconcileNative(registry);
        if ([...children].some((child) => child.open)) {
          return false;
        }
        for (const child of children) {
          if (!child.open) {
            child.retire();
          }
        }
        if (requested !== intent) {
          return false;
        }
        setPhase("closing");
        if (!hasPendingPresentation()) {
          setNativeOpen(false);
        }
        children.forEach((child) => child.retire());
        if (requested !== intent) {
          const reopen = intentTarget;
          const reopenFocus = intentFocus;
          publish(false);
          if (reopen) {
            api.request(true, reopenFocus);
          }
          return false;
        }
        const token = ++generation;
        publish(false);
        complete(false, token);
        return requested === intent && !opened;
      };
    },
    nativeToggle,
    keydown(event) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.key !== "Escape" ||
        options.dismissEscape === false
      ) {
        return;
      }
      if (!options.onEscape?.(event)) {
        api.request(false, "return");
      }
      event.preventDefault();
      event.stopPropagation();
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      api.retire();
      generation += 1;
      children.forEach((child) => child.dispose());
      parent?.children.delete(api);
      if (surface) {
        unbindSurface();
      }
      listeners.clear();
    },
  };
  function setNativeOpen(next: boolean): boolean {
    nativeMutation = true;
    try {
      if (next) {
        native.show(surface, trigger);
      } else {
        options.beforeNativeHide?.();
        native.hide(surface);
      }
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        !["InvalidStateError", "NotSupportedError"].includes(error.name)
      ) {
        throw error;
      }
    } finally {
      nativeMutation = false;
    }
    return native.isOpen(surface) === next;
  }
  function removeFromStack() {
    const index = registry.stack.indexOf(api);
    if (index >= 0) {
      registry.stack.splice(index, 1);
    }
  }
  function setPhase(next: OverlayPhase) {
    phase = next;
    surface.dataset.phase = next;
    surface.inert = next === "closing" || next === "hidden";
    if (next === "hidden") {
      hideOverlayAnchor(surface);
      releaseOcclusion?.();
      releaseOcclusion = undefined;
    }
  }
  function publish(next: boolean) {
    if (next === opened) {
      return;
    }
    opened = next;
    removeFromStack();
    if (next) {
      releaseOcclusion ??= options.acquireOcclusion?.(surface);
      registry.stack.push(api);
      orderStack(registry);
    }
    surface.inert = !next;
    if (options.reflectTriggerExpanded !== false) {
      trigger?.setAttribute("aria-expanded", String(next));
    }
    listeners.forEach((listener) => listener(next));
  }
  function propose(name: string) {
    return surface.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true, cancelable: true }),
    );
  }
  function pendingPresentation() {
    return surface.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return (
        ["running", "paused"].includes(animation.playState) &&
        typeof end === "number" &&
        Number.isFinite(end)
      );
    });
  }
  function hasPendingPresentation() {
    return pendingPresentation().length > 0;
  }
  function complete(next: boolean, token: number) {
    const currentSurface = surface;
    const win = currentSurface.ownerDocument.defaultView;
    if (!win || token !== generation || disposed || !currentSurface.isConnected) {
      return;
    }
    if (frame !== undefined) {
      win.cancelAnimationFrame(frame);
    }
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      if (token !== generation || disposed) {
        return;
      }
      // An unrelated spinner must not prevent the overlay from settling forever.
      const animations = pendingPresentation();
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (
          token !== generation ||
          disposed ||
          !currentSurface.isConnected ||
          currentSurface !== surface
        ) {
          return;
        }
        if (!next && native.isOpen(surface)) {
          setNativeOpen(false);
          children.forEach((child) => child.retire());
          if (token !== generation || disposed) {
            if (!disposed && intentTarget) {
              api.request(true, intentFocus);
            }
            return;
          }
          // Native close can start a fresh exit after an interrupted entry settles.
          if (!native.isOpen(surface) && hasPendingPresentation()) {
            complete(false, token);
            return;
          }
        }
        if (native.isOpen(surface) !== next) {
          return;
        }
        setPhase(next ? "open" : "hidden");
        surface.dispatchEvent(new CustomEvent(next ? "overlay-after-show" : "overlay-after-hide"));
      });
    });
  }
  function nativeToggle() {
    // Synchronous native autofocus must not publish this request halfway through admission.
    if (!surface || nativeMutation) {
      return;
    }
    const next = native.isOpen(surface);
    // Accepted close authority is already false while its finite exit still
    // needs the native top layer. Reconciliation must not turn that into a reopen.
    if (phase === "closing" && !opened && next) {
      return;
    }
    surface.inert = !next;
    if (next === opened) {
      return;
    }
    refreshOverlayRoots(registry, api);
    intent += 1;
    intentTarget = next;
    setPhase(next ? "opening" : "closing");
    const token = ++generation;
    publish(next);
    complete(next, token);
    // A later beforetoggle listener can admit a child after early retirement.
    if (!next) {
      children.forEach((child) => child.retire());
    }
  }
  function unbindSurface() {
    if (native.isOpen(surface)) {
      setNativeOpen(false);
    }
    surface.removeEventListener("beforetoggle", beforeToggle);
    surface.removeEventListener("toggle", nativeToggle);
    if (frame !== undefined) {
      surface.ownerDocument.defaultView?.cancelAnimationFrame(frame);
      frame = undefined;
    }
    setPhase("hidden");
    removeFromStack();
    unregister?.();
  }
  parent?.children.add(api);
  return api;
}
