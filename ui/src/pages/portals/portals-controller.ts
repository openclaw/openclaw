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
  get embedded() {
    return this.readPresentation().embedded;
  }
  get presented() {
    return this.readPresentation().presented;
  }
  get requestedPortalId() {
    return this.readPresentation().requestedPortalId;
  }
  get requestedEnvironmentId() {
    return this.readPresentation().requestedEnvironmentId;
  }
  portals: PortalSummary[] = [];
  selectedPortalId: string | null = null;
  loading = false;
  loaded = false;
  error: string | null = null;
  closingPortalId: string | null = null;
  portalProbeState: PortalProbeState | null = null;
  pendingEnvironment: EnvironmentSummary | null = null;
  environmentFailure: { environmentId: string; message: string } | null = null;
  private environmentRequestGeneration = 0;
  private environmentLoading = false;
  private requestGeneration = 0;
  private portalSetRevision = 0;
  private portalProbeGeneration = 0;
  private readonly portalProbeCache = new Map<string, PortalReachability>();
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle;
  private readonly unsubscribers: Array<() => void>;
  private environmentTimer: ReturnType<typeof setInterval> | undefined;
  private readonly environmentPoll = {
    start: () => {
      if (this.environmentTimer === undefined) {
        this.environmentTimer = setInterval(() => void this.loadPendingEnvironment(), 2_000);
      }
    },
    stop: () => {
      clearInterval(this.environmentTimer);
      this.environmentTimer = undefined;
    },
  };
  get connected() {
    return this.context.gateway.snapshot.phase === "connected";
  }

  constructor(
    readonly context: ApplicationContext,
    private readonly readPresentation: () => PortalsPresentation,
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
      previous.requestedPortalId !== this.requestedPortalId ||
      previous.requestedEnvironmentId !== this.requestedEnvironmentId;
    if (targetChanged) {
      this.requestGeneration += 1;
      this.resetPendingEnvironment();
      this.loading = false;
      this.portalProbeGeneration += 1;
      this.portalProbeState = null;
      this.applyPortalSet(this.portals);
      void this.loadPresentation();
    } else if (this.presented && !previous.presented) {
      void this.loadPresentation();
    } else if (!this.presented) {
      this.environmentPoll.stop();
      this.environmentRequestGeneration += 1;
      this.environmentLoading = false;
    }
    this.notify();
  }
  get pendingEnvironmentId(): string | null {
    return this.requestedPortalId ? null : this.requestedEnvironmentId;
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
      (this.embedded && !this.presented)
    ) {
      return;
    }
    const generation = ++this.environmentRequestGeneration;
    const isCurrent = () =>
      this.lifecycle.isCurrent(scope) &&
      generation === this.environmentRequestGeneration &&
      this.pendingEnvironmentId === environmentId;
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
      if (environment.status === "starting") {
        this.environmentPoll.start();
      } else {
        this.environmentPoll.stop();
      }
    } catch (error) {
      if (isCurrent()) {
        this.environmentFailure = { environmentId, message: formatUiError(error) };
        this.environmentPoll.stop();
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
    this.environmentRequestGeneration += 1;
    this.environmentLoading = false;
    this.pendingEnvironment = null;
    this.environmentFailure = null;
    this.environmentPoll.stop();
  }

  resetGatewayState() {
    this.resetPendingEnvironment();
    this.requestGeneration += 1;
    this.portalSetRevision += 1;
    this.portals = [];
    this.selectedPortalId = null;
    this.loading = false;
    this.loaded = false;
    this.error = null;
    this.closingPortalId = null;
    this.portalProbeGeneration += 1;
    this.portalProbeCache.clear();
    this.portalProbeState = null;
  }

  applyPortalSet(portals: readonly PortalSummary[]) {
    this.portalSetRevision += 1;
    this.portals = [...portals];
    const previousPortalId = this.selectedPortalId;
    const selectedPortalId = this.pendingEnvironmentId
      ? null
      : (this.requestedPortalId ??
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
      this.portalProbeGeneration += 1;
      this.portalProbeState = null;
    }
    this.notify();
  }

  ensurePortalProbe(portal: PortalSummary, force = false) {
    if (!portal.tokenQuery || !portal.url) {
      this.portalProbeGeneration += 1;
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
      this.portalProbeGeneration += 1;
      this.portalProbeState = { key, status: "ingress-required" };
      this.notify();
      return;
    }
    if (portalNeedsNewTab(url, location.href)) {
      this.portalProbeGeneration += 1;
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

    const generation = ++this.portalProbeGeneration;
    this.portalProbeState = { key, status: "probing" };
    this.notify();
    void probePortalReachable(url).then((reachability) => {
      if (generation === this.portalProbeGeneration && this.portalProbeState?.key === key) {
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
      (this.embedded && !this.presented)
    ) {
      return;
    }
    const scope = this.lifecycle.capture();
    if (!scope) {
      return;
    }
    const generation = ++this.requestGeneration;
    const portalSetRevision = this.portalSetRevision;
    const isCurrent = () =>
      generation === this.requestGeneration && this.lifecycle.isCurrent(scope);
    this.loading = true;
    this.error = null;
    this.notify();
    try {
      const result = await scope.client.request<PortalListResult>("portal.list", {});
      if (isCurrent() && portalSetRevision === this.portalSetRevision) {
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
    try {
      await scope.client.request<PortalCloseResult>("portal.close", { id: portal.id });
      if (this.lifecycle.isCurrent(scope)) {
        void this.loadPortals();
      }
    } catch (error) {
      if (this.lifecycle.isCurrent(scope)) {
        this.error = t("portalsPage.closeFailed", { error: formatUiError(error) });
      }
    } finally {
      if (this.lifecycle.isCurrent(scope) && this.closingPortalId === portal.id) {
        this.closingPortalId = null;
      }
      this.notify();
    }
  }
}
