import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGatewayWebSocketUrl } from "../../lib/gateway-websocket-url.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { BrowserRequestClient } from "./browser-client.ts";
import { isBrowserScreencastUnsupportedError, requestBrowserScreencast } from "./browser-client.ts";
import type {
  BrowserPanelHost,
  BrowserPanelOperations,
} from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelStateWriter } from "./browser-panel-state.ts";
import { loadBrowserPanelImage } from "./browser-panel-surface.ts";
import { browserRouteKey } from "./browser-target.ts";

type BrowserScreencastMeta = { url: string; title: string };
type BrowserScreencastFrame = {
  blob: Blob;
  url: string;
  cssWidth: number;
  cssHeight: number;
};

type BrowserScreencastOptions = {
  gatewayUrl: string;
  wsPath: string;
  onReady: (meta: BrowserScreencastMeta & { targetId: string }) => void;
  onMeta: (meta: BrowserScreencastMeta) => void;
  onFrame: (frame: BrowserScreencastFrame) => void;
  onClose: (detail: { code: number; reason: string }) => void;
};

class BrowserScreencastClient {
  private readonly socket: WebSocket;
  private readonly events = new AbortController();
  private closed = false;

  constructor(private readonly options: BrowserScreencastOptions) {
    this.socket = new WebSocket(resolveGatewayWebSocketUrl(options.wsPath, options.gatewayUrl));
    this.socket.binaryType = "arraybuffer";
    const listenerOptions = { signal: this.events.signal };
    listen(this.socket, "message", (event) => this.receive(event.data), listenerOptions);
    listen(this.socket, "close", ({ code, reason }) => this.finish(code, reason), listenerOptions);
    listen(
      this.socket,
      "error",
      () => {
        this.finish(1006, "");
        this.socket.close();
      },
      listenerOptions,
    );
  }

  close(): void {
    this.closed = true;
    this.events.abort();
    this.socket.close();
  }

  private finish(code: number, reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.events.abort();
    this.options.onClose({ code, reason });
  }

  private receive(data: unknown): void {
    if (this.closed) {
      return;
    }
    try {
      if (typeof data === "string") {
        const message = asRecord(JSON.parse(data));
        if (message?.type === "error") {
          this.finish(1011, "");
          this.socket.close();
          return;
        }
        if (typeof message?.url !== "string" || typeof message.title !== "string") {
          throw new Error("Invalid screencast metadata");
        }
        if (message.type === "ready" && typeof message.targetId === "string") {
          this.options.onReady({
            targetId: message.targetId,
            url: message.url,
            title: message.title,
          });
        } else if (message.type === "meta") {
          this.options.onMeta({ url: message.url, title: message.title });
        } else {
          throw new Error("Invalid screencast message");
        }
        return;
      }
      if (!(data instanceof ArrayBuffer) || data.byteLength < 5) {
        throw new Error("Invalid screencast frame");
      }
      const headerLength = new DataView(data).getUint32(0);
      if (headerLength === 0 || headerLength >= data.byteLength - 4) {
        throw new Error("Invalid screencast header length");
      }
      const header = asRecord(
        JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, headerLength))),
      );
      if (
        typeof header?.url !== "string" ||
        typeof header.cssWidth !== "number" ||
        !Number.isFinite(header.cssWidth) ||
        header.cssWidth <= 0 ||
        typeof header.cssHeight !== "number" ||
        !Number.isFinite(header.cssHeight) ||
        header.cssHeight <= 0
      ) {
        throw new Error("Invalid screencast dimensions");
      }
      this.options.onFrame({
        blob: new Blob([new Uint8Array(data, 4 + headerLength)], { type: "image/jpeg" }),
        url: header.url,
        cssWidth: header.cssWidth,
        cssHeight: header.cssHeight,
      });
    } catch {
      this.finish(1002, "");
      this.socket.close();
    }
  }
}

const RETRY_DELAY_MS = 10_000;
const RESIZE_RESTART_DEBOUNCE_MS = 500;

interface BrowserPanelStreamHost extends BrowserPanelStateWriter<
  "activeTargetId" | "view" | "tabs" | "loading"
