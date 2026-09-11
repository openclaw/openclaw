import { isSessionRouteId, routeIdFromPath, type RouteId } from "../app-route-paths.ts";
import {
  loadAssistantDestination,
  resolveAssistantHomeTarget,
  isAssistantDestinationSuppressed,
  type AssistantDestination,
} from "../components/assistant-panel-destination.ts";
import { desktopPanelLayout } from "../components/desktop/desktop-panel-layout.ts";
import {
  assistantPanelLayout,
  browserPanelLayout,
  terminalPanelLayout,
  prepareDockPanelLayout,
} from "../components/dock-panel-layout.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  HOME_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { rememberSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext } from "./context.ts";
import { initialSessionIdentity } from "./initial-session-identity.ts";
import {
  isOptionalElementDefined,
  type LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";
import { lazyShellEvent, type LazyShellEvent } from "./lazy-shell-action.ts";
import {
  isBrowserPanelSurfaceAvailable,
  isDesktopPanelAvailable,
  isHomePanelAvailable,
} from "./panel-availability.ts";

export interface ShellPanelHost {
  readonly context: ApplicationContext<RouteId> | undefined;
  readonly custodianMinimizeRequestId: number;
  readonly lazyCustomElements: LazyCustomElementRequestController;
  readonly terminalPanelElement: OptionalCustomElement;
  readonly browserPanelElement: OptionalCustomElement;
  readonly desktopPanelElement: OptionalCustomElement;
  readonly assistantPanelElement: OptionalCustomElement;
  routeState: ShellRouteState;
}

export class ShellPanelOwner {
  private savedAssistantDestination: AssistantDestination | undefined;
  private readonly restoredPanels = new Set<OptionalCustomElement>();
  private readonly prepared = new Map<
    OptionalCustomElement,
    ReturnType<typeof prepareDockPanelLayout>
  >();

  prepareReservations(): void {
    const host = this.host;
    const sessionRoute = this.isSessionRoute();
    for (const [element, store, prefix, visible] of [
      [host.terminalPanelElement, terminalPanelLayout, "terminal", true],
      [host.browserPanelElement, browserPanelLayout, "browser", !sessionRoute],
      [host.desktopPanelElement, desktopPanelLayout, "desktop", !sessionRoute],
      [host.assistantPanelElement, assistantPanelLayout, "assistant", true],
    ] as const) {
      let prepared = this.prepared.get(element);
      if (!prepared && !isOptionalElementDefined(element)) {
        prepared = prepareDockPanelLayout(store, prefix);
        this.prepared.set(element, prepared);
      }
      prepared?.synchronize(
        visible &&
          !(
            element === host.assistantPanelElement &&
            prepared.layout.open &&
            this.assistantSuppressed()
          ) &&
          !(
            element === host.terminalPanelElement &&
            sessionRoute &&
            prepared.layout.dock !== "bottom"
          ),
      );
    }
  }

  constructor(
    private readonly host: ShellPanelHost,
    private readonly requestLazyElement: (
      element: OptionalCustomElement,
      event: LazyShellEvent,
    ) => void,
  ) {}

  get assistantRestorationPending(): boolean {
    const element = this.host.assistantPanelElement;
    return this.restoredPanels.has(element) && this.host.lazyCustomElements.isPreloading(element);
  }

  releasePreparedReservations(): void {
    for (const prepared of this.prepared.values()) {
      prepared.release();
    }
    this.prepared.clear();
  }

  reset(): void {
    this.savedAssistantDestination = undefined;
    this.releasePreparedReservations();
    for (const element of this.restoredPanels) {
      this.host.lazyCustomElements.resetPreload(element);
    }
    this.restoredPanels.clear();
  }

  restore(): void {
    const host = this.host;
    const context = host.context;
    const gatewaySnapshot = context?.gateway?.snapshot;
    if (!gatewaySnapshot) {
      return;
    }
    const desktopAvailable = isDesktopPanelAvailable(gatewaySnapshot);
    // Scope-aware: openclaw.chat is operator.admin; advertisement alone would
    // show read-scoped clients a control the store then refuses to use.
    const custodianAvailable = canCallGatewayMethod(
      gatewaySnapshot,
      "openclaw.chat",
      "operator.admin",
    );
    // Only restored open docks load automatically. Explicit actions use the
    // shell's lazy request/replay owner; closed capabilities stay unloaded.
    const sessionRoute = isSessionRouteId(host.routeState.routeId);
    const terminalAvailable = isTerminalAvailable(
      gatewaySnapshot,
      context.config.current.terminalEnabled ?? false,
    );
    const browserAvailable = !sessionRoute && isBrowserPanelSurfaceAvailable(gatewaySnapshot);
    const assistantAvailable = custodianAvailable || isHomePanelAvailable(context.gateway);
    for (const [element, layout, available] of [
      [host.terminalPanelElement, terminalPanelLayout, terminalAvailable],
      [host.browserPanelElement, browserPanelLayout, browserAvailable],
      [host.desktopPanelElement, desktopPanelLayout, !sessionRoute && desktopAvailable],
      [host.assistantPanelElement, assistantPanelLayout, assistantAvailable],
    ] as const) {
      const prepared = this.prepared.get(element);
      if (!available) {
        if (gatewaySnapshot.phase === "connected") {
          prepared?.release();
        }
        continue;
      }
      if (
        this.restoredPanels.has(element) &&
        !host.lazyCustomElements.isPreloading(element) &&
        !isOptionalElementDefined(element)
      ) {
        prepared?.release();
      }
      const restored =
        !this.restoredPanels.has(element) && (prepared?.layout ?? layout.load()).open;
      // Consume the attempt even if its import fails: dismissing the error must
      // survive unrelated updates until the context or document lifecycle resets.
      this.restoredPanels.add(element);
      const minimized =
        element === host.assistantPanelElement && host.custodianMinimizeRequestId > 0;
      if (minimized || restored) {
        host.lazyCustomElements.preload(element, { reportError: true });
      }
    }
  }

  private assistantSuppressed(): boolean {
    const context = this.host.context;
    if (!context) {
      return false;
    }
    const destination = (this.savedAssistantDestination ??= loadAssistantDestination(
      context.gateway.connection.gatewayUrl,
    ));
    const pathname = this.host.routeState.location?.pathname ?? globalThis.location?.pathname ?? "";
    const routeId =
      this.host.routeState.routeId ?? routeIdFromPath(pathname, context.basePath) ?? "chat";
    const defaults = {
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    };
    const home = resolveAssistantHomeTarget(defaults, context.agentSelection.state.selectedId);
    const routeSession = initialSessionIdentity(
      this.host.routeState.location ?? globalThis.location,
      context,
    );
    return isAssistantDestinationSuppressed({
      destination,
      custodianSuppressed: routeId === "custodian",
      pageRouteId: routeId,
      pageSessionKey: this.host.routeState.committedSessionKey ?? routeSession.sessionKey,
      pageAgentId: routeSession.agentId ?? context.agentSelection.state.selectedId ?? "",
      defaults,
      home,
    });
  }

  private isSessionRoute(): boolean {
    const locationRouteId = routeIdFromPath(
      globalThis.location?.pathname ?? "",
      this.host.context?.basePath ?? "",
    );
    return isSessionRouteId(locationRouteId ?? this.host.routeState.routeId);
  }

  readonly handleDeferredTerminalToggle = (event: Event): void => {
    const host = this.host;
    if (this.isSessionRoute()) {
      rememberSessionPanelToggle("terminal", event);
      return;
    }
    if (isOptionalElementDefined(host.terminalPanelElement)) {
      return;
    }
    const context = host.context;
    const snapshot = context?.gateway?.snapshot;
    if (
      !snapshot ||
      !isTerminalAvailable(snapshot, context.config.current.terminalEnabled ?? false)
    ) {
      event.preventDefault();
      return;
    }
    this.requestLazyElement(
      host.terminalPanelElement,
      lazyShellEvent(TERMINAL_PANEL_TOGGLE_EVENT, event),
    );
  };

  readonly handleDeferredBrowserToggle = (event: Event): void => {
    const host = this.host;
    if (this.isSessionRoute()) {
      rememberSessionPanelToggle("browser", event);
      return;
    }
    if (isOptionalElementDefined(host.browserPanelElement)) {
      return;
    }
    const snapshot = host.context?.gateway?.snapshot;
    if (snapshot && isBrowserPanelSurfaceAvailable(snapshot)) {
      this.requestLazyElement(
        host.browserPanelElement,
        lazyShellEvent(BROWSER_PANEL_TOGGLE_EVENT, event),
      );
    } else {
      event.preventDefault();
    }
  };

  readonly handleDeferredDesktopToggle = (event: Event): void => {
    const host = this.host;
    if (this.isSessionRoute()) {
      rememberSessionPanelToggle("desktop", event);
      return;
    }
    const context = host.context;
    if (!context || !isDesktopPanelAvailable(context.gateway.snapshot)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (isOptionalElementDefined(host.desktopPanelElement)) {
      return;
    }
    this.requestLazyElement(
      host.desktopPanelElement,
      lazyShellEvent(DESKTOP_PANEL_TOGGLE_EVENT, event),
    );
  };

  readonly handleDeferredAssistantToggle = (event: Event): void => {
    const host = this.host;
    if (isOptionalElementDefined(host.assistantPanelElement)) {
      return;
    }
    const snapshot = host.context?.gateway?.snapshot;
    const home = event.type === HOME_PANEL_TOGGLE_EVENT;
    if (
      home
        ? isHomePanelAvailable(host.context?.gateway)
        : canCallGatewayMethod(snapshot, "openclaw.chat", "operator.admin")
    ) {
      this.requestLazyElement(
        host.assistantPanelElement,
        lazyShellEvent(home ? HOME_PANEL_TOGGLE_EVENT : CUSTODIAN_PANEL_TOGGLE_EVENT, event),
      );
    } else {
      event.preventDefault();
    }
  };
}
