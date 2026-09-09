import { consume } from "@lit/context";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../lib/chat/canvas-widget-frame-generation.ts";
import { formatUiError } from "../lib/format-error.ts";
import { WidgetSandboxHost, WIDGET_LOAD_TIMEOUT_MS } from "../lib/widget-sandbox-host.ts";
import { registerWidgetThemeFrame, postWidgetTheme } from "../lib/widget-theme.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { allowWidgetPrompt, dispatchWidgetPrompt } from "./mcp-app-security.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

type WidgetClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type ViewBinding = { client: WidgetClient; generation: number; docId: string; sessionKey: string };
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
  @state() private contentHeight?: number;
  private binding?: ViewBinding;
  private sandboxHost?: WidgetSandboxHost;
  private promptPort?: MessagePort;
  private sandboxOrigin = "";
  private releaseTheme?: () => void;
  private scriptsAllowed = true;
  private sandboxGeneration = 0;

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
    return this.isCurrent(this.binding) ? this.view?.html : undefined;
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
    this.runtimeError = "";
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

  private isCurrent(binding: ViewBinding | undefined): binding is ViewBinding {
    return Boolean(
      binding &&
      this.isConnected &&
      this.binding === binding &&
      binding.client === this.context?.gateway.snapshot.client &&
      binding.docId === this.docId &&
      binding.sessionKey === this.sessionKey &&
      binding.generation === getCanvasWidgetFrameConnectionGeneration(),
    );
  }

  override willUpdate(): void {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.docId) {
      this.clearView();
      return;
    }
    if (
      this.binding?.client === client &&
      this.binding.docId === this.docId &&
      this.binding.sessionKey === this.sessionKey &&
      this.binding.generation === this.connectionGeneration
    ) {
      return;
    }
    this.clearView();
    this.error = "";
    const binding = {
      client,
      docId: this.docId,
      sessionKey: this.sessionKey,
      generation: this.connectionGeneration,
    };
    this.binding = binding;
    void loadCanvasView(binding)
      .then((view) => {
        if (this.isCurrent(binding)) {
          this.view = view;
        }
      })
      .catch((error: unknown) => {
        if (this.isCurrent(binding)) {
          this.error = formatUiError(error);
        }
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
      onLoaded: () => this.postHostState(),
      onError: (error) => this.fail(error),
      onReadyTimeout: () => this.fail(new Error(t("board.widget.sandboxUnavailable"))),
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
    const binding = this.binding;
    if (
      !host ||
      !this.isCurrent(binding) ||
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
      const report = {
        message: data.message.slice(0, 500),
        source:
          typeof data.source === "string"
            ? data.source
                .replace(/[?#].*$/, "")
                .replace(/^.*[\\/]/, "")
                .slice(0, 200)
            : undefined,
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
        this.isCurrent(binding) &&
        this.promptPort === port &&
        message.data?.type === "openclaw:widget-prompt"
      ) {
        dispatchWidgetPrompt(
          host.frame,
          message.data.prompt,
          `${this.sessionKey}\0${binding.docId}\0${binding.generation}`,
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
      return html`<div role="status" style=${`min-height:${this.preferredHeight ?? 420}px`}>
        ${t("common.loading")}
      </div>`;
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
      html`${this.runtimeError ? html`<div class="board-widget__notice" role="status">${t("board.widget.runtimeError", { message: this.runtimeError })}</div>` : nothing}<iframe
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