> {
  readonly host: BrowserPanelHost;
  readonly mode: "interact" | "annotate" | "inspect";
  readonly input: { elements: { stage?: HTMLElement; viewport?: HTMLElement } };
  readonly operations: Pick<
    BrowserPanelOperations,
    "epoch" | "route" | "isLive" | "hasPendingCapture" | "capturedTabs" | "forgetNavigation"
  >;
  readonly observedViewportSize: { width: number; height: number } | null;
  syncUrlDraft(url: string): void;
  clearUnavailableView(): boolean;
  refreshView(targetId: string): Promise<void>;
  refreshAll(): Promise<void>;
}

type Recovery = Pick<Attempt, "targetId" | "epoch" | "client">;

type Attempt = {
  targetId: string;
  epoch: number;
  client: BrowserRequestClient;
  width: number;
  live: boolean;
  connection?: BrowserScreencastClient;
  controller: AbortController;
  firstFrame: Promise<boolean>;
  settle: (received: boolean) => void;
  metadata?: BrowserScreencastMeta;
  pendingFrame?: BrowserScreencastFrame;
  decoding: boolean;
  presented: boolean;
};

/** Owns stream attachment and the object URLs of the active browser surface. */
export class BrowserPanelStream {
  private attempt?: Attempt;
  frameRevision = 0;
  private scope?: { client: BrowserPanelHost["client"]; route: string };
  private unsupported = false;
  private readonly lastFailures = new Map<string, number>();
  private objectUrl?: string;
  private decodingUrl?: string;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recovery?: Recovery;
  private readonly retiringUrls = new Set<string>();

  constructor(private readonly host: BrowserPanelStreamHost) {}

  ownsView(targetId: string | null): boolean {
    return Boolean(
      this.attempt?.live && this.attempt.targetId === targetId && this.current(this.attempt),
    );
  }

  private current(attempt: Attempt): boolean {
    return (
      this.attempt === attempt &&
      this.host.activeTargetId === attempt.targetId &&
      this.host.operations.isLive(attempt.epoch, attempt.client)
    );
  }

  private dimensions() {
    const { stage, viewport } = this.host.input.elements;
    const width =
      stage?.clientWidth || viewport?.clientWidth || this.host.observedViewportSize?.width || 1280;
    const height = viewport?.clientHeight || this.host.observedViewportSize?.height || width;
    const ratio = globalThis.devicePixelRatio || 1;
    return {
      width,
      maxWidth: Math.min(2000, Math.ceil(width * ratio)),
      maxHeight: Math.min(2000, Math.ceil(Math.max(width, height) * ratio)),
    };
  }

