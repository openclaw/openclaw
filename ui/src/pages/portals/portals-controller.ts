import type {
  EnvironmentSummary,
  PortalCloseResult,
  PortalListResult,
  PortalSummary,
} from "@openclaw/gateway-protocol";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { probePortalReachable, type PortalReachability } from "./portal-reachability.ts";
import { portalNeedsNewTab, portalNeedsRemoteIngress } from "./portal-url.ts";

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

export class PortalsController {
  portals: PortalSummary[] = [];
  selectedPortalId: string | null = null;
  loading = false;
  loaded = false;
  error: string | null = null;
  closingPortalId: string | null = null;
  portalProbeState: PortalProbeState | null = null;
  pendingEnvironment: EnvironmentSummary | null = null;
  environmentFailure: { environmentId: string; message: string } | null = null;
  private environmentLoading = false;
  private readonly portalProbeCache = new Map<string, PortalReachability>();
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle;
  private readonly unsubscribers: Array<() => void>;
  private environmentTimer: ReturnType<typeof setInterval> | undefined;
  private pollEnvironment(enabled: boolean) {
    if (!enabled) {
      clearInterval(this.environmentTimer);
      this.environmentTimer = undefined;
    } else if (this.environmentTimer === undefined) {
      this.environmentTimer = setInterval(() => void this.loadPendingEnvironment(), 2_000);
    }
  }
  get connected() {
    return this.context.gateway.snapshot.phase === "connected";
  }

  constructor(
    readonly context: ApplicationContext,
    readonly presentation: () => PortalsPresentation,
  ) {
    this.lifecycle = createGatewayConnectionLifecycle(context.gateway.snapshot);
    this.unsubscribers = [
      context.gateway.subscribe((snapshot) => {
        if (this.lifecycle.transition(snapshot)) {
          this.resetGatewayState();
          if (snapshot.phase === "connected") {
            void this.loadPresentation();
          }
        }
        this.notify();
      }),
      context.gateway.subscribeEvents((event) => {
        if (this.connected && event.event === "portal.changed") {
          void this.loadPresentation();
        }
      }),
    ];
    if (this.connected) {
      void this.loadPresentation();
    }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
  dispose() {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.lifecycle.dispose();
    this.resetGatewayState();
    this.listeners.clear();
  }
  presentationChanged(previous: PortalsPresentation | undefined) {
    if (!previous) {
      return;
    }
    const targetChanged =
      previous.requestedPortalId !== this.presentation().requestedPortalId ||
      previous.requestedEnvironmentId !== this.presentation().requestedEnvironmentId;
    if (targetChanged) {
      this.resetPendingEnvironment();
      this.loading = false;
      this.portalProbeState = null;
      this.applyPortalSet(this.portals);
      void this.loadPresentation();
    } else if (this.presentation().presented && !previous.presented) {
      void this.loadPresentation();
    } else if (!this.presentation().presented) {
      this.pollEnvironment(false);
      this.environmentLoading = false;
    }
    this.notify();
  }
  get pendingEnvironmentId(): string | null {
    return this.presentation().requestedPortalId
      ? null
      : this.presentation().requestedEnvironmentId;
  }

  loadPresentation(): Promise<void> {
    return this.pendingEnvironmentId ? this.loadPendingEnvironment() : this.loadPortals();
  }

  async loadPendingEnvironment(): Promise<void> {
    const environmentId = this.pendingEnvironmentId;
    const scope = this.lifecycle.capture();
    if (
      !environmentId ||
      !scope ||
      !this.canReadPortalState ||
      this.environmentLoading ||
      (this.presentation().embedded && !this.presentation().presented)
    ) {
      return;
    }
    const isCurrent = () =>
      this.lifecycle.isCurrent(scope) && this.pendingEnvironmentId === environmentId;
    this.environmentLoading = true;
    this.environmentFailure = null;
    this.notify();
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
      this.pendingEnvironment = environment;
      this.pollEnvironment(environment.status === "starting");
    } catch (error) {
      if (isCurrent()) {
        this.environmentFailure = { environmentId, message: formatUiError(error) };
        this.pollEnvironment(false);
      }
    } finally {
      if (isCurrent()) {
        this.environmentLoading = false;
      }
      this.notify();
    }
  }

  get portalListSupported(): boolean {
    return isGatewayMethodAdvertised(this.context.gateway.snapshot ?? {}, "portal.list") !== false;
  }

  get canReadPortalState(): boolean {
    return canCallGatewayMethod(
      this.context.gateway.snapshot,
      this.pendingEnvironmentId ? "environments.status" : "portal.list",
      "operator.read",
      { requireAdvertisement: false },
    );
  }

