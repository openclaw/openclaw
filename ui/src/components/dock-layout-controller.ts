import {
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type TemplateResult,
} from "lit";
import type { DockPanelLayoutStore, DockPanelPlacement } from "./dock-panel-layout.ts";
import "./resizable-divider.ts";

type DockLayoutHost = ReactiveControllerHost & { readonly isConnected: boolean };

type DockLayoutControllerOptions<TDock extends DockPanelPlacement> = {
  layout: DockPanelLayoutStore<TDock>;
  reservationPrefix: string;
  isAvailable: () => boolean;
  isFullscreen?: () => boolean;
  maxWidth?: () => number;
  reserveViewport?: boolean;
  onResize?: () => void;
};

export class DockLayoutController<TDock extends DockPanelPlacement> implements ReactiveController {
  open = false;
  dock: TDock;
  height: number;
  width: number;

  private suppressed = false;
  private persistedOpen = false;
  private readonly onViewportResize = () => {
    const height = Math.min(this.height, this.options.layout.maxHeight());
    const width = Math.min(this.width, this.maxWidth());
    if (height === this.height && width === this.width) {
      return;
    }
    this.height = height;
    this.width = width;
    this.syncReservation();
    this.options.onResize?.();
    this.host.requestUpdate();
  };

  constructor(
    private readonly host: DockLayoutHost,
    private readonly options: DockLayoutControllerOptions<TDock>,
  ) {
    this.dock = options.layout.defaults.dock;
    this.height = options.layout.defaults.height;
    this.width = options.layout.defaults.width;
    host.addController(this);
  }

  hostConnected(): void {
    if (this.isFullscreen()) {
      this.open = this.options.isAvailable();
      return;
    }
    const layout = this.options.layout.load();
    this.persistedOpen = layout.open;
    this.open = layout.open && this.options.isAvailable();
    this.dock = layout.dock;
    this.height = layout.height;
    this.width = Math.min(layout.width, this.maxWidth());
    window.addEventListener("resize", this.onViewportResize);
  }

  hostDisconnected(): void {
    window.removeEventListener("resize", this.onViewportResize);
    this.clearReservation();
  }

  setOpen(open: boolean, persist = true): void {
    this.open = open;
    this.syncReservation();
    if (persist) {
      this.persist();
    }
    this.host.requestUpdate();
  }

  hideWithoutPersisting(): void {
    this.setOpen(false, false);
  }

  /**
   * Full-page route takeovers (settings) own the viewport, so docks hide while
   * one renders. Hiding never persists — the user's open preference must survive
   * the visit — and suppression also blocks `restoreOpenState()` so a reconnect
   * mid-takeover cannot pop the panel back over settings. Returns true when the
   * caller must resume its surface after the takeover ends.
   *
   * Only automatic restores are blocked. An explicit open (Ctrl+`, toolbar,
   * `ui.command`) still wins and shows the dock over the takeover: swallowing a
   * requested terminal would be a worse papercut than the one this fixes.
   */
  setSuppressed(suppressed: boolean): boolean {
    if (this.suppressed === suppressed) {
      return false;
    }
    this.suppressed = suppressed;
    if (suppressed) {
      this.hideWithoutPersisting();
      return false;
    }
    return this.restoreOpenState();
  }

  restoreOpenState(): boolean {
    if (
      this.suppressed ||
      !this.options.isAvailable() ||
      this.open ||
      (!this.isFullscreen() && !this.persistedOpen)
    ) {
      return false;
    }
    this.open = true;
    this.syncReservation();
    this.host.requestUpdate();
    return true;
  }

  setDock(dock: TDock, persist = true): void {
    this.dock = dock;
    this.syncReservation();
    if (persist) {
      this.persist();
    }
    this.host.requestUpdate();
  }

  persist(): void {
    this.persistedOpen = this.open;
    this.options.layout.save({
      open: this.open,
      dock: this.dock,
      height: this.height,
      width: this.width,
    });
  }

  syncReservation(): void {
    if (!this.reservesViewport()) {
      return;
    }
    const visible = this.options.isAvailable() && this.open;
    const root = document.documentElement.style;
    root.setProperty(
      `--oc-${this.options.reservationPrefix}-reserve-bottom`,
      visible && this.dock === "bottom" ? `${this.height}px` : "0px",
    );
    root.setProperty(
      `--oc-${this.options.reservationPrefix}-reserve-right`,
      visible && this.dock === "right" ? `${this.width}px` : "0px",
    );
  }

  private resize(event: CustomEvent<{ splitRatio: number }>): void {
    const horizontal = this.dock === "bottom";
    const minimum = horizontal ? this.options.layout.minHeight : this.options.layout.minWidth;
    const maximum = horizontal ? this.options.layout.maxHeight() : this.maxWidth();
    const size = Math.min(maximum, Math.max(minimum, (1 - event.detail.splitRatio) * this.size()));
    if (horizontal) {
      this.height = size;
    } else {
      this.width = size;
    }
    this.syncReservation();
    this.options.onResize?.();
    this.host.requestUpdate();
  }

  private size(): number {
    return this.dock === "bottom" ? window.innerHeight : window.innerWidth;
  }

  renderResizer(classPrefix: string, label: string): TemplateResult | typeof nothing {
    if (this.isFullscreen() || this.dock === "main") {
      return nothing;
    }
    const horizontal = this.dock === "bottom";
    const size = this.size();
    const minimum = horizontal ? this.options.layout.minHeight : this.options.layout.minWidth;
    const maximum = horizontal ? this.options.layout.maxHeight() : this.maxWidth();
    const current = horizontal ? this.height : this.width;
    return html`<resizable-divider
      class="${classPrefix}-resizer ${classPrefix}-resizer--${this.dock}"
      .orientation=${horizontal ? "horizontal" : "vertical"}
      .label=${label}
      .splitRatio=${1 - current / size}
      .minRatio=${1 - maximum / size}
      .maxRatio=${1 - minimum / size}
      .measureRatio=${() => 1 - (horizontal ? this.height : this.width) / this.size()}
      .measureSize=${() => this.size()}
      @resize=${(event: CustomEvent<{ splitRatio: number }>) => this.resize(event)}
      @resize-end=${() => this.persist()}
    ></resizable-divider>`;
  }

  private clearReservation(): void {
    if (!this.reservesViewport()) {
      return;
    }
    const root = document.documentElement.style;
    root.setProperty(`--oc-${this.options.reservationPrefix}-reserve-bottom`, "0px");
    root.setProperty(`--oc-${this.options.reservationPrefix}-reserve-right`, "0px");
  }

  // Only a standalone dock owns its panel's viewport reservation. Embedded, fullscreen,
  // and inline hosts are laid out by their parent, and the standalone dock of the same
  // panel can be open at the same time, so they neither reserve nor clear its properties.
  private reservesViewport(): boolean {
    return (
      this.options.reserveViewport !== false &&
      !this.isFullscreen() &&
      !(this.host instanceof HTMLElement && this.host.hasAttribute("embedded"))
    );
  }

  private isFullscreen(): boolean {
    return this.options.isFullscreen?.() === true;
  }

  private maxWidth(): number {
    return Math.max(
      this.options.layout.minWidth,
      Math.min(
        this.options.layout.maxWidth(),
        this.options.maxWidth?.() ?? Number.POSITIVE_INFINITY,
      ),
    );
  }
}
