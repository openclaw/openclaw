import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { isSettingsTakeover } from "../app-navigation.ts";
import { isSessionRouteId, type RouteId } from "../app-route-paths.ts";
import type { AssistantDockOwner } from "../app/assistant-dock.ts";
import { chatInputOwnerForContext } from "../app/chat-input-owner.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createLazyCustomElementRequests,
  isOptionalElementDefined,
} from "../app/lazy-custom-element.ts";
import { listSelectableAgents } from "../lib/agents/display.ts";
import { t } from "../lib/reactive/i18n.ts";
import { listen } from "../lib/reactive/listener.ts";
import {
  prepareSessionNavigationHandoff,
  runSessionNavigationIntent,
} from "../lib/sessions/navigation-handoff.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  resolveUiConfiguredMainKey,
  resolveUiConversationIdentity,
  resolveUiDefaultAgentId,
} from "../lib/sessions/session-key.ts";
import type { SolidBridgeElement } from "../lib/solid-bridge.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import {
  CHAT_ROUTE_READY_EVENT,
  CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
} from "../pages/chat/chat-history-events.ts";
import type { ChatPaneElement } from "../pages/chat/chat-pane-elements.ts";
import type { CustodianSessionStore } from "../pages/custodian/custodian-session-store.ts";
import {
  consumePluginHelpAutoOpen,
  dismissPluginHelpAutoOpen,
  subscribePluginHelp,
} from "../pages/custodian/plugin-help-state.ts";
import { createDockLayout } from "./dock-layout.ts";
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
  getPrimaryChatPane?: (sessionKey: string) => ChatPaneElement | undefined;
  pageAgentId: string;
  pageRouteId: RouteId;
  pageRouteFailed: boolean;
  minimizeRequestId: number;
  store?: CustodianSessionStore;
};
export function createAssistantPanel(
  element: SolidBridgeElement<AssistantPanelProps>,
  scheduleAfterRender: (callback: () => void | (() => void)) => void,
) {
  const props = element;
  let application: ApplicationContext | undefined;
  let mounted = false;
  let initialized = false;
  let pendingRefresh: (() => void) | undefined;
  let stops: (() => void)[] = [];
  let sourceStops: ((() => void) | undefined)[] = [];
  let sources:
    | { context: ApplicationContext | undefined; store: CustodianSessionStore | undefined }
    | undefined;
  // Navigation and plugin actions read their own writes before Solid commits.
  let homeStarted = false;
  let destination: AssistantDestination = "custodian";
  let builtInDestination: "home" | "custodian" = "custodian";
  let pendingPrimaryPane: { pane: ChatPaneElement } | null = null;
  let publishedSessionKey: string | null = null;
  let handledMinimizeRequestId = 0;
  let targetScope = "";
  let refreshing = false;
  let homeDefaults: {
    agentsList?: ApplicationContext["agents"]["state"]["agentsList"];
    hello?: ApplicationContext["gateway"]["snapshot"]["hello"];
  } = {};
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const getContext = () => props.context ?? application;
  const contentLoader = createLazyCustomElementRequests(element);
  const dockLayout = createDockLayout({
    layout: assistantPanelLayout,
    reservationPrefix: "assistant",
    isAvailable: available,
    notify,
  });
  function refresh(): void {
    if (refreshing) {
      return;
    }
    refreshing = true;
    try {
      const wasOpen = dockLayout.open;
      const scope = getContext()?.gateway.connection.gatewayUrl ?? "";
      if (scope !== targetScope) {
        targetScope = scope;
        homeStarted = false;
        pendingPrimaryPane = null;
        homeDefaults = {};
        let saved: Record<string, unknown> | null = null;
        try {
          saved = asNullableRecord(
            JSON.parse(getSafeLocalStorage()?.getItem(targetStorageKey()) ?? "null"),
          );
        } catch {
          // Missing or invalid saved presentation preferences use the default destination.
        }
        destination = saved?.destination === "home" ? "home" : "custodian";
        builtInDestination = destination;
      }
      const context = getContext();
      if (sources?.context !== context) {
        pendingPrimaryPane = null;
      }
      if (context?.gateway.snapshot.phase === "connected") {
        // Roster/hello disappear during reconnect; keep the captured Home identity with its outbox.
        homeDefaults = {
          agentsList: context.agents.state.agentsList ?? homeDefaults.agentsList,
          hello: context.gateway.snapshot.hello,
        };
      }
      dockLayout.setSuppressed(restoreSuppressed());
      if (
        props.minimizeRequestId > 0 &&
        props.minimizeRequestId !== handledMinimizeRequestId &&
        props.custodianAvailable &&
        props.store
      ) {
        handledMinimizeRequestId = props.minimizeRequestId;
        if (typeof destination === "string" && props.store.hasRealUserTurn()) {
          openDestination("custodian");
        }
      }
      if (!available()) {
        dockLayout.hideWithoutPersisting();
      } else {
        dockLayout.restoreOpenState();
      }
      if (wasOpen && !dockLayout.open) {
        claimInput("page");
      }
      if (
        typeof destination === "string" &&
        context &&
        props.custodianAvailable &&
        !props.custodianSuppressed &&
        window.innerWidth > 1100 &&
        consumePluginHelpAutoOpen(context)
      ) {
        openDestination("custodian");
      }
      startHomeAfterPrimaryChat();
      contentLoader.requestWhileActive(
        ASSISTANT_CONTENT_ELEMENT,
        (dockLayout.open && (destination !== "home" || homeStarted)) ||
          (props.custodianAvailable && props.minimizeRequestId > handledMinimizeRequestId),
      );
      dockLayout.syncReservation();
      if (mounted) {
        subscribeSources();
      }
      publishSessionKey();
    } finally {
      refreshing = false;
    }
    notify();
  }

  function subscribeSources(): void {
    const context = getContext();
    const store = props.store;
    if (sources && sources.context === context && sources.store === store) {
      return;
    }
    sourceStops.forEach((stop) => stop?.());
    sources = { context, store };
    sourceStops = [
      context?.assistantDock?.attach(owner),
      context ? subscribePluginHelp(context, refresh) : undefined,
      ...[store, context?.agentSelection, context?.agents, context?.theme, context?.gateway].map(
        (source) => source?.subscribe(refresh),
      ),
    ];
  }

  function inputsChanged(): void {
    if (!mounted || pendingRefresh) {
      return;
    }
    const pending = () => {
      if (pendingRefresh !== pending) {
        return;
      }
      pendingRefresh = undefined;
      refresh();
    };
    pendingRefresh = pending;
    scheduleAfterRender(pending);
  }

  function attach(nextApplication?: ApplicationContext): void {
    application = nextApplication;
    scheduleAfterRender(() => {
      // Restore geometry before route suppression; remounts retain explicit dock intent.
      const open = dockLayout.open;
      dockLayout.connect();
      if (initialized) {
        dockLayout.setOpen(open, false);
      }
      initialized = mounted = true;
      stops = [
        contentLoader.subscribe(notify),
        listen(document, CHAT_ROUTE_READY_EVENT, refresh),
        listen(document, CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT, refresh),
        listen(window, CUSTODIAN_PANEL_TOGGLE_EVENT, handleToggleRequest),
        listen(window, HOME_PANEL_TOGGLE_EVENT, handleToggleRequest),
      ];
      refresh();
      return detach;
    });
  }

  function detach(): void {
    mounted = false;
    pendingRefresh = undefined;
    pendingPrimaryPane = null;
    sourceStops.forEach((stop) => stop?.());
    sourceStops = [];
    sources = undefined;
    stops.forEach((stop) => stop());
    stops = [];
    dockLayout.dispose();
    // A context-only remount retains activation-owned targets and input custody.
    if (!element.isConnected) {
      if (typeof destination !== "string") {
        closeSession();
      }
      claimInput("page");
    }
  }

  function startHomeAfterPrimaryChat(): void {
    if (homeStarted || !dockLayout.open || destination !== "home") {
      return;
    }
    if (props.pageRouteId !== "chat" || props.pageRouteFailed) {
      homeStarted = true;
      return;
    }
    const pane = props.getPrimaryChatPane?.(props.pageSessionKey);
    if (!pane?.transcriptReady || pendingPrimaryPane?.pane === pane) {
      return;
    }
    const pending = { pane };
    pendingPrimaryPane = pending;
    const currentContext = getContext();
    // The loading edge precedes the pane's render invalidation. Wait for that
    // commit before a restored Home starts its competing transcript request.
    void Promise.resolve()
      .then(() => pane.updateComplete)
      .then(() => {
        if (pendingPrimaryPane !== pending) {
          return;
        }
        pendingPrimaryPane = null;
        if (
          element.isConnected &&
          getContext() === currentContext &&
          props.getPrimaryChatPane?.(props.pageSessionKey) === pane &&
          pane.transcriptReady
        ) {
          homeStarted = true;
          refresh();
        }
      });
  }

  function targetStorageKey(): string {
    return `openclaw.assistant.panel.target.v1:${targetScope}`;
  }

  function persistTarget(): void {
    // Plugin targets belong to their activation, never to browser persistence.
    if (typeof destination !== "string") {
      return;
    }
    try {
      getSafeLocalStorage()?.setItem(targetStorageKey(), JSON.stringify({ destination }));
    } catch {
      // Storage can be unavailable; the current panel selection still takes effect.
    }
  }

  function homeTarget() {
    const defaults = homeDefaults;
    const agents = listSelectableAgents(defaults.agentsList?.agents ?? []);
    const defaultId = resolveUiDefaultAgentId(defaults);
    // The sidebar switcher (agentSelection) is the only agent chooser; the dock
    // shows the selected agent's Home and never grows a second switcher.
    const rawSelectedId = getContext()?.agentSelection.state.selectedId;
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

  function availableFor(target: AssistantDestination): boolean {
    // The chat pane owns access errors and read-only composition. Always show
    // explicitly requested sessions so a denied read has its normal visible outcome.
    return (
      typeof target !== "string" ||
      (target === "home" ? props.homeAvailable : props.custodianAvailable)
    );
  }

  function available(): boolean {
    return availableFor(destination);
  }

  function suppressed(): boolean {
    if (destination === "custodian") {
      return props.custodianSuppressed;
    }
    const context = getContext();
    const sessionPage =
      destination === "home" ? props.pageRouteId === "chat" : isSessionRouteId(props.pageRouteId);
    if (!context || !sessionPage) {
      return false;
    }
    const page = resolveUiConversationIdentity(
      homeDefaults,
      props.pageSessionKey,
      props.pageAgentId,
    );
    const target =
      typeof destination === "string"
        ? homeTarget()
        : resolveUiConversationIdentity(
            homeDefaults,
            destination.params.sessionKey,
            destination.params.agentId,
          );
    return (
      page.sessionKey === target.sessionKey &&
      normalizeAgentId(page.agentId) === normalizeAgentId(target.agentId)
    );
  }

  function claimInput(region: "page" | "dock"): void {
    const context = getContext();
    if (context) {
      chatInputOwnerForContext(context).claim(region);
    }
  }

  function restoreSuppressed(): boolean {
    // Home follows the visible Settings context; automatic diagnostic restores yield to it.
    return suppressed() || (destination === "custodian" && isSettingsTakeover(props.pageRouteId));
  }

  function openSession(
    params: Parameters<AssistantDockOwner["openSession"]>[0],
    activation: object,
  ): void {
    if (typeof destination === "string") {
      builtInDestination = destination;
    }
    openDestination({ params: structuredClone(params), activation });
  }

  function closeSession(activation?: object): void {
    if (activation && (typeof destination === "string" || destination.activation !== activation)) {
      return;
    }
    setOpen(false);
  }

  function openSessionKey(): string | null {
    return dockLayout.open && !suppressed() && typeof destination !== "string"
      ? destination.params.sessionKey
      : null;
  }

  function publishSessionKey(): void {
    const key = openSessionKey();
    if (key !== publishedSessionKey) {
      publishedSessionKey = key;
      getContext()?.assistantDock?.notify();
    }
  }

  function openDestination(nextDestination: AssistantDestination): void {
    destination = nextDestination;
    dockLayout.setSuppressed(restoreSuppressed());
    if (available()) {
      // Keep explicit open intent even when the same Home conversation owns the page.
      setOpen(true);
      if (suppressed()) {
        dockLayout.hideWithoutPersisting();
        claimInput("page");
        if (destination === "home") {
          openHomePage();
        }
      }
    }
    publishSessionKey();
    refresh();
  }

  function openHomePage(): void {
    const context = getContext();
    if (!context) {
      return;
    }
    const { sessionKey, agentId } = homeTarget();
    const { pageRouteId, pageSessionKey } = props;
    const { client, hello } = context.gateway.snapshot;
    const target = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey,
      agentId,
      focusComposer: true,
    });
    // Full-page Home is explicit selection, even when its URL already owns an unbound split.
    runSessionNavigationIntent(element, {
      face: "chat",
      sessionKey,
      agentId,
      commit: () => {
        if (
          getContext() !== context ||
          props.pageRouteId !== pageRouteId ||
          props.pageSessionKey !== pageSessionKey ||
          context.gateway.snapshot.client !== client ||
          context.gateway.snapshot.hello !== hello ||
          homeTarget().sessionKey !== sessionKey ||
          homeTarget().agentId !== agentId
        ) {
          return false;
        }
        prepareSessionNavigationHandoff(context.gateway, target.options.pathname, sessionKey);
        context.navigate("chat", target.options);
        return true;
      },
    });
  }

  function setOpen(open: boolean): void {
    const context = getContext();
    if (!open && destination !== "home" && context) {
      dismissPluginHelpAutoOpen(context);
    }
    if (open && destination === "home") {
      homeStarted = true;
    }
    persistTarget();
    dockLayout.setOpen(open);
    claimInput(open ? "dock" : "page");
    if (!open && typeof destination !== "string") {
      // Closing discards the activation-owned target without reopening a dock; the
      // operator's built-in Home/Ask choice and its persisted value stay untouched.
      destination = builtInDestination;
    }
    publishSessionKey();
    refresh();
  }

  function contentDefined() {
    return isOptionalElementDefined(ASSISTANT_CONTENT_ELEMENT);
  }
  function acceptStore(store: CustodianSessionStore) {
    element.store = store;
  }

  function toggle(): void {
    if (!available()) {
      return;
    }
    if (suppressed()) {
      if (destination === "home") {
        openHomePage();
      }
      return;
    }
    setOpen(!dockLayout.open);
  }

  function handleToggleRequest(event: Event): void {
    const requestedDestination = event.type === HOME_PANEL_TOGGLE_EVENT ? "home" : "custodian";
    if (!availableFor(requestedDestination)) {
      return;
    }
    const detail = asNullableRecord(event instanceof CustomEvent ? event.detail : null);
    const dock = detail?.dock;
    if (dock === "right" || dock === "bottom") {
      dockLayout.setDock(dock, false);
    }
    if (detail?.open === false) {
      if (destination === requestedDestination) {
        setOpen(false);
      }
    } else if (destination !== requestedDestination || detail?.open === true) {
      openDestination(requestedDestination);
    } else {
      toggle();
    }
  }

  const owner = {
    props,
    context: getContext,
    destination: () => destination,
    homeStarted: () => homeStarted,
    homeTarget,
    available,
    contentDefined,
    get openSessionKey() {
      return openSessionKey();
    },
    contentLoader,
    dockLayout,
    availableFor,
    claimInput,
    openSession,
    closeSession,
    openDestination,
    openHomePage,
    setOpen,
    toggle,
    handleToggleRequest,
    acceptStore,
    refresh,
    notify,
    attach,
    detach,
    inputsChanged,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return owner;
}

export type AssistantPanelOwner = ReturnType<typeof createAssistantPanel>;