  get canClosePortal(): boolean {
    return canCallGatewayMethod(this.context.gateway.snapshot, "portal.close", "operator.write");
  }

  resetPendingEnvironment() {
    this.environmentLoading = false;
    this.pendingEnvironment = null;
    this.environmentFailure = null;
    this.pollEnvironment(false);
  }

  resetGatewayState() {
    this.resetPendingEnvironment();
    this.portals = [];
    this.selectedPortalId = null;
    this.loading = false;
    this.loaded = false;
    this.error = null;
    this.closingPortalId = null;
    this.portalProbeCache.clear();
    this.portalProbeState = null;
  }

  applyPortalSet(portals: readonly PortalSummary[]) {
    this.portals = [...portals];
    const previousPortalId = this.selectedPortalId;
    const selectedPortalId = this.pendingEnvironmentId
      ? null
      : (this.presentation().requestedPortalId ??
        (portals.some((portal) => portal.id === previousPortalId)
          ? this.selectedPortalId
          : (portals[0]?.id ?? null)));
    this.selectedPortalId = selectedPortalId;
    this.loaded = true;
    this.error = null;
    const selectedPortal = portals.find((portal) => portal.id === selectedPortalId);
    if (selectedPortal) {
      this.ensurePortalProbe(selectedPortal, selectedPortalId !== previousPortalId);
    } else {
      this.portalProbeState = null;
    }
    this.notify();
  }

  ensurePortalProbe(portal: PortalSummary, force = false) {
    if (!portal.tokenQuery || !portal.url) {
      this.portalProbeState = null;
      this.notify();
      return;
    }
    const url = portal.url;
    const key = `${portal.id}\u0000${url}`;
    if (!force && this.portalProbeState?.key === key) {
      this.notify();
      return;
    }
    if (portalNeedsRemoteIngress(url, this.context.gateway.connection.gatewayUrl)) {
      this.portalProbeState = { key, status: "ingress-required" };
      this.notify();
      return;
    }
    if (portalNeedsNewTab(url, location.href)) {
      this.portalProbeState = { key, status: "new-tab-required" };
      this.notify();
      return;
    }
    const cached = force ? undefined : this.portalProbeCache.get(key);
    if (cached !== undefined) {
      this.portalProbeState = { key, status: cached };
      this.notify();
      return;
    }

    const scope = this.lifecycle.capture();
    this.portalProbeState = { key, status: "probing" };
    this.notify();
    void probePortalReachable(url).then((reachability) => {
      if (scope && this.lifecycle.isCurrent(scope) && this.portalProbeState?.key === key) {
        this.portalProbeCache.set(key, reachability);
        this.portalProbeState = { key, status: reachability };
        this.notify();
      }
    });
  }

  selectPortal(portal: PortalSummary) {
    if (portal.id === this.selectedPortalId) {
      return;
    }
    this.selectedPortalId = portal.id;
    this.ensurePortalProbe(portal, true);
    this.notify();
  }

  async loadPortals() {
    if (
      this.pendingEnvironmentId ||
      !this.canReadPortalState ||
      !this.portalListSupported ||
      this.loading ||
      (this.presentation().embedded && !this.presentation().presented)
    ) {
      return;
    }
    const scope = this.lifecycle.capture();
    if (!scope) {
      return;
    }
    const isCurrent = () => this.lifecycle.isCurrent(scope);
    this.loading = true;
    this.error = null;
    this.notify();
    try {
      const result = await scope.client.request<PortalListResult>("portal.list", {});
      if (isCurrent()) {
        this.applyPortalSet(result.portals);
      }
    } catch (error) {
      if (isCurrent() && this.portalListSupported) {
        this.error = t("portalsPage.loadFailed", { error: formatUiError(error) });
        this.loaded = true;
      }
    } finally {
      if (isCurrent()) {
        this.loading = false;
      }
      this.notify();
    }
  }

  async closePortal(portal: PortalSummary) {
    if (!this.canClosePortal || this.closingPortalId) {
      return;
    }
    const scope = this.lifecycle.capture();
    if (!scope) {
      return;
    }
    this.closingPortalId = portal.id;
    this.error = null;
    this.notify();
    const current = () => this.lifecycle.isCurrent(scope) && this.closingPortalId === portal.id;
    try {
      await scope.client.request<PortalCloseResult>("portal.close", { id: portal.id });
      if (current()) {
        void this.loadPortals();
      }
    } catch (error) {
      if (current()) {
        this.error = t("portalsPage.closeFailed", { error: formatUiError(error) });
      }
    } finally {
      if (current()) {
        this.closingPortalId = null;
      }
      this.notify();
    }
  }
}
