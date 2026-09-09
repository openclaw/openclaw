import type {
  HumanInterventionControlRequest,
  HumanInterventionInput,
  HumanInterventionResponse as HandoffResponse,
  HumanInterventionView,
} from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerHumanInterventionEnglish } from "../../i18n/locales/en-human-intervention.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { OpenClawLitElement } from "../../lit/openclaw-element.ts";
import {
  BrowserScreencastClient,
  type BrowserScreencastFrame,
} from "./browser-screencast-client.ts";
import { humanInterventionStyles } from "./human-intervention-panel.styles.ts";

registerHumanInterventionEnglish();

type ScreencastResponse = { wsPath: string };

type ViewerConnection = { client: GatewayBrowserClient; id: string };
type ControlSession = {
  connection: ViewerConnection;
  controllerId: string;
  generation: number;
  stream?: BrowserScreencastClient;
  renewTimer?: ReturnType<typeof setInterval>;
  renewing: boolean;
  inputOperation?: Promise<boolean>;
};

export function resolveHumanBrowserPoint(
  point: { clientX: number; clientY: number },
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  remote: { width: number; height: number },
): { x: number; y: number } {
  const displayedWidth = Math.max(1, bounds.width);
  const displayedHeight = Math.max(1, bounds.height);
  return {
    x: Math.max(
      0,
      Math.min(remote.width, ((point.clientX - bounds.left) / displayedWidth) * remote.width),
    ),
    y: Math.max(
      0,
      Math.min(remote.height, ((point.clientY - bounds.top) / displayedHeight) * remote.height),
    ),
  };
}

