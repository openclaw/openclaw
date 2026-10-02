import { consume } from "@lit/context";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  resolveSafeTimeoutDelayMs,
} from "@openclaw/gateway-client/browser";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../lib/chat/canvas-widget-frame-generation.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isAwaitingGatewayFailure, isGatewayAvailable } from "../lib/gateway-availability.ts";
import {
  WidgetSandboxHost,
  WIDGET_LOAD_TIMEOUT_MS,
  WIDGET_LOAD_NOTICE_MS,
} from "../lib/widget-sandbox-host.ts";
import { registerWidgetThemeFrame, postWidgetTheme } from "../lib/widget-theme.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { allowWidgetPrompt, dispatchWidgetPrompt } from "./mcp-app-security.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

type WidgetClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type ViewBinding = {
  client: WidgetClient;
  generation: number;
  docId: string;
  sessionKey: string;
  connectionRevision: number;
  gatewayUrl: string;
  profileId: string | null;
  recoveryScope: string | undefined;
};
// One wake attempt per session/document per page load, including remounts.
const reportedRuntimeErrors = new Set<string>();
// Fresh renders ping the agent; old restored history only shows the notice.
const WIDGET_RUNTIME_ERROR_REPORT_WINDOW_MS = 10 * 60_000;
const pendingViews = new WeakMap<
  WidgetClient,
  {
    generation: number;
    requests: Map<string, Promise<CanvasDocumentViewResult>>;
  }
>();

function loadCanvasView(binding: ViewBinding): Promise<CanvasDocumentViewResult> {
  let pending = pendingViews.get(binding.client);
  if (!pending || pending.generation !== binding.generation) {
    pending = { generation: binding.generation, requests: new Map() };
    pendingViews.set(binding.client, pending);
  }
  const existing = pending.requests.get(binding.docId);
  if (existing) {
    return existing;
  }
  const request = binding.client.request<CanvasDocumentViewResult>(
    "canvas.document.view",
    { docId: binding.docId },
    { timeoutMs: WIDGET_LOAD_TIMEOUT_MS },
  );
  // Canvas also supports replacing a named document. Share concurrent reads,
  // but only the mounted view retains bytes; a remount revalidates the source.
  if (pending.requests.size < 32) {
    const requests = pending.requests;
    requests.set(binding.docId, request);
    void request.finally(() => requests.delete(binding.docId)).catch(() => {});
  }
  return request;
}

