export type OverlayPlacement =
  | "top"
  | "top-start"
  | "top-end"
  | "bottom"
  | "bottom-start"
  | "bottom-end"
  | "left"
  | "left-start"
  | "left-end"
  | "right"
  | "right-start"
  | "right-end";

type AnchorElement = HTMLElement | SVGElement;
type Binding = { name: string; anchor?: AnchorElement; placement: OverlayPlacement };
type AnchorNames = { original: string; priority: string; names: Set<string> };

export interface OverlayAnchorBinding {
  update(anchor: AnchorElement, placement?: OverlayPlacement): void;
  dispose(): void;
}

type SurfaceAnchor = {
  readonly sameRoot: boolean;
  update(binding: Binding): void;
  remove(binding: Binding): void;
  show(): void;
  hide(): void;
};

let nextAnchor = 0;
const anchors = new WeakMap<AnchorElement, AnchorNames>();
const surfaces = new WeakMap<HTMLElement, SurfaceAnchor>();

function publishAnchorNames(anchor: AnchorElement, state: AnchorNames) {
  anchor.style.setProperty(
    "anchor-name",
    [state.original && state.original !== "none" ? state.original : "", ...state.names]
      .filter(Boolean)
      .join(", "),
    state.priority,
  );
}

function addAnchorName(anchor: AnchorElement, name: string) {
  let state = anchors.get(anchor);
  if (!state) {
    state = {
      original: anchor.style.getPropertyValue("anchor-name"),
      priority: anchor.style.getPropertyPriority("anchor-name"),
      names: new Set(),
    };
    anchors.set(anchor, state);
  }
  state.names.add(name);
  publishAnchorNames(anchor, state);
}

function removeAnchorName(anchor: AnchorElement, name: string) {
  const state = anchors.get(anchor);
  if (!state) {
    return;
  }
  state.names.delete(name);
  if (state.names.size) {
    publishAnchorNames(anchor, state);
  } else {
    if (state.original) {
      anchor.style.setProperty("anchor-name", state.original, state.priority);
    } else {
      anchor.style.removeProperty("anchor-name");
    }
    anchors.delete(anchor);
  }
}

