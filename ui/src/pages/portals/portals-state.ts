import type {
  EnvironmentSummary,
  PortalCloseResult,
  PortalListResult,
  PortalSummary,
  UiPortalPresentation,
} from "@openclaw/gateway-protocol";
import { onCleanup } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { isLoopbackHostname } from "../../lib/gateway-locality.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { probePortalReachable, type PortalReachability } from "./portal-reachability.ts";

export type PortalsPresentation = {
  embedded: boolean;
  presented: boolean;
  requestedPortalId: string | null;
  requestedEnvironmentId: string | null;
};
type PortalProbeState = {
  key: string;
  status: "probing" | "ingress-required" | "new-tab-required" | PortalReachability;
};

export function createPortals(
  context: ApplicationContext,
  presentation: () => PortalsPresentation,
) {
  let active = true;
  let presentationPending = false;
  let presentationLifetime = Promise.withResolvers<void>();
  let listLifetime = Promise.withResolvers<void>();
  let presentationEpoch = 0;
  function retirePresentation() {
    presentationLifetime.resolve();
    presentationLifetime = Promise.withResolvers<void>();
    presentationEpoch += 1;
  }
  const snapshotPresentation = (): PortalsPresentation => {
    const current = presentation();
    return {
      embedded: current.embedded,
      presented: current.presented,
      requestedPortalId: current.requestedPortalId,
      requestedEnvironmentId: current.requestedEnvironmentId,
    };
  };
  let previousPresentation = snapshotPresentation();
  // Selection and pending facts are synchronous admission state; Solid only projects them.
  const state: {
    portals: PortalSummary[];
    selectedPortalId: string | null;
    loading: boolean;
    loaded: boolean;
    previewEpoch: number;
    listReady: boolean;
    listRead: { result: Promise<void> };
    error: string | null;
    closingPortalId: string | null;
    portalProbeState: PortalProbeState | null;
    pendingEnvironment: EnvironmentSummary | null;
    environmentFailure: { environmentId: string; message: string } | null;
    connected: boolean;
    pendingEnvironmentId: string | null;
    portalListSupported: boolean;
    canReadPortalState: boolean;
    canClosePortal: boolean;
  } = {
    portals: [],
    selectedPortalId: null,
    loading: false,
    loaded: false,
    previewEpoch: 1,
    listReady: false,
    listRead: { result: Promise.resolve() },
    error: null,
    closingPortalId: null,
    portalProbeState: null,
    pendingEnvironment: null,
    environmentFailure: null,
    get connected() {
      return context.gateway.snapshot.phase === "connected";
    },
    get pendingEnvironmentId() {
      return presentation().requestedPortalId ? null : presentation().requestedEnvironmentId;
    },
    get portalListSupported() {
      return isGatewayMethodAdvertised(context.gateway.snapshot ?? {}, "portal.list") !== false;
    },
    get canReadPortalState() {
      return canCallGatewayMethod(
        context.gateway.snapshot,
        state.pendingEnvironmentId ? "environments.status" : "portal.list",
        "operator.read",
        { requireAdvertisement: false },
      );
    },
    get canClosePortal() {
      return canCallGatewayMethod(context.gateway.snapshot, "portal.close", "operator.write");
    },
  };
  let presentationRequest: { requestId: string; portalId?: string } | null = null;
  let environmentLoading = false;
  let environmentTimer: ReturnType<typeof setInterval> | undefined;
  let publish = () => {};
  const portalProbeCache = new Map<string, PortalReachability>();
  const lifecycle = createGatewayConnectionLifecycle(context.gateway.snapshot);
  let client = context.gateway.snapshot.client;
  let presentationScope = gatewayPresentationScope(context.gateway);
  const projection = projectMutableSource(state, (value) => value);
  publish = projection.publish;
  // Connection receipts retire portal requests, probes, and presentation acknowledgements before reconnect.
  const stopGateway = context.gateway.subscribe((value) => {
    const nextPresentationScope = gatewayPresentationScope(context.gateway);
    const identityChanged = client !== value.client || presentationScope !== nextPresentationScope;
    client = value.client;
    presentationScope = nextPresentationScope;
    const changed = lifecycle.transition(value);
    if (
      identityChanged ||
      (value.phase === "connected" && (!state.canReadPortalState || !state.portalListSupported))
    ) {
      if (!changed) {
        lifecycle.invalidate();
      }
      resetGatewayState();
    } else if (changed) {
      retireGatewayRequests();
    }
    if ((changed || identityChanged) && value.phase === "connected") {
      void loadPresentation();
    }
    notify();
  });
  const stopEvents = context.gateway.subscribeEvents((event) => {
    if (state.connected && event.event === "portal.changed") {
      void loadPresentation();
    }
  });
  onCleanup(() => {
    active = false;
    stopGateway();
    stopEvents();
    lifecycle.dispose();
    resetGatewayState();
  });
  if (state.connected) {
    void loadPresentation();
  }
  function pollEnvironment(enabled: boolean) {
    if (!enabled) {
      clearInterval(environmentTimer);
      environmentTimer = undefined;
    } else if (environmentTimer === undefined) {
      environmentTimer = setInterval(() => void loadPendingEnvironment(), 2_000);
    }
  }

  function notify() {
    // Consume presentation receipts synchronously, before rendering observes the transition.
    reportPresentation();
    publish();
  }

  function reportPresentation() {
    const request = presentationRequest;
    if (!request || !state.connected || !presentation().presented) {
      return;
    }
    const portalId = request.portalId ?? state.selectedPortalId ?? undefined;
    let outcome: Pick<UiPortalPresentation, "status" | "reason"> | undefined;
    if (!state.canReadPortalState) {
      outcome = { status: "blocked", reason: "access-required" };
    } else if (state.pendingEnvironmentId && !request.portalId) {
      outcome = { status: "unverified", reason: "waiting-for-app" };
    } else if (
      !state.loaded ||
      state.loading ||
      (request.portalId && presentation().requestedPortalId !== request.portalId)
    ) {
      return;
    } else {
      const portal = state.portals.find((entry) => entry.id === portalId);
      if (!portal || state.error) {
        outcome = { status: "blocked", reason: "portal-unavailable" };
      } else if (!portal.url || !portal.tokenQuery) {
        outcome = { status: "blocked", reason: "access-required" };
      } else if (state.portalProbeState?.key === `${portal.id}\u0000${portal.url}`) {
        switch (state.portalProbeState.status) {
          case "probing":
            return;
          case "ingress-required":
            outcome = { status: "blocked", reason: "remote-ingress-required" };
            break;
          case "new-tab-required":
            outcome = { status: "new-tab-required", reason: "new-tab-required" };
            break;
          case "unreachable":
            outcome = { status: "blocked", reason: "network-unreachable" };
            break;
          // An opaque fetch can reach a proxy waiting/error page. Neither this
          // nor iframe load proves the application rendered or is usable.
          case "reachable":
            outcome = { status: "unverified", reason: "network-reachable" };
            break;
          case "blocked":
            outcome = { status: "unverified", reason: "probe-blocked" };
            break;
        }
      }
    }
    if (!outcome) {
      return;
    }
    presentationRequest = null;
    void context.gateway.snapshot.client
      ?.request("ui.command.result", {
        requestId: request.requestId,
        presentation: { ...(portalId ? { portalId } : {}), ...outcome },
      })
      .catch(() => {
        // Disconnects or expired requests leave the caller unverified; never
        // replay an old browser observation onto a replacement connection.
      });
  }

  function loadPresentation(): Promise<void> {
    return state.pendingEnvironmentId ? loadPendingEnvironment() : loadPortals();
  }

  async function loadPendingEnvironment(): Promise<void> {
    const environmentId = state.pendingEnvironmentId;
    const scope = lifecycle.capture();
    if (
      !environmentId ||
      !scope ||
      !state.canReadPortalState ||
      environmentLoading ||
      (presentation().embedded && !presentation().presented)
    ) {
      return;
    }
    const isCurrent = () =>
      lifecycle.isCurrent(scope) && state.pendingEnvironmentId === environmentId;
    environmentLoading = true;
    state.environmentFailure = null;
    notify();
    try {
      const environment = await scope.client.request<EnvironmentSummary>("environments.status", {
        environmentId,
      });
      if (!isCurrent()) {
        return;
      }
      if (environment.id !== environmentId) {
        throw new Error("Environment status returned a different target");
      }
      state.pendingEnvironment = environment;
      pollEnvironment(environment.status === "starting");
    } catch (error) {
      if (isCurrent()) {
        state.environmentFailure = { environmentId, message: formatUiError(error) };
        pollEnvironment(false);
      }
    } finally {
      if (isCurrent()) {
        environmentLoading = false;
      }
      notify();
    }
  }

  function resetPendingEnvironment() {
    environmentLoading = false;
    state.pendingEnvironment = null;
    state.environmentFailure = null;
    pollEnvironment(false);
  }

  function resetGatewayState() {
    retireGatewayRequests();
    resetPendingEnvironment();
    state.previewEpoch += 1;
    state.portals = [];
    state.selectedPortalId = null;
    state.loaded = false;
    state.listReady = false;
    state.error = null;
    portalProbeCache.clear();
    state.portalProbeState = null;
  }

  function retireGatewayRequests() {
    retirePresentation();
    listLifetime.resolve();
    listLifetime = Promise.withResolvers<void>();
    state.listRead = { result: Promise.resolve() };
    presentationRequest = null;
    environmentLoading = false;
    pollEnvironment(false);
    state.loading = false;
    state.closingPortalId = null;
    if (state.portalProbeState?.status === "probing") {
      state.portalProbeState = null;
    }
  }

  function applyPortalSet(portals: readonly PortalSummary[]) {
    state.portals = [...portals];
    const previousPortalId = state.selectedPortalId;
    const selectedPortalId = state.pendingEnvironmentId
      ? null
      : (presentation().requestedPortalId ??
        (portals.some((portal) => portal.id === previousPortalId)
          ? state.selectedPortalId
          : (portals[0]?.id ?? null)));
    state.selectedPortalId = selectedPortalId;
    state.loaded = true;
    state.error = null;
    const selectedPortal = portals.find((portal) => portal.id === selectedPortalId);
    if (selectedPortal) {
      ensurePortalProbe(selectedPortal, selectedPortalId !== previousPortalId);
    } else {
      state.portalProbeState = null;
    }
    notify();
  }

  function ensurePortalProbe(portal: PortalSummary, force = false) {
    if (!portal.tokenQuery || !portal.url) {
      state.portalProbeState = null;
      notify();
      return;
    }
    const url = portal.url;
    const key = `${portal.id}\u0000${url}`;
    if (!force && state.portalProbeState?.key === key) {
      notify();
      return;
    }
    const portalAddress = new URL(url);
    // A remote Gateway's loopback endpoint points at the browser, not the Gateway.
    if (
      isLoopbackHostname(portalAddress.hostname) &&
      !isLoopbackHostname(new URL(context.gateway.connection.gatewayUrl).hostname)
    ) {
      state.portalProbeState = { key, status: "ingress-required" };
      notify();
      return;
    }
    const controlUiAddress = new URL(location.href);
    // Without secure partitioned cookies, HTTP previews need the same scheme and host.
    if (
      portalAddress.protocol === "http:" &&
      (controlUiAddress.protocol !== portalAddress.protocol ||
        controlUiAddress.hostname !== portalAddress.hostname)
    ) {
      state.portalProbeState = { key, status: "new-tab-required" };
      notify();
      return;
    }
    const cached = force ? undefined : portalProbeCache.get(key);
    if (cached !== undefined) {
      state.portalProbeState = { key, status: cached };
      notify();
      return;
    }

    const scope = lifecycle.capture();
    if (!scope) {
      return;
    }
    state.portalProbeState = { key, status: "probing" };
    notify();
    void probePortalReachable(url).then((reachability) => {
      if (lifecycle.isCurrent(scope) && state.portalProbeState?.key === key) {
        portalProbeCache.set(key, reachability);
        state.portalProbeState = { key, status: reachability };
        notify();
      }
    });
  }

  function loadPortals(): Promise<void> {
    if (
      state.pendingEnvironmentId ||
      !state.canReadPortalState ||
      !state.portalListSupported ||
      state.loading ||
      (presentation().embedded && !presentation().presented)
    ) {
      return Promise.resolve();
    }
    const scope = lifecycle.capture();
    if (!scope) {
      return Promise.resolve();
    }
    const isCurrent = () => lifecycle.isCurrent(scope);
    state.loading = true;
    state.error = null;
    const pending = (async () => {
      try {
        const result = await scope.client.request<PortalListResult>("portal.list", {});
        if (isCurrent()) {
          state.listReady = true;
          applyPortalSet(result.portals);
        }
      } catch (error) {
        if (isCurrent() && state.portalListSupported) {
          state.error = t("portalsPage.loadFailed", { error: formatUiError(error) });
          state.loaded = true;
        }
      } finally {
        if (isCurrent()) {
          state.loading = false;
        }
        notify();
      }
    })();
    // Hidden panels keep their admitted read; only Gateway retirement releases its readiness.
    state.listRead = { result: Promise.race([pending, listLifetime.promise]) };
    notify();
    return pending;
  }

  return {
    state: projection.read,
    get presentationEpoch() {
      return presentationEpoch;
    },
    get retired() {
      return presentationLifetime.promise;
    },
    presentation: () => {
      projection.revision();
      return presentation();
    },
    observePresentation(requestId: string, portalId?: string) {
      presentationRequest = { requestId, portalId };
      // Report this view's diagnosis without re-probing and discarding its live
      // iframe document. The explicit Retry action owns a fresh network check.
      reportPresentation();
    },
    presentationChanged() {
      const incoming = snapshotPresentation();
      if (
        incoming.requestedPortalId !== previousPresentation.requestedPortalId ||
        incoming.requestedEnvironmentId !== previousPresentation.requestedEnvironmentId ||
        (!incoming.presented && previousPresentation.presented)
      ) {
        // Native target/visibility intent releases actions before Solid commits the new view.
        retirePresentation();
      }
      if (presentationPending) {
        return;
      }
      presentationPending = true;
      // Paired native target writes must load and report only the final presentation.
      queueMicrotask(() => {
        presentationPending = false;
        if (!active) {
          return;
        }
        const previous = previousPresentation;
        const current = (previousPresentation = snapshotPresentation());
        const targetChanged =
          previous.requestedPortalId !== current.requestedPortalId ||
          previous.requestedEnvironmentId !== current.requestedEnvironmentId;
        if (targetChanged) {
          resetPendingEnvironment();
          state.loading = false;
          state.portalProbeState = null;
          applyPortalSet(state.portals);
          void loadPresentation();
        } else if (current.presented && !previous.presented) {
          void loadPresentation();
        } else if (!current.presented) {
          pollEnvironment(false);
          environmentLoading = false;
        }
        notify();
      });
    },
    selectPortal(portal: PortalSummary) {
      if (portal.id === state.selectedPortalId) {
        return;
      }
      state.selectedPortalId = portal.id;
      ensurePortalProbe(portal, true);
    },
    async closePortal(portal: PortalSummary) {
      if (!state.canClosePortal || state.closingPortalId) {
        return;
      }
      const scope = lifecycle.capture();
      if (!scope) {
        return;
      }
      state.closingPortalId = portal.id;
      state.error = null;
      notify();
      const current = () => lifecycle.isCurrent(scope) && state.closingPortalId === portal.id;
      try {
        await scope.client.request<PortalCloseResult>("portal.close", { id: portal.id });
        if (current()) {
          void loadPortals();
        }
      } catch (error) {
        if (current()) {
          state.error = t("portalsPage.closeFailed", { error: formatUiError(error) });
        }
      } finally {
        if (current()) {
          state.closingPortalId = null;
        }
        notify();
      }
    },
    loadPresentation,
    loadPendingEnvironment,
    ensurePortalProbe,
  };
}

export type PortalsModel = ReturnType<typeof createPortals>;