export class OpenClawCanvasWidgetView extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property() docId = "";
  @property() sessionKey = "";
  @property({ type: Number }) messageTimestamp?: number;
  @property() override title = "";
  @property({ type: Number }) preferredHeight?: number;
  @property({ type: Number }) connectionGeneration = 0;
  @state() private view?: CanvasDocumentViewResult;
  @state() private error = "";
  @state() private runtimeError = "";
  @state() private resourceError = false;
  @state() private contentHeight?: number;
  private binding?: ViewBinding;
  private sandboxHost?: WidgetSandboxHost;
  private promptPort?: MessagePort;
  private sandboxOrigin = "";
  private releaseTheme?: () => void;
  private scriptsAllowed = true;
  private sandboxGeneration = 0;
  private validated?: ViewBinding;
  private viewOwner?: ViewBinding;
  private retryTimer?: number;
  private slowTimer?: number;
  private retryDelayMs = 1_000;
  @state() private pending = false;

  constructor() {
    super();
    new SubscriptionsController(this).watchStore(() => this.context?.gateway);
  }

  private clearRetry(): void {
    window.clearTimeout(this.slowTimer);
    this.slowTimer = undefined;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private scheduleRetry(binding: ViewBinding, retryAfterMs = 0): void {
    if (this.retryTimer !== undefined) {
      return;
    }
    this.pending = true;
    this.retryTimer = window.setTimeout(
      () => {
        this.retryTimer = undefined;
        if (this.isCurrent(binding)) {
          this.binding = undefined;
          this.requestUpdate();
        }
      },
      resolveSafeTimeoutDelayMs(Math.max(this.retryDelayMs, retryAfterMs)),
    );
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
  }

  @property({ type: Boolean })
  get allowScripts(): boolean {
    return this.scriptsAllowed;
  }

  set allowScripts(value: boolean) {
    if (value !== this.scriptsAllowed) {
      // Revoke prompt access before Lit replaces the browsing context.
      this.clearSandbox();
      this.sandboxGeneration += 1;
      if (this.view) {
        this.error = "";
      }
      this.scriptsAllowed = value;
    }
  }

  get documentHtml(): string | undefined {
    return this.sameOwner(this.viewOwner) ? this.view?.html : undefined;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.handleMessage);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("message", this.handleMessage);
    this.clearView();
    super.disconnectedCallback();
  }

  private clearView(): void {
    this.clearRetry();
    this.validated = undefined;
    this.viewOwner = undefined;
    this.sandboxGeneration += 1;
    this.runtimeError = "";
    this.resourceError = false;
    this.binding = undefined;
    this.view = undefined;
    this.clearSandbox();
  }

  private clearSandbox(): void {
    this.sandboxHost?.dispose();
    this.sandboxHost = undefined;
    this.promptPort?.close();
    this.promptPort = undefined;
    this.releaseTheme?.();
    this.releaseTheme = undefined;
    this.contentHeight = undefined;
  }

  private sameOwner(binding: ViewBinding | undefined): binding is ViewBinding {
    const gateway = this.context?.gateway;
    const snapshot = gateway?.snapshot;
    return Boolean(
      binding &&
      gateway &&
      snapshot &&
      binding.client === snapshot.client &&
      binding.docId === this.docId &&
      binding.sessionKey === this.sessionKey &&
      binding.connectionRevision === gateway.connectionRevision &&
      binding.gatewayUrl === gateway.connection.gatewayUrl &&
      !snapshot.lastErrorAuthReason &&
      snapshot.phase !== "stopped" &&
      (snapshot.phase !== "connected" ||
        ((!binding.profileId ||
          !snapshot.selfUser?.id ||
          binding.profileId === snapshot.selfUser.id) &&
          binding.recoveryScope === snapshot.hello?.auth?.recoveryScope &&
          hasOperatorReadAccess(snapshot.hello?.auth ?? null))),
    );
  }

  private isCurrent(binding: ViewBinding | undefined): binding is ViewBinding {
    return (
      this.sameOwner(binding) &&
      this.isConnected &&
      this.binding === binding &&
      isGatewayAvailable(this.context!.gateway.snapshot) &&
      binding.generation === getCanvasWidgetFrameConnectionGeneration()
    );
  }

  override willUpdate(): void {
    const gateway = this.context?.gateway;
    const client = gateway?.snapshot.client;
    if (
      (this.binding && !this.sameOwner(this.binding)) ||
      (this.viewOwner && !this.sameOwner(this.viewOwner))
    ) {
      this.clearView();
    }
    if (!gateway || !client || !this.docId) {
      this.clearView();
      return;
    }
    // Content can outlive its socket, but prompts require a successful read in
    // the current generation. Keep the private port inert rather than remounting.
    if (!isGatewayAvailable(gateway.snapshot)) {
      this.binding = undefined;
      this.clearRetry();
      this.validated = undefined;
      this.sandboxHost?.setActive(false);
      this.pending = true;
      return;
    }
    if (!hasOperatorReadAccess(gateway.snapshot.hello?.auth ?? null)) {
      this.error = t("board.widget.sandboxUnavailable");
      return;
    }
    const profileId = gateway.snapshot.selfUser?.id;
    if (profileId) {
      if (this.binding && !this.binding.profileId) {
        this.binding.profileId = profileId;
      }
      if (this.viewOwner && !this.viewOwner.profileId) {
        this.viewOwner.profileId = profileId;
      }
    }
    const generation = getCanvasWidgetFrameConnectionGeneration();
    if (this.binding?.generation === generation) {
      return;
    }
    this.clearRetry();
    this.validated = undefined;
    this.error = "";
    const binding: ViewBinding = {
      client,
      docId: this.docId,
      sessionKey: this.sessionKey,
      generation,
      connectionRevision: gateway.connectionRevision,
      gatewayUrl: gateway.connection.gatewayUrl,
      // Hello can omit presence until users.self settles; recoveryScope already
      // binds verified principals. Preserve known attribution until it resolves.
      profileId: gateway.snapshot.selfUser?.id ?? this.viewOwner?.profileId ?? null,
      recoveryScope: gateway.snapshot.hello?.auth?.recoveryScope,
    };
    this.binding = binding;
    this.pending = Boolean(this.view);
    this.slowTimer = window.setTimeout(() => {
      if (this.isCurrent(binding)) {
        this.pending = true;
      }
    }, WIDGET_LOAD_NOTICE_MS);
    void loadCanvasView(binding)
      .then((view) => {
        if (!this.isCurrent(binding)) {
          return;
        }
        this.clearRetry();
        const previous = this.view;
        if (
          previous &&
          (previous.html !== view.html ||
            previous.sandboxUrl !== view.sandboxUrl ||
            previous.sandboxPort !== view.sandboxPort ||
            previous.sandboxOrigin !== view.sandboxOrigin)
        ) {
          this.clearSandbox();
          this.runtimeError = "";
          this.resourceError = false;
          this.sandboxGeneration += 1;
        }
        this.view = view;
        this.viewOwner = binding;
        this.validated = binding;
        this.pending = false;
        this.retryDelayMs = 1_000;
        this.sandboxHost?.setActive(true);
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(binding)) {
          return;
        }
        this.clearRetry();
        if (
          isAwaitingGatewayFailure(error, gateway.snapshot) ||
          error instanceof GatewayProtocolRequestTimeoutError ||
          (error instanceof GatewayProtocolRequestError &&
            error.gatewayCode === "UNAVAILABLE" &&
            error.retryable)
        ) {
          this.scheduleRetry(
            binding,
            error instanceof GatewayProtocolRequestError ? error.retryAfterMs : undefined,
          );
          return;
        }
        // A definitive denial or missing document retires cached content and its ports.
        this.view = undefined;
        this.clearSandbox();
        this.pending = false;
        this.error = formatUiError(error);
      });
  }

  override updated(): void {
    const frame = this.querySelector<HTMLIFrameElement>("iframe");
    const view = this.view;
    const binding = this.binding;
    if (!this.allowScripts || !frame || !view || !this.isCurrent(binding) || this.sandboxHost) {
      return;
    }
    this.releaseTheme = registerWidgetThemeFrame(frame, this.sandboxOrigin);
    this.sandboxHost = new WidgetSandboxHost({
      frame,
      sandboxOrigin: this.sandboxOrigin,
      sandboxUrl: frame.src,
      documentKey: `${binding.docId}\0${binding.generation}`,
      loadDocument: async () => view.html,
      onLoaded: () => {
        this.pending = false;
        this.postHostState();
      },
      onError: (error) => this.fail(error),
      onReadyTimeout: () => {
        this.pending = true;
      },
      onPending: () => {
        this.pending = true;
      },
    });
  }

  private fail(error: unknown): void {
    this.clearSandbox();
    this.error = formatUiError(error);
  }

  private postHostState(): void {
    const frame = this.sandboxHost?.frame;
    if (!frame) {
      return;
    }
    postWidgetTheme(frame, this.sandboxOrigin);
    frame.contentWindow?.postMessage({ type: "openclaw:widget-chat-host" }, this.sandboxOrigin);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const host = this.sandboxHost;
    const binding = this.viewOwner;
    if (
      !host ||
      !this.sameOwner(binding) ||
      event.source !== host.frame.contentWindow ||
      event.origin !== this.sandboxOrigin
    ) {
      return;
    }
    host.handleMessage(event);
    const data = asOptionalRecord(event.data);
    if (data?.type === "openclaw:widget-runtime-error") {
      if (!this.sessionKey || typeof data.message !== "string") {
        return;
      }
      // Download/rejection failures are not evidence that agent-authored code is
      // broken. Keep a local recovery action, never wake the agent to rewrite it.
      if (
        !this.isCurrent(this.validated) ||
        !navigator.onLine ||
        /failed to fetch|load failed|networkerror|network request failed|importing a module script failed|failed to load module script/i.test(
          data.message,
        )
      ) {
        this.resourceError = true;
        return;
      }
      const report = {
        message: data.message.slice(0, 500),
        line: typeof data.line === "number" && Number.isInteger(data.line) ? data.line : undefined,
        column:
          typeof data.column === "number" && Number.isInteger(data.column)
            ? data.column
            : undefined,
      };
      this.runtimeError ||= report.message;
      const messageTimestamp = this.messageTimestamp;
      if (
        typeof messageTimestamp !== "number" ||
        !Number.isFinite(messageTimestamp) ||
        Date.now() - messageTimestamp > WIDGET_RUNTIME_ERROR_REPORT_WINDOW_MS
      ) {
        return;
      }
      const key = `error\0${this.sessionKey}\0${binding.docId}`;
      // Shared prompt limiter: 10 per key per 60 seconds, at most 100 keys.
      if (reportedRuntimeErrors.has(key) || !allowWidgetPrompt(key, Date.now())) {
        return;
      }
      reportedRuntimeErrors.add(key);
      const location =
        report.line === undefined
          ? ""
          : `, line ${report.line}${report.column === undefined ? "" : `, column ${report.column}`}`;
      const text = `Inline widget "${this.title.slice(0, 80)}" (${binding.docId}) threw a script error after rendering: ${report.message}${location}. Fix the script and show the widget again; if show_widget is unavailable in this turn, reply with the corrected widget code and show it on the next turn.`;
      void binding.client
        .request("wake", { mode: "now", sessionKey: this.sessionKey, text })
        .catch((error: unknown) => console.warn("Widget runtime error wake failed", error));
      return;
    }
    if (
      data?.type === "openclaw:widget-size" &&
      typeof data.height === "number" &&
      Number.isFinite(data.height) &&
      data.height > 0
    ) {
      this.contentHeight = Math.min(8000, Math.max(48, Math.trunc(data.height)));
    }
    if (data?.type === "openclaw:widget-bridge-ready") {
      this.postHostState();
    }
    if (data?.type !== "openclaw:widget-prompt-offer") {
      if (data?.type === "openclaw:widget-bridge-port-offer") {
        event.ports[0]?.close();
      }
      return;
    }
    const port = event.ports[0];
    if (!port || this.promptPort || !host.loaded) {
      port?.close();
      return;
    }
    // The isolated proxy forwards only the wrapper's first offer. Inline views
    // adopt its prompt channel only; pinning never lends them dashboard grants.
    this.promptPort = port;
    port.addEventListener("message", (message: MessageEvent) => {
      if (
        this.isCurrent(this.validated) &&
        this.sandboxHost === host &&
        this.promptPort === port &&
        message.data?.type === "openclaw:widget-prompt"
      ) {
        dispatchWidgetPrompt(
          host.frame,
          message.data.prompt,
          `${this.sessionKey}\0${this.docId}\0${this.validated!.generation}`,
        );
      }
    });
    port.start();
    port.postMessage({ type: "openclaw:widget-prompt-host-ready" });
  };

  override render() {
    if (this.error) {
      return html`<div class="board-widget__error" role="alert">
        ${this.error}
        <button
          class="btn btn--small"
          @click=${() => {
            this.clearView();
            this.requestUpdate();
          }}
        >
          ${t("common.retry")}
        </button>
      </div>`;
    }
    if (!this.view || !this.context) {
      if (this.pending) {
        return html`<div
          class="board-widget__notice"
          role="status"
          style=${`min-height:${this.preferredHeight ?? 420}px`}
        >
          ${t("board.widget.waitingForConnection")}
        </div>`;
      }
      return html`<div
        class="skeleton"
        role="status"
        aria-label=${t("common.loading")}
        style=${`min-height:${this.preferredHeight ?? 420}px`}
      ></div>`;
    }
    let src: string | undefined;
    try {
      if (this.allowScripts) {
        src = resolveSandboxHostUrl(
          this.view.sandboxUrl,
          this.view.sandboxPort,
          this.view.sandboxOrigin,
          this.context.gateway.connection.gatewayUrl,
          window.location.origin,
        );
        this.sandboxOrigin = new URL(src).origin;
      }
    } catch (error) {
      return html`<div role="alert">${formatUiError(error)}</div>`;
    }
    const height = this.contentHeight ?? this.preferredHeight;
    return keyed(
      this.sandboxGeneration,
      html`${this.pending ? html`<div class="board-widget__notice" role="status">${t("board.widget.waitingForConnection")}</div>` : nothing}${
          this.resourceError
            ? html`<div class="board-widget__notice" role="status">
                ${t("board.widget.resourceUnavailable")}
                <button
                  class="btn btn--small"
                  @click=${() => {
                    this.clearView();
                    this.requestUpdate();
                  }}
                >
                  ${t("common.retry")}
                </button>
              </div>`
            : nothing
        }${this.runtimeError ? html`<div class="board-widget__notice" role="status">${t("board.widget.runtimeError", { message: this.runtimeError })}</div>` : nothing}<iframe
          class="chat-tool-card__preview-frame"
          title=${this.title}
          src=${src ?? nothing}
          srcdoc=${this.allowScripts ? nothing : this.view.html}
          sandbox=${this.allowScripts ? "allow-scripts allow-same-origin allow-forms" : ""}
          referrerpolicy="origin"
          style=${height ? `height:${height}px;min-height:${height}px` : nothing}
          @error=${() => this.sandboxHost?.handleFrameError()}
        ></iframe>`,
    );
  }
}

if (!customElements.get("openclaw-canvas-widget-view")) {
  customElements.define("openclaw-canvas-widget-view", OpenClawCanvasWidgetView);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-canvas-widget-view": OpenClawCanvasWidgetView;
  }
}