  async ensure(targetId: string, client: BrowserRequestClient, epoch: number): Promise<boolean> {
    const route = browserRouteKey(this.host.operations.route);
    if (!this.scope || this.scope.client !== this.host.host.client || this.scope.route !== route) {
      this.close();
      this.scope = { client: this.host.host.client, route };
      this.unsupported = false;
    }
    if (this.attempt && this.current(this.attempt) && this.attempt.targetId === targetId) {
      return this.attempt.live || (await this.attempt.firstFrame);
    }
    // Only failed attempts back off; navigation and resize close streams on purpose and restart at once.
    if (
      this.unsupported ||
      Date.now() - (this.lastFailures.get(targetId) ?? -Infinity) < RETRY_DELAY_MS
    ) {
      return false;
    }
    this.close(false);
    const dimensions = this.dimensions();
    const { promise: firstFrame, resolve } = Promise.withResolvers<boolean>();
    const timeout = setTimeout(() => {
      if (this.current(attempt)) {
        this.recover(attempt);
      } else if (this.attempt === attempt) {
        this.close(false);
      }
    }, DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
    const settle = (received: boolean) => {
      clearTimeout(timeout);
      resolve(received);
    };
    const attempt: Attempt = {
      targetId,
      client,
      epoch,
      width: dimensions.width,
      live: false,
      controller: new AbortController(),
      firstFrame,
      settle,
      decoding: false,
      presented: false,
    };
    this.attempt = attempt;
    void this.connect(attempt, { maxWidth: dimensions.maxWidth, maxHeight: dimensions.maxHeight });
    return await firstFrame;
  }

  private async connect(
    attempt: Attempt,
    dimensions: { maxWidth: number; maxHeight: number },
  ): Promise<void> {
    try {
      const wsPath = await requestBrowserScreencast(
        attempt.client,
        { targetId: attempt.targetId, ...dimensions },
        { signal: attempt.controller.signal },
      );
      if (!this.current(attempt)) {
        return;
      }
      attempt.connection = new BrowserScreencastClient({
        gatewayUrl: this.host.host.client!.gatewayUrl,
        wsPath,
        onReady: ({ url, title }) => this.updateMetadata(attempt, { url, title }),
        onMeta: (meta) => this.updateMetadata(attempt, meta),
        onFrame: (frame) => {
          if (!this.current(attempt)) {
            return;
          }
          // A received frame owns the view even while its image is decoding.
          this.frameRevision += 1;
          attempt.live = true;
          attempt.pendingFrame = frame;
          if (!attempt.decoding) {
            void this.decodeFrames(attempt);
          }
        },
        onClose: ({ code }) => {
          if (!this.current(attempt)) {
            return;
          }
          if (code !== 4003 && code !== 4004) {
            this.recover(attempt);
            return;
          }
          this.close();
          if (code === 4003) {
            this.host.setState(
              "tabs",
              this.host.tabs.map((tab) =>
                tab.id === attempt.targetId
                  ? { ...tab, url: "", urlUnavailableReason: "navigation_blocked" }
                  : tab,
              ),
            );
            this.host.clearUnavailableView();
          } else if (code === 4004) {
            void this.host.refreshAll();
          }
        },
      });
    } catch (error) {
      if (this.current(attempt)) {
        this.unsupported = isBrowserScreencastUnsupportedError(error);
        if (this.unsupported) {
          this.close(false);
        } else {
          this.recover(attempt);
        }
      }
    }
  }

  private recover(attempt: Attempt): void {
    this.lastFailures.set(attempt.targetId, Date.now());
    this.close(false);
    this.recovery = { targetId: attempt.targetId, epoch: attempt.epoch, client: attempt.client };
    // A received frame invalidates older screenshots even if decoding has not finished.
    this.scheduleRecovery(attempt.live ? 0 : RETRY_DELAY_MS);
  }

  private scheduleRecovery(delay: number): void {
    const recovery = this.recovery;
    if (!recovery) {
      return;
    }
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (
        this.host.activeTargetId !== recovery.targetId ||
        !this.host.operations.isLive(recovery.epoch, recovery.client)
      ) {
        this.recovery = undefined;
        return;
      }
      // Capture modes pin their image; flushPendingFrame resumes recovery on exit.
      if (this.host.mode !== "interact") {
        return;
      }
      // A stalled screenshot must not hold the reconnect deadline.
      this.scheduleRecovery(RETRY_DELAY_MS);
      void this.resume(recovery);
    }, delay);
  }

  private async resume(recovery: Recovery): Promise<void> {
    if (await this.ensure(recovery.targetId, recovery.client, recovery.epoch)) {
      return;
    }
    // A failed reconnect must not discard a fallback screenshot that is still in flight.
    if (
      this.host.activeTargetId === recovery.targetId &&
      this.host.operations.isLive(recovery.epoch, recovery.client) &&
      !this.host.operations.hasPendingCapture
    ) {
      void this.host.refreshView(recovery.targetId);
    }
  }

  private updateMetadata(attempt: Attempt, metadata: BrowserScreencastMeta): void {
    if (!this.current(attempt)) {
      return;
    }
    attempt.metadata = metadata;
    this.host.setState(
      "tabs",
      this.host.tabs.map((tab) =>
        tab.id === attempt.targetId
          ? { ...tab, ...metadata, urlUnavailableReason: undefined }
          : tab,
      ),
    );
    this.host.syncUrlDraft(metadata.url);
  }

  flushPendingFrame(): void {
    this.scheduleRecovery(0);
    const attempt = this.attempt;
    if (attempt && this.current(attempt) && !attempt.decoding) {
      void this.decodeFrames(attempt);
    }
    this.resize();
  }

  private async decodeFrames(attempt: Attempt): Promise<void> {
    attempt.decoding = true;
    try {
      while (this.current(attempt) && attempt.pendingFrame) {
        const mode = this.host.mode;
        if (mode !== "interact") {
          return;
        }
        const frame = attempt.pendingFrame;
        const metadata = attempt.metadata;
        attempt.pendingFrame = undefined;
        const objectUrl = URL.createObjectURL(frame.blob);
        this.decodingUrl = objectUrl;
        const image = await loadBrowserPanelImage(objectUrl);
        if (!this.current(attempt)) {
          return;
        }
        // Capture mode can begin while an image is decoding; keep the newest frame for exit.
        if (this.host.mode !== "interact") {
          attempt.pendingFrame ??= frame;
          URL.revokeObjectURL(objectUrl);
          this.decodingUrl = undefined;
          return;
        }
        if (metadata !== attempt.metadata && attempt.metadata?.url !== frame.url) {
          URL.revokeObjectURL(objectUrl);
          this.decodingUrl = undefined;
          continue;
        }
        const previousUrl = this.objectUrl;
        this.decodingUrl = undefined;
        this.objectUrl = objectUrl;
        const title =
          attempt.metadata?.url === frame.url
            ? attempt.metadata.title
            : (this.host.tabs.find((tab) => tab.id === attempt.targetId)?.title ?? "");
        const metrics = {
          cssWidth: frame.cssWidth,
          cssHeight: frame.cssHeight,
          title,
          url: frame.url,
        };
        this.host.setState(
          "tabs",
          this.host.operations.capturedTabs(this.host.tabs, attempt.targetId, metrics, frame.url),
        );
        this.host.setState("view", {
          targetId: attempt.targetId,
          dataUrl: objectUrl,
          image,
          url: frame.url,
          metrics,
          ...(this.host.operations.route
            ? { browserTab: { ...this.host.operations.route, targetId: attempt.targetId } }
            : {}),
        });
        this.host.operations.forgetNavigation(attempt.client, attempt.targetId);
        this.host.syncUrlDraft(frame.url);
        if (!attempt.presented) {
          attempt.presented = true;
          this.host.setState("loading", false);
        }
        attempt.settle(true);
        await this.retireAfterUpdate(previousUrl);
      }
    } catch {
      if (this.current(attempt)) {
        this.recover(attempt);
      }
    } finally {
      attempt.decoding = false;
    }
  }

  private resized(attempt: Attempt): boolean {
    return Math.abs(this.dimensions().width - attempt.width) / attempt.width > 0.3;
  }

  resize(): void {
    const attempt = this.attempt;
    if (!attempt || !this.current(attempt) || !this.resized(attempt)) {
      return;
    }
    // Coalesce a burst of layout changes into one restart.
    this.resizeTimer ??= setTimeout(() => {
      this.resizeTimer = undefined;
      if (this.attempt !== attempt || !this.current(attempt) || !this.resized(attempt)) {
        return;
      }
      // Capture modes pin their image; flushPendingFrame restarts the stream on exit.
      if (this.host.mode !== "interact") {
        return;
      }
      this.close(false);
      void this.host.refreshView(attempt.targetId);
    }, RESIZE_RESTART_DEBOUNCE_MS);
  }

  releaseReplacedView(): void {
    const previousUrl = this.objectUrl;
    this.objectUrl = undefined;
    void this.retireAfterUpdate(previousUrl);
  }

  private async retireAfterUpdate(url?: string): Promise<void> {
    if (url) {
      this.retiringUrls.add(url);
    }
    // The previous image must survive until Lit has committed its replacement.
    await this.host.host.updateComplete;
    if (url && this.retiringUrls.delete(url)) {
      URL.revokeObjectURL(url);
    }
  }

  close(releaseView = true): void {
    if (releaseView) {
      // Intentional teardown starts a new owner; it must not inherit an orphaned backoff.
      this.lastFailures.clear();
    }
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recovery = undefined;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
    const attempt = this.attempt;
    this.attempt = undefined;
    attempt?.controller.abort();
    attempt?.settle(false);
    attempt?.connection?.close();
    for (const url of [
      releaseView ? this.objectUrl : undefined,
      this.decodingUrl,
      ...(releaseView ? this.retiringUrls : []),
    ]) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    if (releaseView) {
      this.objectUrl = undefined;
      this.retiringUrls.clear();
    }
    this.decodingUrl = undefined;
  }
}
