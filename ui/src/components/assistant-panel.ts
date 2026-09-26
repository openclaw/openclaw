import { consume } from "@lit/context";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { isSettingsTakeover } from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";
import { chatInputOwnerForContext } from "../app/chat-input-owner.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import {
  LazyCustomElementRequestController,
  isOptionalElementDefined,
} from "../app/lazy-custom-element.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../i18n/index.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeAgentId,
  resolveUiConfiguredMainKey,
  resolveUiConversationIdentity,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import {
  CHAT_ROUTE_READY_EVENT,
  CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
} from "../pages/chat/chat-history-events.ts";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import type { CustodianSessionStore } from "../pages/custodian/custodian-session-store.ts";
import {
  consumePluginHelpAutoOpen,
  dismissPluginHelpAutoOpen,
  subscribePluginHelp,
} from "../pages/custodian/plugin-help-state.ts";
import { renderAssistantPanelLoading } from "./assistant-panel-loading.ts";
import { DockLayoutController } from "./dock-layout-controller.ts";
import { assistantPanelLayout } from "./dock-panel-layout.ts";
import { icons } from "./icons.ts";
import { renderLazyElementState } from "./lazy-view-error.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT, HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "../styles/rail-header.css";
import "../styles/assistant-panel.css";

const ASSISTANT_CONTENT_ELEMENT = {
  tagName: "openclaw-assistant-panel-content",
  get label() {
    return t("assistantPanel.title");
  },
  loadModule: () => import("./assistant-panel-content.ts"),
};

type AssistantDestination = "home" | "custodian";

