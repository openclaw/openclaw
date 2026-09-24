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
};

const VIEWPORT_RESIZE_DELAY_MS = 300;
const MIN_VIEWPORT_DIMENSION = 100;
const MAX_VIEWPORT_DIMENSION = 8192;

/** Owns panel fitting for both screenshots and streamed frames. */
export class BrowserPanelViewportController {
  observedViewportSize: { width: number; height: number } | null = null;
  private lastResize: ViewportResize | null = null;
  private resizing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly controller: BrowserPanelViewportHost) {}

  invalidate(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
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
    // Suppress an unchanged refusal, not a later resize by another browser user.
    if (
      previous?.targetId === targetId &&
      !previous.acknowledged &&
      previous.width === width &&
      previous.height === height &&
      previous.remoteWidth === remoteWidth &&
      previous.remoteHeight === remoteHeight
    ) {
      return;
    }
    const request = {
      targetId,
      width,
      height,
      remoteWidth,
      remoteHeight,
      acknowledged: false,
    };
    this.lastResize = request;
    // Invalidation retires observations, but an issued resize still has to settle.
    this.resizing = true;
    void this.controller
      .runAction((client) => resizeBrowserViewport(client, request))
      .finally(() => {
        this.resizing = false;
        this.schedule();
      });
  }
}
