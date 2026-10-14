import type { NativeBrowserTab } from "../../app/native-browser-bridge.ts";
import { resizeBrowserViewport, type BrowserRequestClient } from "./browser-client.ts";
import type { BrowserPanelOperationOwnership } from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelView } from "./browser-panel-surface.ts";

interface BrowserPanelViewportHost {
  readonly host: { browserPanelIsOpen(): boolean };
  readonly native: { readonly activeTab: NativeBrowserTab | undefined };
  readonly activeTargetId: string | null;
  readonly view: BrowserPanelView | null;
  readonly operations: Pick<BrowserPanelOperationOwnership, "captureClient">;
  runAction(action: (client: BrowserRequestClient) => Promise<void>): Promise<boolean>;
}

type ViewportResize = {
  targetId: string;
  width: number;
  height: number;
  remoteWidth: number | undefined;
  remoteHeight: number | undefined;
  acknowledged: boolean;
  /** Earlier requests for this same mismatch; sets the retry backoff. */
  retries: number;
  /** Earlier requests for this mismatch that were accepted but never reached the page. */
  unapplied: number;
  /** Whether the request failed, as opposed to being accepted. */
  failed: boolean;
  /** When the request settled; the retry backoff counts from here. */
  settledAt: number;
};

const VIEWPORT_RESIZE_DELAY_MS = 300;
// A failed resize is retried while the mismatch lasts: after 2 s, 4 s, 8 s, ... at most 30 s apart.
const VIEWPORT_RETRY_BASE_MS = 2_000;
const VIEWPORT_RETRY_MAX_MS = 30_000;
// An accepted resize the page never shows is retried this often, then treated as a refusal.
const VIEWPORT_UNAPPLIED_RETRIES = 3;
const MIN_VIEWPORT_DIMENSION = 100;
const MAX_VIEWPORT_DIMENSION = 8192;

/** Owns panel fitting for both screenshots and streamed frames. */
export class BrowserPanelViewportController {
  observedViewportSize: { width: number; height: number } | null = null;
  private lastResize: ViewportResize | null = null;
  private resizing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly controller: BrowserPanelViewportHost) {}

  invalidate(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.forgetResize();
  }

  /** Forgets earlier requests, e.g. when a reconnected stream may serve a restarted browser. */
  forgetResize(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.lastResize = null;
  }

  captured(): void {
    const request = this.lastResize;
    const view = this.controller.view;
    if (
      request &&
      view?.targetId === request.targetId &&
      view.metrics &&
      Math.abs(view.metrics.cssWidth - request.width) <= 1 &&
      Math.abs(view.metrics.cssHeight - request.height) <= 1
    ) {
      request.acknowledged = true;
    }
    // Repainting frames join the pending reconciliation without postponing it.
    this.schedule();
  }

  resize(width: number, height: number): void {
    this.observedViewportSize = { width, height };
    clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule();
  }

  private schedule(): void {
    if (
      this.controller.native.activeTab ||
      !this.controller.host.browserPanelIsOpen() ||
      !this.observedViewportSize
    ) {
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.syncViewport();
    }, VIEWPORT_RESIZE_DELAY_MS);
  }

  private syncViewport(): void {
    // Only a pending retry of an unchanged mismatch keeps this timer; every other outcome drops it.
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const targetId = this.controller.activeTargetId;
    const observed = this.observedViewportSize;
    const view = this.controller.view;
    if (
      this.controller.native.activeTab ||
      !this.controller.host.browserPanelIsOpen() ||
      !this.controller.operations.captureClient() ||
      !targetId ||
      !observed ||
      view?.targetId !== targetId ||
      this.resizing
    ) {
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
    const remoteWidth = view.metrics?.cssWidth;
    const remoteHeight = view.metrics?.cssHeight;
    if (
      remoteWidth !== undefined &&
      remoteHeight !== undefined &&
      Math.abs(remoteWidth - width) <= 1 &&
      Math.abs(remoteHeight - height) <= 1
    ) {
      this.lastResize = null;
      return;
    }
    const previous = this.lastResize;
    let retries = 0;
    let unapplied = 0;
    // The page still shows the size this same request saw. Retry a failed request with backoff
    // while the mismatch lasts. Retry an accepted one only a few times: a browser that refuses
    // the size keeps accepting it, and repeating it for every frame would be a request loop.
    if (
      previous?.targetId === targetId &&
      !previous.acknowledged &&
      previous.width === width &&
      previous.height === height &&
      previous.remoteWidth === remoteWidth &&
      previous.remoteHeight === remoteHeight
    ) {
      unapplied = previous.unapplied + (previous.failed ? 0 : 1);
      if (unapplied > VIEWPORT_UNAPPLIED_RETRIES) {
        return;
      }
      const backoff = Math.min(
        VIEWPORT_RETRY_MAX_MS,
        VIEWPORT_RETRY_BASE_MS * 2 ** previous.retries,
      );
      const wait = previous.settledAt + backoff - Date.now();
      if (wait > 0) {
        // A static page sends no frames, so the retry cannot wait for the next one.
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.schedule();
        }, wait);
        return;
      }
      retries = previous.retries + 1;
    }
    const request: ViewportResize = {
      targetId,
      width,
      height,
      remoteWidth,
      remoteHeight,
      acknowledged: false,
      retries,
      unapplied,
      failed: false,
      settledAt: Date.now(),
    };
    this.lastResize = request;
    // Invalidation retires observations, but an issued resize still has to settle.
    this.resizing = true;
    void this.controller
      .runAction((client) => resizeBrowserViewport(client, request))
      .then((accepted) => {
        request.failed = !accepted;
        request.settledAt = Date.now();
      })
      .finally(() => {
        this.resizing = false;
        this.schedule();
      });
  }
}
