import { consume } from "@lit/context";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { ensureCustomElementDefined } from "../../app/lazy-custom-element.ts";
import { t } from "../../i18n/index.ts";
import type { BoardGridDirection, BoardGridRect } from "../../lib/board/grid.ts";
import { toCssPlacement } from "../../lib/board/grid.ts";
import type { BoardWidgetAppViewState } from "../../lib/board/provider.ts";
import type { BoardTab } from "../../lib/board/types.ts";
import type {
  BoardGrantDecision,
  BoardViewWidget,
  BoardWidgetFrameUrl,
} from "../../lib/board/view-types.ts";
import { BoardWidgetSandboxHost } from "../../lib/board/widget-sandbox-host.ts";
import { getBuiltinWidgetRenderer } from "../../lib/board/widgets/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderBoardMcpAppContent } from "./board-mcp-app-content.ts";
import { BoardMcpAppLifecycle } from "./board-mcp-app-lifecycle.ts";
import { resolveGatewayHttpOrigin, resolveSandboxHostUrl } from "../sandbox-host.ts";
import { renderBoardGrantedCapabilities } from "./board-widget-capabilities.ts";
import {
  BOARD_SIZE_PRESETS,
  closeBoardWidgetMenu,
  renderBoardWidgetActionError,
  renderBoardWidgetError,
  renderBoardWidgetMenu,
  renderBoardWidgetPending,
  renderBoardWidgetRejected,
} from "./board-widget-cell-render.ts";
import { BoardWidgetTicketRefresh } from "./board-widget-ticket-refresh.ts";
import "../tooltip.ts";
import "../web-awesome.ts";

const MAX_FRAME_REFRESH_ATTEMPTS = 3;
const loadMcpAppView = () => import("../mcp-app-view-registration.ts");