export class OpenClawAssistantPanel extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  @property({ attribute: false })
  context: ApplicationContext | undefined;
  @property({ type: Boolean }) custodianAvailable = false;
  @property({ type: Boolean }) homeAvailable = false;
  @property({ type: Boolean }) custodianSuppressed = false;
  @property() pageSessionKey = "";
  @property() pageAgentId = "";
  @property() pageRouteId: RouteId = "chat";
  @property({ type: Boolean }) pageRouteFailed = false;
  @state() private homeStarted = false;
  private pendingPrimaryPane: ChatPaneElement | null = null;
  @state() private destination: AssistantDestination = "custodian";
  private readonly contentLoader = new LazyCustomElementRequestController(this);
  @property({ type: Number }) minimizeRequestId = 0;
  @property({ attribute: false }) store: CustodianSessionStore | undefined;

  private readonly dockLayout = new DockLayoutController(this, {
    layout: assistantPanelLayout,
    reservationPrefix: "assistant",
    isAvailable: () => this.available,
  });
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);
  private handledMinimizeRequestId = 0;
  private targetScope = "";
  private homeDefaults: {
    agentsList?: ApplicationContext["agents"]["state"]["agentsList"];
    hello?: ApplicationContext["gateway"]["snapshot"]["hello"];
  } = {};

  constructor() {
    super();
    void new SubscriptionsController(this)
      .watch(
        () => this.context,
        (context, notify) => subscribePluginHelp(context, notify),
      )
      .watch(
        () => this.store,
        (store, notify) => store.subscribe(notify),
      )
      .watch(
        () => this.context?.agentSelection,
        (selection, notify) => selection.subscribe(notify),
      )
      .watch(
        () => this.context?.agents,
        (agents, notify) => agents.subscribe(notify),
      )
      .watch(
        () => this.context?.gateway,
        (gateway, notify) => gateway.subscribe(notify),
      );
  }

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener(CHAT_ROUTE_READY_EVENT, this.startHomeAfterPrimaryChat);
    document.addEventListener(
      CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
      this.startHomeAfterPrimaryChat,
    );
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.addEventListener(HOME_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.dockLayout.setSuppressed(this.restoreSuppressed);
  }

  override disconnectedCallback(): void {
    document.removeEventListener(CHAT_ROUTE_READY_EVENT, this.startHomeAfterPrimaryChat);
    document.removeEventListener(
      CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
      this.startHomeAfterPrimaryChat,
    );
    this.pendingPrimaryPane = null;
    window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.removeEventListener(HOME_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.claimInput("page");
    super.disconnectedCallback();
  }

  override willUpdate(): void {
    const wasOpen = this.dockLayout.open;
    const scope = this.context?.gateway.connection.gatewayUrl ?? "";
    if (scope !== this.targetScope) {
      this.targetScope = scope;
      this.homeStarted = false;
      this.pendingPrimaryPane = null;
      this.homeDefaults = {};
      let saved: Record<string, unknown> | null = null;
      try {
        saved = asNullableRecord(
          JSON.parse(getSafeLocalStorage()?.getItem(this.targetStorageKey) ?? "null"),
        );
      } catch {}
      this.destination = saved?.destination === "home" ? "home" : "custodian";
    }
    if (this.context?.gateway.snapshot.phase === "connected") {
      // Roster/hello disappear during reconnect; keep the captured Home identity with its outbox.
      this.homeDefaults = {
        agentsList: this.context.agents.state.agentsList ?? this.homeDefaults.agentsList,
        hello: this.context.gateway.snapshot.hello,
      };
    }
    this.dockLayout.setSuppressed(this.restoreSuppressed);
    if (
      this.minimizeRequestId > 0 &&
      this.minimizeRequestId !== this.handledMinimizeRequestId &&
      this.custodianAvailable &&
      this.store
    ) {
      this.handledMinimizeRequestId = this.minimizeRequestId;
      if (this.store.hasRealUserTurn()) {
        this.openDestination("custodian");
      }
    }
    if (!this.available) {
      this.dockLayout.hideWithoutPersisting();
    } else {
      this.dockLayout.restoreOpenState();
    }
    if (wasOpen && !this.dockLayout.open) {
      this.claimInput("page");
    }
    if (
      this.context &&
      this.custodianAvailable &&
      !this.custodianSuppressed &&
      window.innerWidth > 1100 &&
      consumePluginHelpAutoOpen(this.context)
    ) {
      this.openDestination("custodian");
    }
    this.startHomeAfterPrimaryChat();
    this.contentLoader.requestWhileActive(
      ASSISTANT_CONTENT_ELEMENT,
      (this.dockLayout.open && (this.destination !== "home" || this.homeStarted)) ||
        (this.custodianAvailable && this.minimizeRequestId > this.handledMinimizeRequestId),
    );
    this.dockLayout.syncReservation();
  }

  private primaryChatPane(): ChatPaneElement | undefined {
    const root = this.closest("openclaw-app-shell") ?? this.parentElement;
    return [
      ...(root?.querySelectorAll<ChatPaneElement>(
        "openclaw-chat-pane.chat-pane-cache__pane--active",
      ) ?? []),
    ].find(
      (pane) =>
        pane.presented !== false &&
        pane.sessionKey &&
        areUiSessionKeysEquivalent(pane.sessionKey, this.pageSessionKey),
    );
  }

  private readonly startHomeAfterPrimaryChat = (): void => {
    if (this.homeStarted || !this.dockLayout.open || this.destination !== "home") {
      return;
    }
    if (this.pageRouteId !== "chat" || this.pageRouteFailed) {
      this.homeStarted = true;
      return;
    }
    const pane = this.primaryChatPane();
    if (!pane?.transcriptReady || this.pendingPrimaryPane === pane) {
      return;
    }
    this.pendingPrimaryPane = pane;
    const context = this.context;
    // The loading edge precedes the pane's render invalidation. Wait for that
    // commit before a restored Home starts its competing transcript request.
    void Promise.resolve()
      .then(() => pane.updateComplete)
      .then(() => {
        if (this.pendingPrimaryPane !== pane) {
          return;
        }
        this.pendingPrimaryPane = null;
        if (
          this.isConnected &&
          this.context === context &&
          this.primaryChatPane() === pane &&
          pane.transcriptReady
        ) {
          this.homeStarted = true;
        }
      });
  };

  private get targetStorageKey(): string {
    return `openclaw.assistant.panel.target.v1:${this.targetScope}`;
  }

  private persistTarget(): void {
    try {
      getSafeLocalStorage()?.setItem(
        this.targetStorageKey,
        JSON.stringify({ destination: this.destination }),
      );
    } catch {}
  }

  private get homeTarget() {
    const defaults = this.homeDefaults;
    const agents = listSelectableAgents(defaults.agentsList?.agents ?? []);
    const defaultId = resolveUiDefaultAgentId(defaults);
    // The sidebar switcher (agentSelection) is the only agent chooser; the dock
    // shows the selected agent's Home and never grows a second switcher.
    const rawSelectedId = this.context?.agentSelection.state.selectedId;
    const selectedId = rawSelectedId ? normalizeAgentId(rawSelectedId) : "";
    const agentId =
      agents.find((agent) => agent.id === selectedId)?.id ??
      agents.find((agent) => agent.id === defaultId)?.id ??
      agents[0]?.id ??
      defaultId;
    return {
      ...resolveUiConversationIdentity(
        defaults,
        buildAgentMainSessionKey({ agentId, mainKey: resolveUiConfiguredMainKey(defaults) }),
        agentId,
      ),
      agentId,
    };
  }

  private availableFor(destination: AssistantDestination): boolean {
    return destination === "home" ? this.homeAvailable : this.custodianAvailable;
  }

  private get available(): boolean {
    return this.availableFor(this.destination);
  }

  private get suppressed(): boolean {
    if (this.destination === "custodian") {
      return this.custodianSuppressed;
    }
    const context = this.context;
    if (!context || this.pageRouteId !== "chat") {
      return false;
    }
    const page = resolveUiConversationIdentity(
      this.homeDefaults,
      this.pageSessionKey,
      this.pageAgentId,
    );
    const home = this.homeTarget;
    return page.sessionKey === home.sessionKey && normalizeAgentId(page.agentId) === home.agentId;
  }

  private claimInput(region: "page" | "dock"): void {
    if (this.context) {
      chatInputOwnerForContext(this.context).claim(region);
    }
  }

  private get restoreSuppressed(): boolean {
    // Home follows the visible Settings context; automatic diagnostic restores yield to it.
    return (
      this.suppressed || (this.destination === "custodian" && isSettingsTakeover(this.pageRouteId))
    );
  }

  private openDestination(destination: AssistantDestination): void {
    this.destination = destination;
    this.dockLayout.setSuppressed(this.restoreSuppressed);
    if (this.available) {
      // Keep explicit open intent even when the same Home conversation owns the page.
      this.setOpen(true);
      if (this.suppressed) {
        this.dockLayout.hideWithoutPersisting();
        this.claimInput("page");
        if (destination === "home") {
          this.openHomePage();
        }
      }
    }
  }

  private openHomePage(): void {
    if (this.context) {
      const { sessionKey, agentId } = this.homeTarget;
      const target = sessionNavigationTarget({
        context: this.context,
        face: "chat",
        sessionKey,
        agentId,
        focusComposer: true,
      });
      this.context.navigate("chat", target.options);
    }
  }

  private setOpen(open: boolean): void {
    if (!open && this.destination === "custodian" && this.context) {
      dismissPluginHelpAutoOpen(this.context);
    }
    if (open && this.destination === "home") {
      this.homeStarted = true;
    }
    this.persistTarget();
    this.dockLayout.setOpen(open);
    this.claimInput(open ? "dock" : "page");
  }

  toggle(): void {
    if (!this.available) {
      return;
    }
    if (this.suppressed) {
      if (this.destination === "home") {
        this.openHomePage();
      }
      return;
    }
    this.setOpen(!this.dockLayout.open);
  }

  handleToggleRequest(event: Event): void {
    const destination = event.type === HOME_PANEL_TOGGLE_EVENT ? "home" : "custodian";
    if (!this.availableFor(destination)) {
      return;
    }
    const detail = asNullableRecord(event instanceof CustomEvent ? event.detail : null);
    const dock = detail?.dock;
    if (dock === "right" || dock === "bottom") {
      this.dockLayout.setDock(dock, false);
    }
    if (detail?.open === false) {
      if (this.destination === destination) {
        this.setOpen(false);
      }
    } else if (this.destination !== destination || detail?.open === true) {
      this.openDestination(destination);
    } else {
      this.toggle();
    }
  }

  get assistantPanelOpen(): boolean {
    return this.dockLayout.open;
  }

  override render() {
    const visible = this.available && this.dockLayout.open;
    const dock = this.dockLayout.dock;
    const home = this.homeTarget;
    const contentState = this.contentLoader.visibleState;
    const style =
      dock === "bottom" ? `height:${this.dockLayout.height}px` : `width:${this.dockLayout.width}px`;
    return html`
      <section
        class="assistant-panel assistant-panel--${dock}"
        style=${style}
        ?hidden=${!visible}
        aria-label=${t("assistantPanel.title")}
        @pointerdown=${() => this.claimInput("dock")}
        @focusin=${() => this.claimInput("dock")}
      >
        ${this.dockLayout.renderResizer("assistant-panel", t("assistantPanel.resize"))}
        <header class="rail-header assistant-panel-header" @mousedown=${beginNativeWindowDrag}>
          <div class="assistant-panel-title">
            <openclaw-mascot
              .mood=${this.destination === "custodian" && this.store?.sending ? "thinking" : "idle"}
              .size=${16}
            ></openclaw-mascot>
            ${(["home", "custodian"] as const).map((destination) =>
              this.availableFor(destination)
                ? html`<button
                    type="button"
                    class="assistant-panel-tab"
                    aria-pressed=${this.destination === destination}
                    @click=${() => this.openDestination(destination)}
                  >
                    ${t(destination === "home" ? "assistantPanel.home" : "nav.askOpenClaw")}
                  </button>`
                : nothing,
            )}
          </div>
          <div class="rail-header__actions assistant-panel-actions">
            ${
              this.destination === "home"
                ? html`<button
                    class="rail-header__action assistant-panel-icon"
                    type="button"
                    aria-label=${t("assistantPanel.openHome")}
                    @click=${() => this.openHomePage()}
                  >
                    ${icons.maximize}
                  </button>`
                : nothing
            }
            <button
              class="rail-header__action assistant-panel-icon"
              type="button"
              aria-label=${
                dock === "bottom" ? t("assistantPanel.dockRight") : t("assistantPanel.dockBottom")
              }
              @click=${() => this.dockLayout.setDock(dock === "bottom" ? "right" : "bottom")}
            >
              ${dock === "bottom" ? icons.panelRightOpen : icons.panelBottomOpen}
            </button>
            <button
              class="rail-header__action assistant-panel-icon"
              type="button"
              aria-label=${t("assistantPanel.close")}
              @click=${() => this.setOpen(false)}
            >
              ${icons.x}
            </button>
          </div>
        </header>
        ${
          isOptionalElementDefined(ASSISTANT_CONTENT_ELEMENT)
            ? html`<openclaw-assistant-panel-content
                ?hidden=${!visible || (this.destination === "home" && !this.homeStarted)}
                .active=${visible && (this.destination !== "home" || this.homeStarted)}
                .destination=${this.destination}
                .sessionKey=${home.sessionKey}
                .agentId=${home.agentId}
                .context=${this.context}
                .pageRouteId=${this.pageRouteId}
                .pageSessionKey=${this.pageSessionKey}
                .pageAgentId=${this.pageAgentId}
                .store=${this.store}
                @assistant-custodian-store=${(event: CustomEvent<CustodianSessionStore>) => {
                  this.store = event.detail;
                }}
              ></openclaw-assistant-panel-content>`
            : nothing
        }
        ${
          visible &&
          (!isOptionalElementDefined(ASSISTANT_CONTENT_ELEMENT) ||
            (this.destination === "home" && !this.homeStarted))
            ? contentState?.status === "error"
              ? renderLazyElementState(
                  contentState,
                  () => this.contentLoader.retry(),
                  () => this.setOpen(false),
                )
              : renderAssistantPanelLoading()
            : nothing
        }
      </section>
    `;
  }
}

if (!customElements.get("openclaw-assistant-panel")) {
  customElements.define("openclaw-assistant-panel", OpenClawAssistantPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-assistant-panel": OpenClawAssistantPanel;
  }
}
