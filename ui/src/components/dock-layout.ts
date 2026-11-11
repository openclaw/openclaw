import { observeWindowResize } from "../lib/reactive/window-resize.ts";
import type { DockPanelLayoutStore, DockPanelPlacement } from "./dock-panel-layout.ts";

/** Geometry and open intent stay synchronous for panel actions and persistence. */
export function createDockLayout<TDock extends DockPanelPlacement>(deps: {
  layout: DockPanelLayoutStore<TDock>;
  reservationPrefix: string;
  isAvailable: () => boolean;
  isEmbedded?: () => boolean;
  isFullscreen?: () => boolean;
  onResize?: () => void;
  notify: () => void;
}) {
  let suppressed = false;
  let persistedOpen = false;
  let stopResize: (() => void) | undefined;
  const isFullscreen = () => deps.isFullscreen?.() === true;
  // Embedded/fullscreen parents own geometry; only standalone docks reserve the viewport.
  const reservesViewport = () => !isFullscreen() && !deps.isEmbedded?.();
  const size = () => (dock.dock === "bottom" ? window.innerHeight : window.innerWidth);
  const dock = {
    open: false,
    dock: deps.layout.defaults.dock,
    height: deps.layout.defaults.height,
    width: deps.layout.defaults.width,

    connect() {
      if (isFullscreen()) {
        dock.open = deps.isAvailable();
        return;
      }
      const layout = deps.layout.load();
      persistedOpen = layout.open;
      dock.open = layout.open && deps.isAvailable();
      dock.dock = layout.dock;
      dock.height = layout.height;
      dock.width = Math.min(layout.width, deps.layout.maxWidth());
      stopResize = observeWindowResize(window, () => {
        const height = Math.min(dock.height, deps.layout.maxHeight());
        const width = Math.min(dock.width, deps.layout.maxWidth());
        if (height === dock.height && width === dock.width) {
          return;
        }
        dock.height = height;
        dock.width = width;
        dock.syncReservation();
        deps.onResize?.();
        deps.notify();
      });
    },

    dispose() {
      stopResize?.();
      stopResize = undefined;
      if (reservesViewport()) {
        const root = document.documentElement.style;
        root.setProperty(`--oc-${deps.reservationPrefix}-reserve-bottom`, "0px");
        root.setProperty(`--oc-${deps.reservationPrefix}-reserve-right`, "0px");
      }
    },

    setOpen(open: boolean, persist = true) {
      dock.open = open;
      dock.syncReservation();
      if (persist) {
        dock.persist();
      }
      deps.notify();
    },

    hideWithoutPersisting() {
      dock.setOpen(false, false);
    },

    /** Route takeovers preserve saved intent; explicit opens still win. */
    setSuppressed(next: boolean): boolean {
      if (suppressed === next) {
        return false;
      }
      suppressed = next;
      if (next) {
        dock.hideWithoutPersisting();
        return false;
      }
      return dock.restoreOpenState();
    },

    restoreOpenState(): boolean {
      if (suppressed || !deps.isAvailable() || dock.open || (!isFullscreen() && !persistedOpen)) {
        return false;
      }
      dock.setOpen(true, false);
      return true;
    },

    setDock(placement: TDock, persist = true) {
      dock.dock = placement;
      dock.syncReservation();
      if (persist) {
        dock.persist();
      }
      deps.notify();
    },

    persist() {
      persistedOpen = dock.open;
      deps.layout.save({
        open: dock.open,
        dock: dock.dock,
        height: dock.height,
        width: dock.width,
      });
    },

    syncReservation() {
      if (!reservesViewport()) {
        return;
      }
      const visible = deps.isAvailable() && dock.open;
      const root = document.documentElement.style;
      root.setProperty(
        `--oc-${deps.reservationPrefix}-reserve-bottom`,
        visible && dock.dock === "bottom" ? `${dock.height}px` : "0px",
      );
      root.setProperty(
        `--oc-${deps.reservationPrefix}-reserve-right`,
        visible && dock.dock === "right" ? `${dock.width}px` : "0px",
      );
    },

    resize(event: CustomEvent<{ splitRatio: number }>) {
      const horizontal = dock.dock === "bottom";
      const minimum = horizontal ? deps.layout.minHeight : deps.layout.minWidth;
      const maximum = horizontal ? deps.layout.maxHeight() : deps.layout.maxWidth();
      const next = Math.min(maximum, Math.max(minimum, (1 - event.detail.splitRatio) * size()));
      if (horizontal) {
        dock.height = next;
      } else {
        dock.width = next;
      }
      dock.syncReservation();
      deps.onResize?.();
      deps.notify();
    },

    get resizer() {
      if (isFullscreen() || dock.dock === "main" || (!dock.open && !deps.isEmbedded?.())) {
        return null;
      }
      const horizontal = dock.dock === "bottom";
      const viewportSize = size();
      const minimum = horizontal ? deps.layout.minHeight : deps.layout.minWidth;
      const maximum = horizontal ? deps.layout.maxHeight() : deps.layout.maxWidth();
      const current = horizontal ? dock.height : dock.width;
      return {
        orientation: horizontal ? ("horizontal" as const) : ("vertical" as const),
        splitRatio: 1 - current / viewportSize,
        minRatio: 1 - maximum / viewportSize,
        maxRatio: 1 - minimum / viewportSize,
        measureRatio: () => 1 - (horizontal ? dock.height : dock.width) / size(),
        measureSize: size,
      };
    },
  };
  return dock;
}

export type DockLayout<TDock extends DockPanelPlacement> = ReturnType<
  typeof createDockLayout<TDock>
>;