export type BoardWidgetCellCallbacks = {
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  movePointerDown: (widget: BoardViewWidget, event: PointerEvent) => void;
  resizePointerDown: (widget: BoardViewWidget, event: PointerEvent) => void;
  moveToTab: (widget: BoardViewWidget, tabId: string) => Promise<void>;
  resizeTo: (widget: BoardViewWidget, w: number, h: number) => Promise<void>;
  remove: (widget: BoardViewWidget) => Promise<void>;
  nudge: (widget: BoardViewWidget, direction: BoardGridDirection) => Promise<void>;
  focus: (widget: BoardViewWidget, direction: BoardGridDirection) => void;
  focusChanged: (name: string) => void;
  frameLoadFailed: (name: string) => Promise<void>;
  widgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

class OpenClawBoardWidgetCell extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) widget?: BoardViewWidget;
  @property({ attribute: false }) rect?: BoardGridRect;
  @property({ attribute: false }) tabs: readonly BoardTab[] = [];
  @property({ attribute: false }) sessionKey = "";
  @property({ attribute: false }) widgetFrameUrl?: BoardWidgetFrameUrl;
  @property({ attribute: false }) callbacks?: BoardWidgetCellCallbacks;
  @property({ attribute: false }) sessions: readonly GatewaySessionRow[] = [];
  @property({ type: Boolean }) dragging = false;
  @property({ type: Number }) focusTabIndex = -1;
  @property({ type: Number }) positionInSet = 1;
  @property({ type: Number }) setSize = 1;
  @property({ type: Boolean }) busy = false;

  @state() private actionError = "";
  @state() private actionPending = false;
  @state() private frameError = "";
  private frameFailureKey = "";
  private frameRefreshAttempts = 0;
  private frameProbeGeneration = 0;
  private lastFrameUrl = "";
  private readonly appView = new BoardMcpAppLifecycle({
    connected: () => this.isConnected,
    requestUpdate: () => this.requestUpdate(),
    sessionKey: () => this.sessionKey,
    widget: () => this.widget,
  });
  private sandboxOrigin = "";
  private sandboxContext?: ApplicationContext;
  private sandboxHost: BoardWidgetSandboxHost | null = null;
  private readonly ticketRefresh = new BoardWidgetTicketRefresh(() => this.widget?.viewTicket);

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.handleSandboxMessage);
    this.requestUpdate();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    const previousWidget = changed.get("widget");
    if (previousWidget && previousWidget !== this.widget) {
      this.actionError = "";
      if (
        previousWidget.name !== this.widget?.name ||
        previousWidget.revision !== this.widget?.revision
      ) {
        this.resetFrameFailures();
      } else if (this.widget && this.frameError) {
        const nextFrameUrl = this.widgetFrameUrl?.(this.widget.name, this.widget.revision) ?? "";
        if (nextFrameUrl && nextFrameUrl !== this.lastFrameUrl) {
          // A newly minted ticket gets one authorization probe, but keeps the
          // existing remint budget until that probe proves the frame healthy.
          this.frameError = "";
        }
      }
    }
    this.appView.update(this.widget, this.callbacks);
  }

  override updated(changed: PropertyValues<this>): void {
    if (!this.isConnected) {
      this.appView.observe(null, false);
      return;
    }
    this.appView.observe(
      this.querySelector(".board-widget"),
      this.widget?.contentKind === "mcp-app",
    );
    queueMicrotask(() => {
      if (this.isConnected) {
        this.appView.sync();
      }
    });
    const contextChanged = this.sandboxContext !== this.context;
    if (
      changed.has("widget") ||
      changed.has("callbacks") ||
      contextChanged ||
      changed.has("widgetFrameUrl")
    ) {
      // Context subscriptions request an update without registering a Lit
      // property change. Track identity explicitly so reconnects replace the
      // Gateway client behind an already-adopted private bridge port.
      this.sandboxContext = this.context;
      this.scheduleTicketRefresh();
      this.updateSandboxHost();
    }
  }

  override disconnectedCallback(): void {
    window.removeEventListener("message", this.handleSandboxMessage);
    this.ticketRefresh.clear();
    this.sandboxHost?.dispose();
    this.sandboxHost = null;
    this.appView.disconnect();
    super.disconnectedCallback();
  }

  private scheduleTicketRefresh(): void {
    this.ticketRefresh.schedule(this.widget, this.callbacks?.frameLoadFailed);
  }

  private resetFrameFailures(): void {
    this.frameProbeGeneration += 1;
    this.frameFailureKey = "";
    this.frameRefreshAttempts = 0;
    this.frameError = "";
    this.sandboxHost?.reset();
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.actionPending || this.busy) {
      return;
    }
    this.actionPending = true;
    this.actionError = "";
    closeBoardWidgetMenu(this);
    try {
      await action();
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error);
    } finally {
      this.actionPending = false;
    }
  }

  private handleMenuSelect(
    event: CustomEvent<{ item: { value?: string } }>,
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    const value = event.detail.item.value;
    if (value === "remove") {
      void this.runAction(() => callbacks.remove(widget));
      return;
    }
    if (value?.startsWith("move:")) {
      void this.runAction(() => callbacks.moveToTab(widget, value.slice("move:".length)));
      return;
    }
    if (value?.startsWith("resize:")) {
      const preset = value.slice("resize:".length) as keyof typeof BOARD_SIZE_PRESETS;
      const size = BOARD_SIZE_PRESETS[preset];
      if (size) {
        void this.runAction(() => callbacks.resizeTo(widget, size.w, size.h));
      }
    }
  }

  private refreshFailedFrame(widget: BoardViewWidget, callbacks: BoardWidgetCellCallbacks): void {
    this.frameProbeGeneration += 1;
    const failureKey = `${widget.name}:${widget.revision}`;
    if (this.frameFailureKey !== failureKey) {
      this.resetFrameFailures();
      this.frameFailureKey = failureKey;
    }
    if (this.frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
      this.frameError = t("board.widget.frameAuthorizationFailed");
      return;
    }
    this.frameRefreshAttempts += 1;
    void callbacks.frameLoadFailed(widget.name).catch((error: unknown) => {
      this.frameError = error instanceof Error ? error.message : String(error);
    });
    if (this.frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
      this.frameError = t("board.widget.frameAuthorizationFailed");
    }
  }

  private verifyFrameAuthorization(
    event: Event,
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    const frame = event.currentTarget;
    const src = frame instanceof HTMLIFrameElement ? (frame.getAttribute("src") ?? "") : "";
    if (!src.startsWith("/__openclaw__/board/")) {
      return;
    }
    const probeGeneration = this.frameProbeGeneration + 1;
    this.frameProbeGeneration = probeGeneration;
    const isCurrentProbe = () =>
      frame instanceof HTMLIFrameElement &&
      frame.isConnected &&
      frame.getAttribute("src") === src &&
      this.frameProbeGeneration === probeGeneration &&
      this.widget?.name === widget.name &&
      this.widget.revision === widget.revision;
    // View tickets are reusable HMAC bindings until expiry. Iframe load events
    // hide HTTP status, so a credentialed probe is the only 401 signal.
    void fetch(src, { cache: "no-store" })
      .then((response) => {
        if (!isCurrentProbe()) {
          return;
        }
        if (response.status === 401) {
          this.refreshFailedFrame(widget, callbacks);
        } else if (response.ok) {
          this.resetFrameFailures();
        }
      })
      .catch(() => {
        if (isCurrentProbe()) {
          this.refreshFailedFrame(widget, callbacks);
        }
      });
  }

  private resolveSandboxFrameUrl(widget: BoardViewWidget): string | undefined {
    const gatewayUrl = this.context?.gateway.connection.gatewayUrl;
    if (
      !widget.sandboxUrl ||
      !widget.sandboxPort ||
      !widget.viewTicket ||
      gatewayUrl === undefined
    ) {
      return undefined;
    }
    const url = resolveSandboxHostUrl(
      widget.sandboxUrl,
      widget.sandboxPort,
      widget.sandboxOrigin,
      gatewayUrl,
      window.location.origin,
    );
    this.sandboxOrigin = new URL(url).origin;
    return url;
  }

  private sandboxHostOptions(
    frame: HTMLIFrameElement,
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): ConstructorParameters<typeof BoardWidgetSandboxHost>[0] | undefined {
    if (!this.widgetFrameUrl) {
      return undefined;
    }
    return {
      frame,
      widget,
      sandboxOrigin: this.sandboxOrigin,
      sandboxUrl: frame.src,
      sourceOrigin: resolveGatewayHttpOrigin(
        this.context?.gateway.connection.gatewayUrl ?? "",
        window.location.origin,
      ),
      client: this.context?.gateway.snapshot.client ?? undefined,
      resolveFrameUrl: this.widgetFrameUrl,
      confirmPrompt: (prompt) => window.confirm(`${t("common.confirm")}:\n\n${prompt}`),
      onFrameUrl: (url) => {
        this.lastFrameUrl = url;
      },
      onUnauthorized: (currentWidget) => this.refreshFailedFrame(currentWidget, callbacks),
      onReadyTimeout: () => this.refreshFailedFrame(widget, callbacks),
      onLoaded: () => {
        this.frameFailureKey = "";
        this.frameRefreshAttempts = 0;
        this.frameError = "";
      },
      onError: (error) => {
        this.frameError = error instanceof Error ? error.message : String(error);
      },
    };
  }

  private updateSandboxHost(): void {
    const frame = this.querySelector<HTMLIFrameElement>(".board-widget__frame");
    const widget = this.widget;
    const callbacks = this.callbacks;
    if (
      !frame?.isConnected ||
      !widget ||
      !callbacks ||
      !widget.sandboxUrl ||
      !widget.sandboxPort ||
      !widget.viewTicket
    ) {
      this.sandboxHost?.dispose();
      this.sandboxHost = null;
      return;
    }
    const options = this.sandboxHostOptions(frame, widget, callbacks);
    if (!options) {
      return;
    }
    if (!this.sandboxHost || this.sandboxHost.frame !== frame) {
      this.sandboxHost?.dispose();
      this.sandboxHost = new BoardWidgetSandboxHost(options);
    } else {
      this.sandboxHost.update(options);
    }
  }

  private handleSandboxMessage = (event: MessageEvent): void => {
    const frame = this.querySelector<HTMLIFrameElement>(".board-widget__frame");
    const widget = this.widget;
    const callbacks = this.callbacks;
    if (
      !frame ||
      !widget ||
      !callbacks ||
      !widget.viewTicket ||
      event.source !== frame.contentWindow ||
      event.origin !== this.sandboxOrigin
    ) {
      return;
    }
    const options = this.sandboxHostOptions(frame, widget, callbacks);
    if (!options) {
      return;
    }
    if (!this.sandboxHost || this.sandboxHost.frame !== frame) {
      this.sandboxHost?.dispose();
      this.sandboxHost = new BoardWidgetSandboxHost(options);
    } else {
      this.sandboxHost.update(options);
    }
    this.sandboxHost.handleMessage(event);
  };

  private renderFrame(
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): TemplateResult {
    if (!this.widgetFrameUrl) {
      throw new Error(t("board.widget.frameResolverMissing"));
    }
    const src = this.widgetFrameUrl(widget.name, widget.revision);
    this.lastFrameUrl = src;
    const sandboxSrc = this.resolveSandboxFrameUrl(widget);
    if (sandboxSrc) {
      return html`
        <iframe
          class="board-widget__frame"
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="origin"
          loading="eager"
          title=${widget.title || widget.name}
          src=${sandboxSrc}
          @error=${() => {
            if (this.sandboxHost) {
              this.sandboxHost.handleFrameError();
            } else {
              this.refreshFailedFrame(widget, callbacks);
            }
          }}
        ></iframe>
      `;
    }
    if (widget.sandboxUrl || widget.sandboxPort || widget.viewTicket) {
      throw new Error(t("board.widget.sandboxUnavailable"));
    }
    // Snapshots from hosts predating the shared-sandbox contract remain capless:
    // no bridge ticket or network CSP authority crosses this compatibility path.
    return html`
      <iframe
        class="board-widget__frame"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        loading="lazy"
        title=${widget.title || widget.name}
        src=${src}
        @error=${() => this.refreshFailedFrame(widget, callbacks)}
        @load=${(event: Event) => this.verifyFrameAuthorization(event, widget, callbacks)}
      ></iframe>
    `;
  }

  private renderMcpApp(
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): TemplateResult {
    void ensureCustomElementDefined("mcp-app-view", loadMcpAppView).catch(() => undefined);
    const accessNotice =
      widget.grantState === "pending"
        ? renderBoardWidgetPending({
            widget,
            disabled: this.busy || this.actionPending,
            onGrant: (decision) =>
              void this.runAction(() => callbacks.grant(widget.name, decision)),
            ...(this.actionError
              ? { error: renderBoardWidgetActionError(this.actionError, true) }
              : {}),
          })
        : widget.grantState === "rejected"
          ? renderBoardWidgetRejected({
              widget,
              disabled: this.busy || this.actionPending,
              onRemove: () => void this.runAction(() => callbacks.remove(widget)),
            })
          : nothing;
    return renderBoardMcpAppContent({
      accessNotice,
      appView: this.appView.state,
      busy: this.busy || this.actionPending,
      loading: this.appView.loading,
      nearVisible: this.appView.nearVisible,
      rectHeight: this.rect?.h ?? 4,
      sessionKey: this.sessionKey,
      widget,
      expired: () => this.appView.expire(),
      remove: () => void this.runAction(() => callbacks.remove(widget)),
      retry: () => this.appView.retry(),
    });
  }

  private renderBody(widget: BoardViewWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    if (widget.contentKind === "mcp-app") {
      return this.renderMcpApp(widget, callbacks);
    }
    if (widget.grantState === "pending") {
      return renderBoardWidgetPending({
        widget,
        disabled: this.busy || this.actionPending,
        onGrant: (decision) => void this.runAction(() => callbacks.grant(widget.name, decision)),
        ...(this.actionError
          ? { error: renderBoardWidgetActionError(this.actionError, true) }
          : {}),
      });
    }
    if (widget.grantState === "rejected") {
      return renderBoardWidgetRejected({
        widget,
        disabled: this.busy || this.actionPending,
        onRemove: () => void this.runAction(() => callbacks.remove(widget)),
      });
    }
    if (widget.contentKind === "builtin") {
      const renderer = getBuiltinWidgetRenderer(widget.builtin);
      if (!renderer) {
        throw new Error(t("board.widget.frameResolverMissing"));
      }
      return renderer({ sessions: this.sessions, sessionKey: this.sessionKey });
    }
    return this.renderFrame(widget, callbacks);
  }

  private handleKeyDown(
    event: KeyboardEvent,
    widget: BoardViewWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    if (event.target !== event.currentTarget || widget.readOnly) {
      return;
    }
    const direction =
      event.key === "ArrowLeft"
        ? "left"
        : event.key === "ArrowRight"
          ? "right"
          : event.key === "ArrowUp"
            ? "up"
            : event.key === "ArrowDown"
              ? "down"
              : null;
    if (!direction) {
      return;
    }
    event.preventDefault();
    if (event.altKey) {
      void this.runAction(() => callbacks.nudge(widget, direction));
    } else {
      callbacks.focus(widget, direction);
    }
  }

  override render() {
    const widget = this.widget;
    const rect = this.rect;
    const callbacks = this.callbacks;
    if (!widget || !rect || !callbacks) {
      return nothing;
    }
    let body: TemplateResult;
    let bodyErrored: boolean;
    try {
      body = this.frameError
        ? renderBoardWidgetError(this.frameError)
        : this.renderBody(widget, callbacks);
      bodyErrored = Boolean(this.frameError);
    } catch (error) {
      body = renderBoardWidgetError(error);
      bodyErrored = true;
    }
    const label = widget.title || widget.name;
    const readOnly = widget.readOnly === true;
    const bodyScrollable =
      bodyErrored ||
      this.actionError !== "" ||
      widget.grantState === "pending" ||
      widget.grantState === "rejected";
    const contentScrollable = bodyScrollable || widget.contentKind === "mcp-app";
    return html`
      <section
        class=${`board-widget ${this.dragging ? "board-widget--dragging" : ""}`}
        style=${toCssPlacement(rect)}
        role="listitem"
        tabindex=${this.focusTabIndex}
        aria-posinset=${this.positionInSet}
        aria-setsize=${this.setSize}
        aria-label=${readOnly ? label : t("board.widget.cellLabel", { title: label })}
        data-widget-name=${widget.name}
        data-test-id="board-widget"
        @focus=${() => callbacks.focusChanged(widget.name)}
        @keydown=${(event: KeyboardEvent) => this.handleKeyDown(event, widget, callbacks)}
      >
        <header class="board-widget__bar">
          ${readOnly
            ? nothing
            : html`<span
                class="board-widget__drag-handle"
                aria-hidden="true"
                title=${t("board.widget.moveHandle", { title: label })}
                @pointerdown=${(event: PointerEvent) => callbacks.movePointerDown(widget, event)}
              >
                <span aria-hidden="true">⠿</span>
              </span>`}
          <span class="board-widget__title" title=${label}>${label}</span>
          ${widget.contentKind === "builtin"
            ? nothing
            : html`<span class="board-widget__kind"
                >${widget.contentKind === "mcp-app"
                  ? t("board.widget.kindMcp")
                  : t("board.widget.kindHtml")}</span
              >`}
          ${widget.contentKind === "builtin" ? nothing : renderBoardGrantedCapabilities(widget)}
          ${readOnly
            ? nothing
            : renderBoardWidgetMenu({
                widget,
                tabs: this.tabs,
                disabled: this.busy || this.actionPending,
                onSelect: (event) => this.handleMenuSelect(event, widget, callbacks),
              })}
        </header>
        <div
          class=${`board-widget__body ${contentScrollable ? "board-widget__body--scrollable" : ""}`}
        >
          ${body}
          ${this.actionError && widget.grantState !== "pending"
            ? html`<div class="board-widget__error-overlay">
                ${renderBoardWidgetActionError(this.actionError)}
              </div>`
            : nothing}
        </div>
        ${readOnly
          ? nothing
          : html`<span
              class="board-widget__resize-handle"
              aria-hidden="true"
              title=${t("board.widget.resizeHandle", { title: label })}
              @pointerdown=${(event: PointerEvent) => callbacks.resizePointerDown(widget, event)}
            ></span>`}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-board-widget-cell")) {
  customElements.define("openclaw-board-widget-cell", OpenClawBoardWidgetCell);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-widget-cell": OpenClawBoardWidgetCell;
  }
}
