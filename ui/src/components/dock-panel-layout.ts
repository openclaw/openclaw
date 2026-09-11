export type DockPanelSide = "bottom" | "left" | "right";
export type DockPanelPlacement = DockPanelSide | "main";

export type DockPanelLayout<TDock extends DockPanelPlacement> = {
  open: boolean;
  dock: TDock;
  height: number;
  width: number;
};

export type DockPanelLayoutStore<TDock extends DockPanelPlacement> = {
  defaults: DockPanelLayout<TDock>;
  prepared?: { layout: DockPanelLayout<TDock>; detach(): void };
  minHeight: number;
  minWidth: number;
  maxHeight(): number;
  maxWidth(): number;
  load(): DockPanelLayout<TDock>;
  save(layout: DockPanelLayout<TDock>): void;
};

type DockPanelLayoutOptions<TDock extends DockPanelPlacement> = {
  storageKey: string;
  minHeight: number;
  minWidth: number;
  defaultDock: TDock;
  supportedDocks: readonly TDock[];
  defaultHeight: number;
  defaultWidth: number;
};

export function createDockPanelLayout<TDock extends DockPanelPlacement>(
  options: DockPanelLayoutOptions<TDock>,
): DockPanelLayoutStore<TDock> {
  const defaults: DockPanelLayout<TDock> = {
    open: false,
    dock: options.defaultDock,
    height: options.defaultHeight,
    width: options.defaultWidth,
  };
  // Re-clamp desktop-persisted sizes to 80% of the current viewport so dock
  // chrome and the remaining app surface stay reachable on smaller windows.
  const maxHeight = () =>
    Math.max(options.minHeight, Math.floor((globalThis.innerHeight || 800) * 0.8));
  const maxWidth = () =>
    Math.max(options.minWidth, Math.floor((globalThis.innerWidth || 1280) * 0.8));
  const clampSize = (value: unknown, min: number, max: number, fallback: number) => {
    const size =
      typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
    return Math.min(size, max);
  };

  return {
    defaults,
    minHeight: options.minHeight,
    minWidth: options.minWidth,
    maxHeight,
    maxWidth,
    load(): DockPanelLayout<TDock> {
      try {
        const raw = globalThis.localStorage?.getItem(options.storageKey);
        if (!raw) {
          return { ...defaults };
        }
        const parsed = JSON.parse(raw) as Partial<DockPanelLayout<DockPanelSide>>;
        return {
          open: Boolean(parsed.open),
          dock: options.supportedDocks.includes(parsed.dock as TDock)
            ? (parsed.dock as TDock)
            : defaults.dock,
          height: clampSize(parsed.height, options.minHeight, maxHeight(), defaults.height),
          width: clampSize(parsed.width, options.minWidth, maxWidth(), defaults.width),
        };
      } catch {
        return { ...defaults };
      }
    },
    save(layout: DockPanelLayout<TDock>): void {
      try {
        globalThis.localStorage?.setItem(options.storageKey, JSON.stringify(layout));
      } catch {
        // Storage may be unavailable (private mode); layout just won't persist.
      }
    },
  };
}

export const terminalPanelLayout = createDockPanelLayout({
  storageKey: "openclaw.terminal.panel.v1",
  minHeight: 140,
  minWidth: 320,
  defaultDock: "bottom",
  supportedDocks: ["bottom", "right", "main"],
  defaultHeight: 320,
  defaultWidth: 520,
});

export const browserPanelLayout = createDockPanelLayout({
  storageKey: "openclaw.browser.panel.v1",
  minHeight: 240,
  minWidth: 380,
  defaultDock: "right",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 420,
  defaultWidth: 560,
});

export const assistantPanelLayout = createDockPanelLayout({
  // Shipped key: operators' saved dock size and placement live here, so the
  // legacy custodian spelling stays even though the dock is now shared.
  storageKey: "openclaw.custodian.panel.v1",
  minHeight: 240,
  minWidth: 320,
  defaultDock: "right",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 420,
  defaultWidth: 440,
});

/** Shared viewport geometry for live docks and their saved-layout preparation. */
export function writeDockPanelReservation(
  prefix: string,
  layout: DockPanelLayout<DockPanelPlacement> | undefined,
): void {
  const style = document.documentElement.style;
  style.setProperty(
    `--oc-${prefix}-reserve-bottom`,
    layout?.open && layout.dock === "bottom" ? `${layout.height}px` : "0px",
  );
  style.setProperty(
    `--oc-${prefix}-reserve-right`,
    layout?.open && layout.dock === "right" ? `${layout.width}px` : "0px",
  );
}

/** Transfer the saved layout without rereading storage when the real dock mounts. */
export function consumePreparedDockPanelLayout<TDock extends DockPanelPlacement>(
  store: DockPanelLayoutStore<TDock>,
): DockPanelLayout<TDock> {
  const prepared = store.prepared;
  delete store.prepared;
  prepared?.detach();
  return prepared?.layout ?? store.load();
}

export function prepareDockPanelLayout(
  store: DockPanelLayoutStore<DockPanelPlacement>,
  prefix: string,
) {
  const layout = store.load();
  let visible = false;
  const ownsReservation = () => store.prepared?.layout === layout;
  const synchronize = () => {
    if (!ownsReservation()) {
      window.removeEventListener("resize", synchronize);
      return;
    }
    layout.width = Math.min(layout.width, store.maxWidth());
    layout.height = Math.min(layout.height, store.maxHeight());
    writeDockPanelReservation(prefix, visible ? layout : undefined);
  };
  const detach = () => window.removeEventListener("resize", synchronize);
  if (layout.open) {
    store.prepared = { layout, detach };
    window.addEventListener("resize", synchronize);
  }
  return {
    layout,
    synchronize(nextVisible: boolean) {
      visible = nextVisible;
      synchronize();
    },
    release() {
      window.removeEventListener("resize", synchronize);
      if (ownsReservation()) {
        delete store.prepared;
        writeDockPanelReservation(prefix, undefined);
      }
    },
  };
}