function createSurfaceAnchor(surface: HTMLElement, sameRoot: boolean): SurfaceAnchor {
  const bindings: Binding[] = [];
  const original = surface.style.getPropertyValue("position-anchor");
  const priority = surface.style.getPropertyPriority("position-anchor");
  const oldPlacement = surface.dataset.placement;
  let win: Window | null = null;
  let source: HTMLSpanElement | undefined;
  let presented = false;
  let frame: number | undefined;
  let positionedCrossRoot: boolean | undefined;
  let proxyLeft = Number.NaN;
  let proxyTop = Number.NaN;
  let proxyWidth = Number.NaN;
  let proxyHeight = Number.NaN;
  const sourceName = `--oc-overlay-spatial-${++nextAnchor}`;
  const current = () => bindings.findLast((binding) => binding.anchor);
  const crossRoot = (binding: Binding) => binding.anchor?.getRootNode() !== surface.getRootNode();
  const measure = (anchor: AnchorElement) => {
    if (!source) {
      return;
    }
    const rect = anchor.getBoundingClientRect();
    if (rect.left !== proxyLeft) {
      source.style.setProperty("left", `${rect.left}px`);
      proxyLeft = rect.left;
    }
    if (rect.top !== proxyTop) {
      source.style.setProperty("top", `${rect.top}px`);
      proxyTop = rect.top;
    }
    if (rect.width !== proxyWidth) {
      source.style.setProperty("width", `${rect.width}px`);
      proxyWidth = rect.width;
    }
    if (rect.height !== proxyHeight) {
      source.style.setProperty("height", `${rect.height}px`);
      proxyHeight = rect.height;
    }
  };
  const apply = () => {
    const binding = current();
    if (!binding?.anchor) {
      return;
    }
    positionedCrossRoot = crossRoot(binding);
    const positionAnchor = positionedCrossRoot ? sourceName : binding.name;
    if (surface.style.getPropertyValue("position-anchor") !== positionAnchor) {
      surface.style.setProperty("position-anchor", positionAnchor);
    }
    if (surface.dataset.placement !== binding.placement) {
      surface.dataset.placement = binding.placement;
    }
    if (positionedCrossRoot) {
      measure(binding.anchor);
    }
  };
  const stop = () => {
    if (frame !== undefined) {
      win?.cancelAnimationFrame(frame);
      frame = undefined;
    }
  };
  const schedule = () => {
    const binding = current();
    // CSS follows same-root anchors; only a cross-root proxy needs frame sampling.
    if (!presented || !binding?.anchor || !crossRoot(binding)) {
      stop();
      return;
    }
    if (!win || frame !== undefined) {
      return;
    }
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      if (!surface.isConnected || !presented) {
        return;
      }
      const activeBinding = current();
      if (!activeBinding?.anchor) {
        return;
      }
      // A live cross-root binding can move into the surface root between frames.
      if (crossRoot(activeBinding) !== positionedCrossRoot) {
        apply();
      } else if (positionedCrossRoot) {
        measure(activeBinding.anchor);
      }
      schedule();
    });
  };
  const state: SurfaceAnchor = {
    sameRoot,
    update(binding) {
      const index = bindings.indexOf(binding);
      if (index !== -1) {
        bindings.splice(index, 1);
      }
      bindings.push(binding);
      apply();
      schedule();
    },
    remove(binding) {
      const index = bindings.indexOf(binding);
      if (index !== -1) {
        bindings.splice(index, 1);
      }
      if (bindings.length) {
        apply();
        schedule();
        return;
      }
      stop();
      source?.remove();
      surfaces.delete(surface);
      if (original) {
        surface.style.setProperty("position-anchor", original, priority);
      } else {
        surface.style.removeProperty("position-anchor");
      }
      if (oldPlacement === undefined) {
        delete surface.dataset.placement;
      } else {
        surface.dataset.placement = oldPlacement;
      }
    },
    show() {
      if (!current()?.anchor) {
        return;
      }
      // Solid template nodes can be adopted into the live document after binding.
      const doc = surface.ownerDocument;
      win = doc.defaultView;
      if (sameRoot) {
        presented = true;
        apply();
        return;
      }
      if (!source) {
        source = doc.createElement("span");
        source.setAttribute("aria-hidden", "true");
        source.popover = "manual";
        // A spatial proxy has no focus or dismissal policy. Its top-layer box
        // escapes transformed ancestors while its name stays in the surface's root.
        source.style.cssText =
          "position:fixed;inset:auto;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;opacity:0;pointer-events:none;";
        source.style.setProperty("anchor-name", sourceName);
      }
      const root = surface.getRootNode();
      if (source.getRootNode() !== root) {
        (root instanceof ShadowRoot ? root : doc.body).prepend(source);
      }
      apply();
      if (!source.matches(":popover-open")) {
        source.showPopover();
      }
      if (!source.matches(":popover-open")) {
        throw new DOMException("Overlay spatial anchor could not open", "InvalidStateError");
      }
      presented = true;
      apply();
      schedule();
    },
    hide() {
      presented = false;
      stop();
      if (source?.matches(":popover-open")) {
        source.hidePopover();
      }
    },
  };
  surfaces.set(surface, state);
  return state;
}

/** The first binding fixes whether a surface can cross DOM roots during its lifetime. */
export function createOverlayAnchor(
  surface: HTMLElement,
  { sameRoot = false }: { sameRoot?: boolean } = {},
): OverlayAnchorBinding {
  const state = surfaces.get(surface) ?? createSurfaceAnchor(surface, sameRoot);
  const binding: Binding = { name: `--oc-overlay-${++nextAnchor}`, placement: "bottom-start" };
  state.update(binding);
  let disposed = false;
  return {
    update(anchor, placement = "bottom-start") {
      if (disposed) {
        return;
      }
      if (anchor.ownerDocument !== surface.ownerDocument) {
        throw new Error("Overlay anchor belongs to another document");
      }
      if (state.sameRoot && anchor.getRootNode() !== surface.getRootNode()) {
        throw new Error("Overlay anchor must share the surface's root");
      }
      if (binding.anchor !== anchor) {
        if (binding.anchor) {
          removeAnchorName(binding.anchor, binding.name);
        }
        binding.anchor = anchor;
        addAnchorName(anchor, binding.name);
      }
      binding.placement = placement;
      state.update(binding);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (binding.anchor) {
        removeAnchorName(binding.anchor, binding.name);
      }
      state.remove(binding);
    },
  };
}

/** CSS owns placement, flip, and sizing; cross-root anchors mirror only their rectangle. */
export function bindOverlayAnchor(
  surface: HTMLElement,
  anchor: AnchorElement,
  placement: OverlayPlacement = "bottom-start",
): () => void {
  const binding = createOverlayAnchor(surface);
  binding.update(anchor, placement);
  return () => binding.dispose();
}

/** Called only after opening authority is accepted, before the visible surface opens. */
export function showOverlayAnchor(surface: HTMLElement): void {
  surfaces.get(surface)?.show();
}

/** Exit transitions still need geometry after the native surface begins hiding. */
export function hideOverlayAnchor(surface: HTMLElement): void {
  surfaces.get(surface)?.hide();
}
