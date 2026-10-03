import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { generateUUID } from "./uuid.ts";

// A slow resource gets a notice without throwing away its in-flight work. The
// terminal deadline uses the same budget as ordinary Gateway reads.
export const WIDGET_LOAD_NOTICE_MS = 10_000;
export const WIDGET_LOAD_TIMEOUT_MS = DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
export class WidgetRenderTimeoutError extends Error {}

type WidgetSandboxHostOptions = {
  frame: HTMLIFrameElement;
  sandboxOrigin: string;
  sandboxUrl: string;
  documentKey: string;
  /** Restricts the untrusted inner document, not the trusted transport shell. */
  allowScripts?: boolean;
  loadDocument: (signal: AbortSignal) => Promise<string>;
  onLoaded: () => void;
  onRendered?: () => void;
  onError: (error: unknown) => void;
  onReadyTimeout: () => void;
  onPending?: () => void;
  retryDocument?: (error: unknown) => boolean;
};

/** Fetches widget bytes alongside the isolated proxy, then joins their readiness. */
export class WidgetSandboxHost {
  private active = true;
  private proxyReady = false;
  private readyTimer: number | null = null;
  private retryTimer: number | null = null;
  private slowTimer: number | null = null;
  private retryDelayMs = 1_000;
  private documentLoaded = false;
  private renderId: string | null = null;
  private pendingDocument: string | null = null;
  private activeLoad: { controller: AbortController; timeout: number; notice: number } | null =
    null;

  constructor(private options: WidgetSandboxHostOptions) {
    // Owners finish installing their bridge before an immediate load can report back.
    queueMicrotask(() => this.start());
  }

  get frame(): HTMLIFrameElement {
    return this.options.frame;
  }

  get ready(): boolean {
    return this.proxyReady;
  }

  get loaded(): boolean {
    return this.documentLoaded;
  }

  update(options: WidgetSandboxHostOptions): void {
    const sandboxChanged =
      this.options.frame !== options.frame || this.options.sandboxUrl !== options.sandboxUrl;
    const documentChanged = this.options.documentKey !== options.documentKey;
    this.options = options;
    if (sandboxChanged || documentChanged) {
      this.reset();
    }
    if (sandboxChanged) {
      // Bytes may arrive early, but only the new proxy can enforce the new CSP.
      this.proxyReady = false;
    }
    this.start();
  }

  setActive(active: boolean): void {
    if (active === this.active) {
      return;
    }
    this.active = active;
    if (!active) {
      this.clearReadyTimeout();
      this.clearRetry();
      this.cancelLoad();
      return;
    }
    this.start();
  }

  reset(): void {
    this.clearRetry();
    this.cancelLoad();
    this.clearReadyTimeout();
    this.renderId = null;
    this.documentLoaded = false;
    this.pendingDocument = null;
  }

  dispose(): void {
    this.active = false;
    this.reset();
    this.proxyReady = false;
  }

  handleMessage(event: MessageEvent): void {
    if (event.source !== this.frame.contentWindow || event.origin !== this.options.sandboxOrigin) {
      return;
    }
    if (event.data?.method === "ui/notifications/sandbox-resource-loaded") {
      if (this.renderId && event.data?.params?.renderId === this.renderId) {
        this.clearReadyTimeout();
        this.renderId = null;
        this.options.onRendered?.();
      }
      return;
    }
    if (
      event.data?.method !== "ui/notifications/sandbox-proxy-ready" ||
      event.data?.params?.sandboxUrl !== this.options.sandboxUrl
    ) {
      return;
    }
    // Readiness is one-shot, so retain it even while a mounted widget is hidden.
    this.proxyReady = true;
    this.clearRetry();
    this.clearReadyTimeout();
    this.start();
  }

  handleFrameError(): void {
    if (!this.active || this.proxyReady || !this.frame.isConnected) {
      return;
    }
    this.clearReadyTimeout();
    this.retrySandboxFrame();
  }

  private start(): void {
    if (!this.active || !this.frame.isConnected || this.retryTimer !== null) {
      return;
    }
    this.scheduleReadyTimeout();
    this.deliverDocument();
    void this.loadDocument();
  }

