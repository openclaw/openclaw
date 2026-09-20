import { isSettingsTakeover } from "../app-navigation.ts";
import { isSessionRouteId, routeIdFromPath } from "../app-route-paths.ts";
import { desktopPanelLayout } from "../components/desktop/desktop-panel-layout.ts";
import { browserPanelLayout, terminalPanelLayout } from "../components/dock-panel-layout.ts";
import { resolveLinkReaderTarget } from "../components/link-reader-target.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { rememberSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import type { ApplicationContext } from "./context.ts";
import {
  isOptionalElementDefined,
  type LazyCustomElementRequestController,
  type OptionalCustomElement,
} from "./lazy-custom-element.ts";
import { lazyShellEvent, type LazyShellEvent } from "./lazy-shell-action.ts";
import { availableLinkReaders } from "./link-reader-routing.ts";
import { isNativeEmbedHost } from "./native-web-chrome.ts";
import { isBrowserPanelSurfaceAvailable, isDesktopPanelAvailable } from "./panel-availability.ts";

export interface ShellPanelHost {
  readonly context: ApplicationContext | undefined;
  readonly lazyCustomElements: LazyCustomElementRequestController;
  readonly terminalPanelElement: OptionalCustomElement;
  readonly browserPanelElement: OptionalCustomElement;
  readonly desktopPanelElement: OptionalCustomElement;
  readonly linkReaderPanelElement: OptionalCustomElement;
  routeState: ShellRouteState;
}

export class ShellPanelOwner {
  private readonly restoredPanels = new Set<OptionalCustomElement>();

  constructor(
    private readonly host: ShellPanelHost,
    private readonly requestLazyElement: (
      element: OptionalCustomElement,
      event: LazyShellEvent,
    ) => void,
  ) {}

  reset(): void {
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
    // Only restored open docks load automatically. Explicit actions use the
    // shell's lazy request/replay owner; closed capabilities stay unloaded.
    const sessionRoute = isSessionRouteId(host.routeState.routeId);
    const terminalAvailable = isTerminalAvailable(
      gatewaySnapshot,
      context.config.current.terminalEnabled ?? false,
    );
    const browserAvailable = !sessionRoute && isBrowserPanelSurfaceAvailable(gatewaySnapshot);
    for (const [element, layout, available] of [
      [host.terminalPanelElement, terminalPanelLayout, terminalAvailable],
      [host.browserPanelElement, browserPanelLayout, browserAvailable],
      [
        host.desktopPanelElement,
        desktopPanelLayout,
        !sessionRoute && host.routeState.routeId !== "systems" && desktopAvailable,
      ],
    ] as const) {
      if (!available) {
        continue;
      }
      const restored = !this.restoredPanels.has(element) && layout.load().open;
      // Consume the attempt even if its import fails: dismissing the error must
      // survive unrelated updates until the context or document lifecycle resets.
      this.restoredPanels.add(element);
      if (restored) {
        host.lazyCustomElements.preload(element, { reportError: true });
      }
    }
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

  readonly handleDeferredLinkReaderToggle = (event: Event): void => {
    const host = this.host;
    const snapshot = host.context?.gateway.snapshot;
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!snapshot || isSettingsTakeover(host.routeState.routeId) || isNativeEmbedHost()) {
      return;
    }
    const readers = availableLinkReaders(snapshot);
    if (
      detail?.open !== false &&
      (!readers.length ||
        (detail?.url !== undefined && !resolveLinkReaderTarget(detail.url, readers)))
    ) {
      return;
    }
    if (this.isSessionRoute()) {
      rememberSessionPanelToggle("link-reader", event);
      event.preventDefault();
      return;
    }
    if (isOptionalElementDefined(host.linkReaderPanelElement)) {
      return;
    }
    // Acceptance belongs to the shell until the lazy panel can consume the replay.
    event.preventDefault();
    this.requestLazyElement(
      host.linkReaderPanelElement,
      lazyShellEvent(LINK_READER_PANEL_TOGGLE_EVENT, event),
    );
  };

  readonly handleDeferredDesktopToggle = (event: Event): void => {
    const host = this.host;
    // Systems owns its embedded viewer; never materialize a second shell dock.
    if (host.routeState.routeId === "systems") {
      return;
    }
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
}
