import { consume } from "@lit/context";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { resolveSandboxHostUrl } from "../../../components/sandbox-host.ts";
import { t } from "../../../i18n/index.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { WidgetSandboxHost, WIDGET_LOAD_TIMEOUT_MS } from "../../../lib/widget-sandbox-host.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../../lit/subscriptions-controller.ts";

type PreviewBinding = {
  context: ApplicationContext;
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  generation: number;
  html: string;
  sourceIdentity: string;
};

/** Only transfers document bytes. Ordinary files never receive widget host APIs. */
export class ChatHtmlPreview extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  private context?: ApplicationContext;

  @property({ attribute: false }) html = "";
  @property() sourceIdentity = "";
  @property() override title = "";
  @state() private view?: CanvasDocumentViewResult;
  @state() private error = "";
  @state() private rendered = false;
  private binding?: PreviewBinding;
  private sandboxHost?: WidgetSandboxHost;
  private sandboxUrl = "";
  private sandboxOrigin = "";
  private frameGeneration = 0;
  private mode: EmbedSandboxMode = "scripts";

  @property()
  get embedSandboxMode(): EmbedSandboxMode {
    return this.mode;
  }

  set embedSandboxMode(value: EmbedSandboxMode) {
    if (value !== this.mode) {
      // Revoke the old transport synchronously, before replacing its frame.
      this.clearSandbox();
      this.frameGeneration += 1;
      this.mode = value;
      if (this.view) {
        this.error = "";
      }
    }
  }

  constructor() {
    super();
    void new SubscriptionsController(this).watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      () => {
        if (this.binding && !this.isCurrent(this.binding)) {
          this.clearView();
        }
      },
    );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.handleMessage);
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    window.removeEventListener("message", this.handleMessage);
    this.clearView();
    super.disconnectedCallback();
  }

  private clearSandbox(): void {
    this.sandboxHost?.dispose();
    this.sandboxHost = undefined;
    this.rendered = false;
  }

  private clearView(): void {
    this.clearSandbox();
    this.binding = undefined;
    this.view = undefined;
    this.frameGeneration += 1;
  }

  private isCurrent(binding: PreviewBinding | undefined): binding is PreviewBinding {
    return Boolean(
      binding &&
      this.isConnected &&
      this.binding === binding &&
      this.context === binding.context &&
      this.context.gateway.snapshot.phase === "connected" &&
      this.context.gateway.snapshot.client === binding.client &&
      binding.generation === getCanvasWidgetFrameConnectionGeneration() &&
      binding.html === this.html &&
      binding.sourceIdentity === this.sourceIdentity,
    );
  }

  override willUpdate(): void {
    if (this.isCurrent(this.binding)) {
      return;
    }
    this.clearView();
    const context = this.context;
    const client = context?.gateway.snapshot.client;
    if (!context || !client || context.gateway.snapshot.phase !== "connected") {
      this.error = t("chat.attachments.previewUnavailable");
      return;
    }
    const binding: PreviewBinding = {
      context,
      client,
      html: this.html,
      sourceIdentity: this.sourceIdentity,
      generation: getCanvasWidgetFrameConnectionGeneration(),
    };
    this.binding = binding;
    this.error = "";
    void client
      .request<CanvasDocumentViewResult>(
        "canvas.document.preview",
        { html: binding.html },
        { timeoutMs: WIDGET_LOAD_TIMEOUT_MS },
      )
      .then((view) => {
        if (!this.isCurrent(binding)) {
          return;
        }
        this.sandboxUrl = resolveSandboxHostUrl(
          view.sandboxUrl,
          view.sandboxPort,
          view.sandboxOrigin,
          context.gateway.connection.gatewayUrl,
          window.location.origin,
        );
        this.sandboxOrigin = new URL(this.sandboxUrl).origin;
        this.view = view;
      })
      .catch((error: unknown) => {
        if (this.isCurrent(binding)) {
          this.fail(error);
        }
      });
  }

  override updated(): void {
    const binding = this.binding;
    const frame = this.querySelector<HTMLIFrameElement>("iframe");
    const view = this.view;
    if (!frame || !view || !this.isCurrent(binding) || this.sandboxHost || this.error) {
      return;
    }
    const generation = this.frameGeneration;
    const currentFrame = () =>
      this.isCurrent(binding) &&
      this.frameGeneration === generation &&
      this.sandboxHost?.frame === frame;
    const fail = (error: unknown) => {
      if (currentFrame()) {
        this.fail(error);
      }
    };
    this.sandboxHost = new WidgetSandboxHost({
      frame,
      sandboxUrl: this.sandboxUrl,
      sandboxOrigin: this.sandboxOrigin,
      documentKey: String(this.frameGeneration),
      allowScripts: this.mode !== "strict",
      loadDocument: async () => view.html,
      onLoaded: () => {},
      onRendered: () => {
        if (currentFrame()) {
          this.rendered = true;
        }
      },
      onError: fail,
      // Disposing here stops the shared host's retry cycle. Only Retry may
      // create another transport after an unavailable proxy or render timeout.
      onReadyTimeout: () => fail(new Error(t("board.widget.sandboxUnavailable"))),
    });
  }

  private fail(error: unknown): void {
    this.clearSandbox();
    this.error = formatUiError(error);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const host = this.sandboxHost;
    if (!host || event.source !== host.frame.contentWindow) {
      return;
    }
    // Close this frame's unsupported ports without interfering with sibling widgets.
    for (const port of event.ports) {
      port.close();
    }
    if (!this.isCurrent(this.binding) || event.origin !== this.sandboxOrigin) {
      return;
    }
    host.handleMessage(event);
  };

  override render() {
    if (this.error) {
      return html`<div class="chat-html-preview__error" role="alert">
        ${this.error}
        <button
          class="btn btn--sm"
          type="button"
          @click=${() => {
            this.clearView();
            this.requestUpdate();
          }}
        >
          ${t("common.retry")}
        </button>
      </div>`;
    }
    if (!this.view) {
      return html`<div role="status">${t("common.loading")}</div>`;
    }
    const binding = this.binding;
    const generation = this.frameGeneration;
    return html`
      ${!this.rendered ? html`<div role="status">${t("common.loading")}</div>` : nothing}
      ${keyed(
        this.frameGeneration,
        html`<iframe
          class="chat-html-preview__frame"
          title=${this.title}
          src=${this.sandboxUrl}
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="origin"
          @error=${(event: Event) => {
            if (
              this.isCurrent(binding) &&
              this.frameGeneration === generation &&
              event.currentTarget === this.querySelector("iframe")
            ) {
              this.fail(new Error(t("board.widget.sandboxUnavailable")));
            }
          }}
        ></iframe>`,
      )}
    `;
  }
}

if (!customElements.get("openclaw-chat-html-preview")) {
  customElements.define("openclaw-chat-html-preview", ChatHtmlPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-html-preview": ChatHtmlPreview;
  }
}