  private clearReadyTimeout(): void {
    if (this.slowTimer !== null) {
      window.clearTimeout(this.slowTimer);
      this.slowTimer = null;
    }
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private scheduleReadyTimeout(): void {
    if (
      (this.proxyReady && (!this.renderId || !this.options.onRendered)) ||
      this.readyTimer !== null
    ) {
      return;
    }
    this.slowTimer = window.setTimeout(() => {
      this.slowTimer = null;
      if (this.active && this.frame.isConnected) {
        this.options.onPending?.();
      }
    }, WIDGET_LOAD_NOTICE_MS);
    this.readyTimer = window.setTimeout(() => {
      this.readyTimer = null;
      if (this.active && !this.proxyReady && this.frame.isConnected) {
        this.retrySandboxFrame();
      } else if (this.active && this.renderId && this.frame.isConnected) {
        this.options.onError(
          new WidgetRenderTimeoutError(
            "Widget content did not finish loading. Reload the dashboard to try again.",
          ),
        );
      }
    }, WIDGET_LOAD_TIMEOUT_MS);
  }

  private retrySandboxFrame(): void {
    this.proxyReady = false;
    this.reset();
    this.options.onReadyTimeout();
    this.scheduleRetry(() => {
      // A new ticket cannot recover an outer frame that never reached its script.
      this.frame.src = this.options.sandboxUrl;
      this.start();
    });
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(retry: () => void): void {
    if (!this.active || !this.frame.isConnected || this.retryTimer !== null) {
      return;
    }
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.active && this.frame.isConnected) {
        retry();
      }
    }, this.retryDelayMs);
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
  }

  private cancelLoad(): void {
    const load = this.activeLoad;
    // Retire ownership before aborting: a stale rejection must not spend retries.
    this.activeLoad = null;
    if (load) {
      window.clearTimeout(load.timeout);
      window.clearTimeout(load.notice);
      load.controller.abort();
    }
  }

  private async loadDocument(): Promise<void> {
    const { loadDocument } = this.options;
    if (
      this.loaded ||
      this.pendingDocument !== null ||
      this.activeLoad !== null ||
      !this.frame.contentWindow
    ) {
      return;
    }
    const controller = new AbortController();
    const load = {
      controller,
      notice: window.setTimeout(() => {
        if (this.activeLoad === load) {
          this.options.onPending?.();
        }
      }, WIDGET_LOAD_NOTICE_MS),
      timeout: window.setTimeout(
        () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
        WIDGET_LOAD_TIMEOUT_MS,
      ),
    };
    this.activeLoad = load;
    let rejectAborted!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => {
        const reason: unknown = controller.signal.reason;
        reject(reason instanceof Error ? reason : new DOMException("Aborted", "AbortError"));
      };
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    try {
      const html = await Promise.race([loadDocument(controller.signal), aborted]);
      if (!this.active || this.activeLoad !== load || !this.frame.isConnected) {
        return;
      }
      this.pendingDocument = html;
      this.deliverDocument();
    } catch (error) {
      if (this.activeLoad === load && this.active && this.frame.isConnected) {
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        this.options.onError(failure);
        if (this.options.retryDocument?.(failure)) {
          this.scheduleRetry(() => this.start());
        }
      }
    } finally {
      window.clearTimeout(load.timeout);
      window.clearTimeout(load.notice);
      controller.signal.removeEventListener("abort", rejectAborted);
      if (this.activeLoad === load) {
        this.activeLoad = null;
      }
    }
  }

  private deliverDocument(): void {
    const document = this.pendingDocument;
    if (!this.active || !this.proxyReady || document === null || !this.frame.isConnected) {
      return;
    }
    this.renderId = generateUUID();
    this.scheduleReadyTimeout();
    this.frame.contentWindow?.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: {
          html: document,
          renderId: this.renderId,
          ...(this.options.allowScripts === false ? { allowScripts: false } : {}),
        },
      },
      this.options.sandboxOrigin,
    );
    this.pendingDocument = null;
    this.documentLoaded = true;
    this.retryDelayMs = 1_000;
    this.options.onLoaded();
  }
}
