import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { isSettingsTakeover } from "../app-navigation.ts";
import { isSessionRouteId, type RouteId } from "../app-route-paths.ts";
import type { AssistantDockOwner } from "../app/assistant-dock.ts";
import { chatInputOwnerForContext } from "../app/chat-input-owner.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  LazyCustomElementRequestController,
  isOptionalElementDefined,
} from "../app/lazy-custom-element.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
import { t } from "../lib/reactive/i18n.ts";
import {
  prepareSessionNavigationHandoff,
  runSessionNavigationIntent,
} from "../lib/sessions/navigation-handoff.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  normalizeAgentId,
  resolveUiConfiguredMainKey,
  resolveUiConversationIdentity,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import type { SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { SolidController, SolidControllerHost } from "../lit/solid-controller-host.ts";
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
import { DockLayoutController } from "./dock-layout-controller.ts";
import { assistantPanelLayout } from "./dock-panel-layout.ts";
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

type AssistantDestination =
  | "home"
  | "custodian"
  | {
      params: Parameters<AssistantDockOwner["openSession"]>[0];
      activation: object;
    };

export type AssistantPanelProps = {
  context?: ApplicationContext;
  custodianAvailable: boolean;
  homeAvailable: boolean;
  custodianSuppressed: boolean;
  pageSessionKey: string;
  pageAgentId: string;
  pageRouteId: RouteId;
  pageRouteFailed: boolean;
  minimizeRequestId: number;
  store?: CustodianSessionStore;
};
export class AssistantPanelController {
  get context() {
    return this.props.context ?? this.application;
  }
  get isConnected() {
    return this.element.isConnected;
  }
  get updateComplete() {
    return this.element.updateComplete;
  }
  requestUpdate() {
    this.controllerHost.requestUpdate();
  }
  addController(controller: SolidController) {
    this.controllerHost.addController(controller);
  }
  removeController(controller: SolidController) {
    this.controllerHost.removeController(controller);
  }
  private startedHome = false;
  get homeStarted() {
    return this.startedHome;
  }
  set homeStarted(value: boolean) {
    if (this.startedHome !== value) {
      this.startedHome = value;
      this.requestUpdate();
    }
  }
  private pendingPrimaryPane: ChatPaneElement | null = null;
  private currentDestination: AssistantDestination = "custodian";
  get destination() {
    return this.currentDestination;
  }
  set destination(value: AssistantDestination) {
    if (this.currentDestination !== value) {
      this.currentDestination = value;
      this.requestUpdate();
    }
  }
  /** Built-in target a plugin dock replaced; restored when that dock closes. */
  private builtInDestination: "home" | "custodian" = "custodian";
  private publishedSessionKey: string | null = null;
  readonly contentLoader = new LazyCustomElementRequestController(this);

  readonly dockLayout: DockLayoutController<"bottom" | "right">;
  private readonly onToggleRequest = (event: Event) => this.handleToggleRequest(event);
  private handledMinimizeRequestId = 0;
  private targetScope = "";
  private homeDefaults: {
    agentsList?: ApplicationContext["agents"]["state"]["agentsList"];
    hello?: ApplicationContext["gateway"]["snapshot"]["hello"];
  } = {};

  constructor(
    public props: AssistantPanelProps,
    private readonly element: SolidBridgeElement<AssistantPanelProps>,
    private controllerHost: SolidControllerHost,
    private application?: ApplicationContext,
  ) {
    this.dockLayout = new DockLayoutController(this, {
      layout: assistantPanelLayout,
      reservationPrefix: "assistant",
      isAvailable: () => this.available,
    });
    this.attach(props, controllerHost, application);
  }

  attach(
    props: AssistantPanelProps,
    controllerHost: SolidControllerHost,
    application?: ApplicationContext,
  ) {
    this.props = props;
    this.controllerHost = controllerHost;
    this.application = application;
    controllerHost.addController(this.dockLayout);
    void new SubscriptionsController(this)
      .effect(
        () => this.context?.assistantDock,
        (dock) => dock.attach(this),
      )
      .watch(
        () => this.context,
        (context, notify) => subscribePluginHelp(context, notify),
      )
      .watchStore(() => this.props.store)
      .watchStore(() => this.context?.agentSelection)
      .watchStore(() => this.context?.agents)
      .watchStore(() => this.context?.theme)
      .watchStore(() => this.context?.gateway);
  }

  connected(): void {
    document.addEventListener(CHAT_ROUTE_READY_EVENT, this.startHomeAfterPrimaryChat);
    document.addEventListener(
      CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
      this.startHomeAfterPrimaryChat,
    );
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.addEventListener(HOME_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    this.dockLayout.setSuppressed(this.restoreSuppressed);
  }

  disconnected(): void {
    document.removeEventListener(CHAT_ROUTE_READY_EVENT, this.startHomeAfterPrimaryChat);
    document.removeEventListener(
      CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
      this.startHomeAfterPrimaryChat,
    );
    this.pendingPrimaryPane = null;
    window.removeEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    window.removeEventListener(HOME_PANEL_TOGGLE_EVENT, this.onToggleRequest);
    if (typeof this.destination !== "string") {
      this.closeSession();
    }
    this.claimInput("page");
  }

  update(): void {
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
      this.builtInDestination = this.destination;
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
      this.props.minimizeRequestId > 0 &&
      this.props.minimizeRequestId !== this.handledMinimizeRequestId &&
      this.props.custodianAvailable &&
      this.props.store
    ) {
      this.handledMinimizeRequestId = this.props.minimizeRequestId;
      if (typeof this.destination === "string" && this.props.store.hasRealUserTurn()) {
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
      typeof this.destination === "string" &&
      this.context &&
      this.props.custodianAvailable &&
      !this.props.custodianSuppressed &&
      window.innerWidth > 1100 &&
      consumePluginHelpAutoOpen(this.context)
    ) {
      this.openDestination("custodian");
    }
    this.startHomeAfterPrimaryChat();
    this.contentLoader.requestWhileActive(
      ASSISTANT_CONTENT_ELEMENT,
      (this.dockLayout.open && (this.destination !== "home" || this.homeStarted)) ||
        (this.props.custodianAvailable &&
          this.props.minimizeRequestId > this.handledMinimizeRequestId),
    );
    this.dockLayout.syncReservation();
    this.publishSessionKey();
  }

  private primaryChatPane(): ChatPaneElement | undefined {
    const root = this.element.closest("openclaw-app-shell") ?? this.element.parentElement;
    return [
      ...(root?.querySelectorAll<ChatPaneElement>(
        "openclaw-chat-pane.chat-pane-cache__pane--active",
      ) ?? []),
    ].find(
      (pane) =>
        pane.presented !== false &&
        pane.sessionKey &&
        areUiSessionKeysEquivalent(pane.sessionKey, this.props.pageSessionKey),
    );
  }

  private readonly startHomeAfterPrimaryChat = (): void => {
    if (this.homeStarted || !this.dockLayout.open || this.destination !== "home") {
      return;
    }
    if (this.props.pageRouteId !== "chat" || this.props.pageRouteFailed) {
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
    // Plugin targets belong to their activation, never to browser persistence.
    if (typeof this.destination !== "string") {
      return;
    }
    try {
      getSafeLocalStorage()?.setItem(
        this.targetStorageKey,
        JSON.stringify({ destination: this.destination }),
      );
    } catch {}
  }

  get homeTarget() {
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

  availableFor(destination: AssistantDestination): boolean {
    // The chat pane owns access errors and read-only composition. Always show
    // explicitly requested sessions so a denied read has its normal visible outcome.
    return (
      typeof destination !== "string" ||
      (destination === "home" ? this.props.homeAvailable : this.props.custodianAvailable)
    );
  }

  get available(): boolean {
    return this.availableFor(this.destination);
  }

  private get suppressed(): boolean {
    if (this.destination === "custodian") {
      return this.props.custodianSuppressed;
    }
    const context = this.context;
    const sessionPage =
      this.destination === "home"
        ? this.props.pageRouteId === "chat"
        : isSessionRouteId(this.props.pageRouteId);
    if (!context || !sessionPage) {
      return false;
    }
    const page = resolveUiConversationIdentity(
      this.homeDefaults,
      this.props.pageSessionKey,
      this.props.pageAgentId,
    );
    const target =
      typeof this.destination === "string"
        ? this.homeTarget
        : resolveUiConversationIdentity(
            this.homeDefaults,
            this.destination.params.sessionKey,
            this.destination.params.agentId,
          );
    return (
      page.sessionKey === target.sessionKey &&
      normalizeAgentId(page.agentId) === normalizeAgentId(target.agentId)
    );
  }

  claimInput(region: "page" | "dock"): void {
    if (this.context) {
      chatInputOwnerForContext(this.context).claim(region);
    }
  }

  private get restoreSuppressed(): boolean {
    // Home follows the visible Settings context; automatic diagnostic restores yield to it.
    return (
      this.suppressed ||
      (this.destination === "custodian" && isSettingsTakeover(this.props.pageRouteId))
    );
  }

  openSession(params: Parameters<AssistantDockOwner["openSession"]>[0], activation: object): void {
    if (typeof this.destination === "string") {
      this.builtInDestination = this.destination;
    }
    this.openDestination({ params: structuredClone(params), activation });
  }

  closeSession(activation?: object): void {
    if (
      activation &&
      (typeof this.destination === "string" || this.destination.activation !== activation)
    ) {
      return;
    }
    this.setOpen(false);
  }

  get openSessionKey(): string | null {
    return this.dockLayout.open && !this.suppressed && typeof this.destination !== "string"
      ? this.destination.params.sessionKey
      : null;
  }

  private publishSessionKey(): void {
    const key = this.openSessionKey;
    if (key !== this.publishedSessionKey) {
      this.publishedSessionKey = key;
      this.context?.assistantDock?.notify();
    }
  }

  openDestination(destination: AssistantDestination): void {
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
    this.publishSessionKey();
  }

  openHomePage(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const { sessionKey, agentId } = this.homeTarget;
    const { pageRouteId, pageSessionKey } = this.props;
    const { client, hello } = context.gateway.snapshot;
    const target = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey,
      agentId,
      focusComposer: true,
    });
    // Full-page Home is explicit selection, even when its URL already owns an unbound split.
    runSessionNavigationIntent(this, {
      face: "chat",
      sessionKey,
      agentId,
      commit: () => {
        if (
          this.context !== context ||
          this.props.pageRouteId !== pageRouteId ||
          this.props.pageSessionKey !== pageSessionKey ||
          context.gateway.snapshot.client !== client ||
          context.gateway.snapshot.hello !== hello ||
          this.homeTarget.sessionKey !== sessionKey ||
          this.homeTarget.agentId !== agentId
        ) {
          return false;
        }
        prepareSessionNavigationHandoff(context.gateway, target.options.pathname, sessionKey);
        context.navigate("chat", target.options);
        return true;
      },
    });
  }

  setOpen(open: boolean): void {
    if (!open && this.destination !== "home" && this.context) {
      dismissPluginHelpAutoOpen(this.context);
    }
    if (open && this.destination === "home") {
      this.homeStarted = true;
    }
    this.persistTarget();
    this.dockLayout.setOpen(open);
    this.claimInput(open ? "dock" : "page");
    if (!open && typeof this.destination !== "string") {
      // Closing discards the activation-owned target without reopening a dock; the
      // operator's built-in Home/Ask choice and its persisted value stay untouched.
      this.destination = this.builtInDestination;
    }
    this.publishSessionKey();
  }

  get contentDefined() {
    return isOptionalElementDefined(ASSISTANT_CONTENT_ELEMENT);
  }
  acceptStore(store: CustodianSessionStore) {
    this.element.store = store;
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
}