export class OpenClawHumanInterventionPanel extends OpenClawLitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) available = false;
  @property() handoffId = "";
  @property({ attribute: false }) onDocumentClose?: () => void;

  @state() private handoff: HumanInterventionView | null = null;
  @state() private loading = true;
  @state() private busy = false;
  @state() private control: ControlSession | null = null;
  @state() private error = "";
  @state() private streamStatus: "idle" | "connecting" | "connected" = "idle";
  @state() private frameUrl = "";
  @state() private frameWidth = 0;
  @state() private frameHeight = 0;
  @state() private zoom = 1;
  @state() private textDraft = "";

  private connection: ViewerConnection | null = null;
  private pointerStart?: { x: number; y: number; pointerId: number };
  private framePageUrl = "";
  private get inputBusy(): boolean {
    return Boolean(this.control?.inputOperation);
  }
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "hidden" && this.isController()) {
      void this.leave(false);
    }
  };

  static override styles = humanInterventionStyles;

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    void this.load();
  }

  override disconnectedCallback(): void {
    this.resetConnection();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("client") || changed.has("available") || changed.has("handoffId")) {
      void this.load();
    }
  }

  private isCurrent(connection: ViewerConnection): boolean {
    return (
      this.isConnected &&
      this.available &&
      this.connection === connection &&
      this.client === connection.client &&
      this.handoffId === connection.id
    );
  }

  private ownsControl(session: ControlSession): boolean {
    return this.control === session && this.isCurrent(session.connection);
  }

  private resetConnection(): void {
    const session = this.control;
    this.connection = null;
    if (session) {
      this.stopControl(session);
      void this.releaseSession(session).catch(() => {});
    }
    this.busy = false;
    this.textDraft = "";
    this.handoff = null;
  }

  private async load(): Promise<void> {
    if (!this.isConnected) {
      return;
    }
    if (this.connection && this.isCurrent(this.connection)) {
      return;
    }
    this.resetConnection();
    const client = this.client;
    if (!client || !this.available || !this.handoffId) {
      return;
    }
    const connection = { client, id: this.handoffId };
    this.connection = connection;
    this.loading = true;
    this.error = "";
    try {
      const response = await client.request<HandoffResponse>("browser.handoff.get", {
        id: connection.id,
      });
      if (this.isCurrent(connection)) {
        this.handoff = response.handoff;
      }
    } catch (error) {
      if (this.isCurrent(connection)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(connection)) {
        this.loading = false;
      }
    }
  }

  private retry(): void {
    this.resetConnection();
    void this.load();
  }

  private isController(): boolean {
    return this.control !== null && this.ownsControl(this.control);
  }

  private controlParams(session: ControlSession): HumanInterventionControlRequest {
    return {
      id: session.connection.id,
      controllerId: session.controllerId,
      generation: session.generation,
    };
  }

  private async claim(): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.isCurrent(connection) || !this.handoff || this.busy) {
      return;
    }
    this.busy = true;
    this.error = "";
    // A delayed release from a retired claim must never own a later claim.
    const controllerId = generateUUID();
    let session: ControlSession | undefined;
    try {
      const response = await connection.client.request<HandoffResponse>("browser.handoff.claim", {
        id: connection.id,
        controllerId,
      });
      session = {
        connection,
        controllerId,
        generation: response.handoff.generation,
        renewing: false,
      };
      if (!this.isCurrent(connection)) {
        await this.releaseSession(session);
        return;
      }
      this.handoff = response.handoff;
      this.control = session;
      await this.startStream(session);
      if (this.ownsControl(session)) {
        const activeSession = session;
        session.renewTimer = setInterval(() => void this.renew(activeSession), 30_000);
      }
    } catch (error) {
      if (this.isCurrent(connection)) {
        this.error = formatUiError(error);
      }
      if (session && this.ownsControl(session)) {
        this.stopControl(session);
        await this.releaseSession(session).catch(() => {});
      }
    } finally {
      if (this.isCurrent(connection)) {
        this.busy = false;
      }
    }
  }

  private async startStream(session: ControlSession): Promise<void> {
    this.streamStatus = "connecting";
    const response = await session.connection.client.request<ScreencastResponse>(
      "browser.handoff.browser",
      {
        ...this.controlParams(session),
        operation: "screencast",
        maxWidth: 2000,
        maxHeight: 2000,
      },
    );
    if (!this.ownsControl(session)) {
      return;
    }
    session.stream = new BrowserScreencastClient({
      gatewayUrl: session.connection.client.gatewayUrl,
      wsPath: response.wsPath,
      onReady: () => {
        if (this.ownsControl(session)) {
          this.streamStatus = "connected";
        }
      },
      onMeta: ({ url }) => {
        if (this.ownsControl(session) && this.framePageUrl && url !== this.framePageUrl) {
          this.clearFrame();
        }
      },
      onFrame: (frame) => {
        if (this.ownsControl(session)) {
          this.presentFrame(frame);
        }
      },
      onClose: () => {
        if (this.ownsControl(session)) {
          void this.leave(false);
        }
      },
    });
  }

  private presentFrame(frame: BrowserScreencastFrame): void {
    const previous = this.frameUrl;
    this.frameUrl = URL.createObjectURL(frame.blob);
    this.frameWidth = frame.cssWidth;
    this.frameHeight = frame.cssHeight;
    this.framePageUrl = frame.url;
    this.streamStatus = "connected";
    if (previous) {
      URL.revokeObjectURL(previous);
    }
  }

  private async renew(session: ControlSession): Promise<void> {
    if (!this.ownsControl(session) || session.renewing) {
      return;
    }
    session.renewing = true;
    try {
      const response = await session.connection.client.request<HandoffResponse>(
        "browser.handoff.renew",
        this.controlParams(session),
      );
      if (this.ownsControl(session)) {
        this.handoff = response.handoff;
      }
    } catch (error) {
      if (this.ownsControl(session)) {
        this.error = formatUiError(error);
        this.stopControl(session);
        void this.releaseSession(session).catch(() => {});
      }
    } finally {
      session.renewing = false;
    }
  }

  // Retire local input and callbacks synchronously; remote release may await input.
  private stopControl(session: ControlSession): void {
    clearInterval(session.renewTimer);
    session.renewTimer = undefined;
    session.stream?.close();
    session.stream = undefined;
    if (this.control !== session) {
      return;
    }
    this.control = null;
    this.streamStatus = "idle";
    this.clearFrame();
  }

  private clearFrame(): void {
    if (this.frameUrl) {
      URL.revokeObjectURL(this.frameUrl);
    }
    this.frameUrl = "";
    this.frameWidth = 0;
    this.frameHeight = 0;
    this.framePageUrl = "";
    this.pointerStart = undefined;
  }

  private async act(action: HumanInterventionInput): Promise<boolean> {
    const session = this.control;
    if (
      !session ||
      !this.ownsControl(session) ||
      this.busy ||
      session.inputOperation ||
      this.streamStatus !== "connected" ||
      !this.frameUrl
    ) {
      return false;
    }
    this.error = "";
    const operation = this.sendBrowserAction(session, action);
    session.inputOperation = operation;
    this.requestUpdate();
    try {
      return await operation;
    } finally {
      session.inputOperation = undefined;
      if (this.ownsControl(session)) {
        this.requestUpdate();
      }
    }
  }

  private async sendBrowserAction(
    session: ControlSession,
    action: HumanInterventionInput,
  ): Promise<boolean> {
    try {
      await session.connection.client.request("browser.handoff.browser", {
        ...this.controlParams(session),
        operation: "act",
        action,
      });
      return this.ownsControl(session);
    } catch (error) {
      if (this.ownsControl(session)) {
        this.error = formatUiError(error);
      }
      return false;
    }
  }

  private async sendText(): Promise<void> {
    const text = this.textDraft;
    if (text && (await this.act({ kind: "type", text })) && this.textDraft === text) {
      this.textDraft = "";
    }
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.isController() || this.inputBusy || this.busy) {
      return;
    }
    this.pointerStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  }

  private pointerUp(event: PointerEvent): void {
    if (!(event.currentTarget instanceof HTMLImageElement)) {
      return;
    }
    const image = event.currentTarget;
    const start = this.pointerStart;
    this.pointerStart = undefined;
    if (!start || start.pointerId !== event.pointerId || !this.frameWidth || !this.frameHeight) {
      return;
    }
    const bounds = image.getBoundingClientRect();
    const from = resolveHumanBrowserPoint({ clientX: start.x, clientY: start.y }, bounds, {
      width: this.frameWidth,
      height: this.frameHeight,
    });
    const to = resolveHumanBrowserPoint(event, bounds, {
      width: this.frameWidth,
      height: this.frameHeight,
    });
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    void this.act(
      moved > 12
        ? { kind: "dragCoords", ...from, endX: to.x, endY: to.y }
        : { kind: "clickCoords", ...to },
    );
  }

  private async releaseSession(session: ControlSession): Promise<HandoffResponse> {
    await session.inputOperation;
    return await session.connection.client.request<HandoffResponse>(
      "browser.handoff.leave",
      this.controlParams(session),
    );
  }

  private async leave(showError = true): Promise<void> {
    const session = this.control;
    if (!session || !this.ownsControl(session)) {
      return;
    }
    this.busy = true;
    this.stopControl(session);
    try {
      const response = await this.releaseSession(session);
      if (this.isCurrent(session.connection)) {
        this.handoff = response.handoff;
      }
    } catch (error) {
      if (showError && this.isCurrent(session.connection)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(session.connection)) {
        this.busy = false;
      }
    }
  }

  private async finish(
    method: "browser.handoff.complete" | "browser.handoff.cancel",
  ): Promise<void> {
    const connection = this.connection;
    const session = this.control;
    if (!connection || !this.isCurrent(connection) || !this.handoff || this.busy) {
      return;
    }
    if (method === "browser.handoff.complete" && !session) {
      return;
    }
    this.busy = true;
    this.error = "";
    try {
      await session?.inputOperation;
      if (!this.isCurrent(connection)) {
        return;
      }
      if (session && !this.ownsControl(session)) {
        return;
      }
      const params =
        method === "browser.handoff.complete" && session
          ? this.controlParams(session)
          : { id: connection.id };
      const response = await connection.client.request<HandoffResponse>(method, params);
      if (!this.isCurrent(connection)) {
        return;
      }
      this.handoff = response.handoff;
      if (session) {
        this.stopControl(session);
      }
    } catch (error) {
      if (this.isCurrent(connection)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(connection)) {
        this.busy = false;
      }
    }
  }

  private statusText(): string {
    if (this.handoff?.state === "resume_pending") {
      return t("humanBrowser.resumePending");
    }
    if (this.handoff?.state === "resumed") {
      return t("humanBrowser.continuationQueued");
    }
    if (this.handoff?.state === "cancelled") {
      return t("humanBrowser.cancelled");
    }
    if (this.handoff?.state === "expired") {
      return t("humanBrowser.expired");
    }
    if (this.handoff?.state === "control") {
      return this.isController() ? t("humanBrowser.control") : t("humanBrowser.controlElsewhere");
    }
    return t("humanBrowser.waiting");
  }

  override render() {
    if (!this.available) {
      return html`<main class="page"><p>${t("humanBrowser.unavailable")}</p></main>`;
    }
    if (this.loading) {
      return html`<main class="page"><p>${t("humanBrowser.loading")}</p></main>`;
    }
    if (!this.handoff) {
      return html`
        <main class="page">
          ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
          <div class="actions">
            <button class="primary" data-retry @click=${() => this.retry()}>
              ${t("humanBrowser.retry")}
            </button>
          </div>
        </main>
      `;
    }
    const terminal = ["resume_pending", "resumed", "cancelled", "expired"].includes(
      this.handoff.state,
    );
    const controlling = this.isController();
    const browserReady =
      controlling &&
      this.streamStatus === "connected" &&
      Boolean(this.frameUrl) &&
      !this.inputBusy &&
      !this.busy;
    return html`
      <main class="page">
        <header>
          <h1>${t("humanBrowser.title")}</h1>
          ${this.handoff.hostname ? html`<div class="host">${this.handoff.hostname}</div>` : nothing}
          ${this.handoff.reason ? html`<p class="reason">${this.handoff.reason}</p>` : nothing}
          <p class="status" role="status">${this.statusText()}</p>
          ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
        </header>

        ${
          controlling
            ? html`
                <div class="toolbar">
                  <button
                    ?disabled=${!browserReady}
                    @click=${() => void this.act({ kind: "press", key: "PageUp" })}
                  >
                    ${t("humanBrowser.scrollUp")}
                  </button>
                  <button
                    ?disabled=${!browserReady}
                    @click=${() => void this.act({ kind: "press", key: "PageDown" })}
                  >
                    ${t("humanBrowser.scrollDown")}
                  </button>
                  <button
                    aria-label=${t("humanBrowser.zoomOut")}
                    @click=${() => {
                      this.zoom = Math.max(1, this.zoom - 0.25);
                    }}
                  >
                    −
                  </button>
                  <button
                    aria-label=${t("humanBrowser.zoomIn")}
                    @click=${() => {
                      this.zoom = Math.min(3, this.zoom + 0.25);
                    }}
                  >
                    +
                  </button>
                </div>
                <div
                  class="viewer"
                  @wheel=${(event: WheelEvent) => {
                    event.preventDefault();
                    void this.act({
                      kind: "press",
                      key: event.deltaY >= 0 ? "PageDown" : "PageUp",
                    });
                  }}
                >
                  ${
                    this.frameUrl
                      ? html`<img
                          class="frame"
                          style=${`--human-browser-zoom: ${this.zoom}`}
                          src=${this.frameUrl}
                          alt=${this.handoff?.hostname ?? "Remote browser tab"}
                          draggable="false"
                          @pointerdown=${(event: PointerEvent) => this.pointerDown(event)}
                          @pointerup=${(event: PointerEvent) => this.pointerUp(event)}
                          @pointercancel=${() => {
                            this.pointerStart = undefined;
                          }}
                        />`
                      : html`<div class="viewer-empty">${t("humanBrowser.browserLoading")}</div>`
                  }
                </div>
                <div class="text-entry">
                  <input
                    .value=${this.textDraft}
                    ?disabled=${!browserReady}
                    placeholder=${t("humanBrowser.typePlaceholder")}
                    @input=${(event: InputEvent) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        this.textDraft = event.currentTarget.value;
                      }
                    }}
                    @keydown=${(event: KeyboardEvent) => {
                      if (event.key === "Enter" && this.textDraft) {
                        event.preventDefault();
                        void this.sendText();
                      }
                    }}
                  />
                  <button
                    ?disabled=${!browserReady || !this.textDraft}
                    @click=${() => void this.sendText()}
                  >
                    ${t("humanBrowser.sendText")}
                  </button>
                  <button
                    ?disabled=${!browserReady}
                    @click=${() => void this.act({ kind: "press", key: "Enter" })}
                  >
                    ${t("humanBrowser.pressEnter")}
                  </button>
                </div>
              `
            : nothing
        }
        ${
          !terminal
            ? html`<div class="actions">
                ${this.handoff?.state === "waiting" || (this.handoff?.state === "control" && !controlling) ? html`<button class="primary" data-take-control ?disabled=${this.busy} @click=${() => void this.claim()}>${t("humanBrowser.takeControl")}</button>` : nothing}
                ${
                  controlling
                    ? html`
                        <button
                          class="primary"
                          data-complete
                          ?disabled=${this.busy || this.inputBusy}
                          @click=${() => void this.finish("browser.handoff.complete")}
                        >
                          ${t("humanBrowser.done")}
                        </button>
                        <button
                          data-leave
                          ?disabled=${this.busy || this.inputBusy}
                          @click=${() => void this.leave()}
                        >
                          ${t("humanBrowser.leave")}
                        </button>
                      `
                    : nothing
                }
                <button
                  class="danger"
                  ?disabled=${this.busy || this.inputBusy}
                  @click=${() => void this.finish("browser.handoff.cancel")}
                >
                  ${t("humanBrowser.cancel")}
                </button>
              </div>`
            : html`<div class="actions">
                <button @click=${() => this.onDocumentClose?.()}>${t("common.close")}</button>
              </div>`
        }
      </main>
    `;
  }
}

if (!customElements.get("openclaw-human-intervention-panel")) {
  customElements.define("openclaw-human-intervention-panel", OpenClawHumanInterventionPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-human-intervention-panel": OpenClawHumanInterventionPanel;
  }
}
