import type { NativeBrowserTab } from "../../app/native-browser-bridge.ts";
import {
  resizeBrowserViewport,
  type BrowserPageMetrics,
  type BrowserRequestClient,
} from "./browser-client.ts";
import type { BrowserPanelOperationOwnership } from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelPendingInput } from "./browser-panel-pending-input.ts";
import type { BrowserPanelStream } from "./browser-panel-stream.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";

interface BrowserPanelViewportHost {
  readonly host: { browserPanelIsOpen(): boolean; requestUpdate(): void };
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly activeTargetId: string | null;
  readonly view: BrowserPanelView | null;
  readonly operations: Pick<BrowserPanelOperationOwnership, "captureClient">;
  readonly stream: Pick<BrowserPanelStream, "resize">;
  readonly pendingInput: Pick<BrowserPanelPendingInput, "scheduleViewportResize">;
  runAction(action: (client: BrowserRequestClient) => Promise<void>): Promise<boolean>;
}

const VIEWPORT_RESIZE_DELAY_MS = 300;
const MIN_VIEWPORT_DIMENSION = 100;
const MAX_VIEWPORT_DIMENSION = 8192;

const FIXED_VIEWPORT_PREF_KEY = "openclaw.browserPanel.fixedViewport";

/**
 * Fixed-viewport viewing: the panel scales the live frame instead of resizing
 * the remote page, so the page keeps the viewport its agent or document chose.
 */
function readFixedViewportPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(FIXED_VIEWPORT_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFixedViewportPreference(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(FIXED_VIEWPORT_PREF_KEY, value ? "1" : "0");
  } catch {
    // Storage can be unavailable (private mode, opaque origin); keep the in-memory value.
  }
}

/** Reconciles the visible screenshot stage with its remote page's CSS viewport. */
export class BrowserPanelViewportController {
  observedViewportSize: { width: number; height: number } | null = null;
  /** Fixed-viewport viewing (toolbar toggle); persisted in localStorage. */
  fixedViewportView = readFixedViewportPreference();
  private lastRequestedViewport: { targetId: string; width: number; height: number } | null = null;

  constructor(private readonly controller: BrowserPanelViewportHost) {}

  /** Toolbar toggle: the page owns its viewport while this is on. */
  setFixedViewport(value: boolean): void {
    if (this.fixedViewportView === value) {
      return;
    }
    writeFixedViewportPreference(value);
    this.fixedViewportView = value;
    this.controller.host.requestUpdate();
    this.invalidate();
    this.schedule();
  }

  invalidate(): void {
    // The agent may resize the same document between panel presentations.
    this.lastRequestedViewport = null;
  }

  captured(metrics: BrowserPageMetrics | null): void {
    if (
      metrics &&
      this.observedViewportSize &&
      (Math.abs(metrics.cssWidth - this.observedViewportSize.width) > 1 ||
        Math.abs(metrics.cssHeight - this.observedViewportSize.height) > 1)
    ) {
      this.schedule();
    }
  }

  resize(width: number, height: number): void {
    this.observedViewportSize = { width, height };
    // The dock geometry changed: repaint marks against the new stage even when
    // the remote viewport itself is left alone (fixed-viewport viewing).
    this.controller.host.requestUpdate();
    this.schedule();
  }

  schedule(): void {
    if (this.controller.native.activeTab) {
      return;
    }
    this.controller.pendingInput.scheduleViewportResize(VIEWPORT_RESIZE_DELAY_MS, () =>
      this.syncViewport(),
    );
  }

  private syncViewport(): void {
    const targetId = this.controller.activeTargetId;
    const observed = this.observedViewportSize;
    // A debounced sync can outlive an ordinary dock close; a hidden panel must
    // never resize the agent-controlled browser.
    if (
      this.controller.native.activeTab ||
      !this.controller.host.browserPanelIsOpen() ||
      !this.controller.operations.captureClient()
    ) {
      return;
    }
    if (!targetId || !observed) {
      return;
    }
    this.controller.stream.resize();
    if (this.fixedViewportView) {
      // Fixed-viewport viewing: the page owns its viewport and the panel scales
      // the live frame to fit, instead of resizing the remote page.
      return;
    }
    const width = Math.min(
      MAX_VIEWPORT_DIMENSION,
      Math.max(MIN_VIEWPORT_DIMENSION, Math.round(observed.width)),
    );
    const height = Math.min(
      MAX_VIEWPORT_DIMENSION,
      Math.max(MIN_VIEWPORT_DIMENSION, Math.round(observed.height)),
    );
    const currentView = this.controller.view?.targetId === targetId ? this.controller.view : null;
    // A failed or still-pending capture has not established the surface that
    // owns pointer coordinates. Wait for a successful view before syncing its
    // viewport, otherwise error-state layout changes can create a resize and
    // recapture loop.
    if (!currentView) {
      return;
    }
    const metrics = currentView.metrics;
    if (
      metrics &&
      Math.abs(metrics.cssWidth - width) <= 1 &&
      Math.abs(metrics.cssHeight - height) <= 1
    ) {
      return;
    }
    // A remote that cannot honor the exact size is not re-asked until the panel size or tab changes.
    if (
      this.lastRequestedViewport?.targetId === targetId &&
      this.lastRequestedViewport.width === width &&
      this.lastRequestedViewport.height === height
    ) {
      return;
    }
    this.lastRequestedViewport = { targetId, width, height };
    void this.controller.runAction((client) =>
      resizeBrowserViewport(client, { targetId, width, height }),
    );
  }
}
