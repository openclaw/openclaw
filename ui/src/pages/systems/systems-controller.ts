import type { SystemInfoResult } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import {
  loadSystemsInventory,
  projectSystemsInventory,
  type SystemsInventory,
  type SystemsInventoryRow,
} from "./systems-data.ts";
import {
  SYSTEMS_GATEWAY_STALE_MS,
  SYSTEMS_NODE_STALE_MS,
  systemMeasurements,
  type SystemsTelemetrySample,
} from "./systems-telemetry.ts";

const TELEMETRY_SAMPLE_LIMIT = 120;

export type SystemsSortMode = "name" | "online-first" | "offline-first";
export type SystemsStatusFilter = "all" | "online" | "offline";

/** The route cache owns selection; the mounted page owns active reads and subscriptions. */
export class SystemsController {
  readonly scope;
  inventory: SystemsInventory | null = null;
  rows: SystemsInventoryRow[] = [];
  selectedId: string | null = null;
  query = "";
  sortMode: SystemsSortMode = "online-first";
  statusFilter: SystemsStatusFilter = "all";
  showStats = true;
  showDetails = false;
  loading = false;
  error: string | null = null;
  sampledAtMs: number | null = null;
  desktopSetupError: string | null = null;
  private desktopSetupRequest: symbol | undefined;
  private readonly telemetry = new Map<string, readonly SystemsTelemetrySample[]>();
  private readonly listeners = new Set<() => void>();
  private readonly lifecycle;
  private subscriptions: Array<() => void> = [];
  private request: AbortController | undefined;
  private telemetryRequest: AbortController | undefined;
  private generation = 0;
  private presented = false;
  private refreshQueued = false;

  constructor(readonly context: ApplicationContext) {
    this.scope = gatewayPresentationScope(context.gateway);
    this.lifecycle = createGatewayConnectionLifecycle(context.gateway.snapshot);
  }

  get current(): boolean {
    return this.scope === gatewayPresentationScope(this.context.gateway);
  }

  get connected(): boolean {
    return this.current && this.context.gateway.snapshot.phase === "connected";
  }

  get desktopAvailable(): boolean {
    return this.current && isDesktopPanelAvailable(this.context.gateway.snapshot);
  }

  get selected(): SystemsInventoryRow | undefined {
    return this.current
      ? this.rows.find((row) => row.environment.id === this.selectedId)
      : undefined;
  }

  get hostDesktopEnabled(): boolean {
    const config = resolveEditableSnapshotConfig(this.context.runtimeConfig.state.configSnapshot);
    const desktop = config?.desktop;
    return isRecord(desktop) && isRecord(desktop.host) && desktop.host.enabled === true;
  }

  get desktopSetupBusy(): boolean {
    return this.desktopSetupRequest !== undefined;
  }

  private resetDesktopSetup(): void {
    this.desktopSetupRequest = undefined;
    this.desktopSetupError = null;
  }

  get canEnableHostDesktop(): boolean {
    const setup = this.selected?.environment.desktopSetup;
    return (
      this.presented &&
      this.connected &&
      this.selectedId === "gateway" &&
      (setup?.state === "ready" || setup?.state === "managed") &&
      !this.hostDesktopEnabled &&
      this.context.runtimeConfig.canPatch === true
    );
  }

  async enableHostDesktop(): Promise<void> {
    const scope = this.lifecycle.capture();
    const runtimeConfig = this.context.runtimeConfig;
    if (!scope || !this.canEnableHostDesktop || this.desktopSetupBusy) {
      return;
    }
    const request = Symbol("desktop-setup");
    const isCurrent = () =>
      this.desktopSetupRequest === request &&
      this.presented &&
      this.current &&
      this.lifecycle.isCurrent(scope) &&
      this.context.runtimeConfig === runtimeConfig;
    this.desktopSetupRequest = request;
    this.desktopSetupError = null;
    this.notify();
    try {
      await runtimeConfig.ensureLoaded();
      if (!isCurrent() || !this.canEnableHostDesktop) {
        return;
      }
      const patched = await runtimeConfig.patch({
        raw: { desktop: { host: { enabled: true } } },
        note: "systems: enable host desktop",
        canDispatch: () => isCurrent() && this.canEnableHostDesktop,
      });
      if (isCurrent() && !patched) {
        this.desktopSetupError = runtimeConfig.state.lastError ?? t("systems.desktopSetupFailed");
      }
      if (isCurrent() && patched) {
        await this.refresh();
      }
    } catch (error) {
      if (isCurrent()) {
        this.desktopSetupError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.desktopSetupRequest = undefined;
        this.notify();
      }
    }
  }

  telemetryHistory(id: string): readonly SystemsTelemetrySample[] {
    return this.current ? (this.telemetry.get(id) ?? []) : [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private projectRows(): void {
    this.rows =
      this.inventory && this.current
        ? projectSystemsInventory(
            this.inventory,
            this.context.sessions.state.result?.sessions ?? [],
          )
        : [];
  }

  private recordTelemetry(gatewaySampled: boolean): void {
    const currentIds = new Set(this.rows.map((row) => row.environment.id));
    for (const id of this.telemetry.keys()) {
      if (!currentIds.has(id)) {
        this.telemetry.delete(id);
      }
    }
    for (const row of this.rows) {
      const id = row.environment.id;
      const stats = systemMeasurements(row);
      if (!stats) {
        this.telemetry.delete(id);
        continue;
      }
      const gatewayHost = id === "gateway";
      if (gatewayHost && !gatewaySampled) {
        continue;
      }
      const at = row.node?.hostStats?.updatedAtMs ?? this.sampledAtMs;
      if (at === null) {
        continue;
      }
      const previous = this.telemetry.get(id) ?? [];
      const last = previous.at(-1);
      // node.list can return the same report across several UI polls.
      if (last && at <= last.at) {
        continue;
      }
      const staleAfter = gatewayHost ? SYSTEMS_GATEWAY_STALE_MS : SYSTEMS_NODE_STALE_MS;
      const history = last && at - last.at <= staleAfter ? previous : [];
      this.telemetry.set(id, [...history.slice(-(TELEMETRY_SAMPLE_LIMIT - 1)), { at, stats }]);
    }
  }

  select(id: string): void {
    if (!this.current || !id.trim()) {
      return;
    }
    this.telemetryRequest?.abort();
    this.telemetryRequest = undefined;
    if (id !== this.selectedId) {
      this.resetDesktopSetup();
    }
    this.selectedId = id;
    this.notify();
  }

  search(query: string): void {
    this.query = query;
    this.notify();
  }

  setSortMode(mode: SystemsSortMode): void {
    this.sortMode = mode;
    this.notify();
  }

  setStatusFilter(filter: SystemsStatusFilter): void {
    this.statusFilter = filter;
    this.notify();
  }

  toggleStats(): void {
    this.showStats = !this.showStats;
    this.notify();
  }

  toggleDetails(): void {
    this.showDetails = !this.showDetails;
    this.notify();
  }

  /** A sidebar subscription only redraws; it never starts a second inventory reader. */
  setPresented(presented: boolean): void {
    if (this.presented === presented) {
      return;
    }
    this.presented = presented;
    if (!presented) {
      for (const unsubscribe of this.subscriptions) {
        unsubscribe();
      }
      this.subscriptions = [];
      this.cancelRefresh();
      this.resetDesktopSetup();
      return;
    }
    this.subscriptions = [
      this.context.gateway.subscribe((snapshot) => {
        const changed = this.lifecycle.transition(snapshot);
        if (!this.current) {
          this.clear();
        } else if (changed) {
          this.cancelRefresh();
          this.resetDesktopSetup();
          this.telemetry.clear();
          if (snapshot.phase === "connected") {
            void this.refresh();
          }
        }
        this.notify();
      }),
      this.context.gateway.subscribeEvents((event) => {
        if (
          event.event === "presence" ||
          event.event === "node.pair.resolved" ||
          event.event === "node.runnerInventory.changed" ||
          event.event === "config.changed"
        ) {
          void this.refresh();
        } else if (
          event.event === "node.hostStats" &&
          isRecord(event.payload) &&
          typeof event.payload.nodeId === "string" &&
          this.selectedId === `node:${event.payload.nodeId}`
        ) {
          void this.refreshTelemetry();
        }
      }),
      this.context.sessions.subscribe(() => {
        this.projectRows();
        this.notify();
      }),
      this.context.runtimeConfig.subscribe(() => this.notify()),
    ];
    if (this.lifecycle.transition(this.context.gateway.snapshot)) {
      this.telemetry.clear();
    }
    if (!this.current) {
      this.clear();
    } else {
      void this.refresh();
    }
  }

  private cancelRefresh(): void {
    this.generation += 1;
    this.request?.abort();
    this.telemetryRequest?.abort();
    this.request = undefined;
    this.telemetryRequest = undefined;
    this.loading = false;
    this.refreshQueued = false;
  }

  private clear(): void {
    this.cancelRefresh();
    this.inventory = null;
    this.rows = [];
    this.selectedId = null;
    this.error = null;
    this.sampledAtMs = null;
    this.telemetry.clear();
    this.resetDesktopSetup();
    this.query = "";
  }

  async refresh(): Promise<void> {
    const snapshot = this.context.gateway.snapshot;
    if (this.lifecycle.transition(snapshot)) {
      this.telemetry.clear();
    }
    const scope = this.lifecycle.capture();
    if (
      !this.presented ||
      !this.current ||
      !scope ||
      !hasOperatorReadAccess(snapshot.hello?.auth ?? null)
    ) {
      return;
    }
    // Bursts of presence events must not continually cancel the only useful response.
    if (this.loading) {
      this.refreshQueued = true;
      return;
    }
    this.cancelRefresh();
    const generation = this.generation;
    const request = new AbortController();
    this.request = request;
    const isCurrent = () =>
      this.presented &&
      this.current &&
      generation === this.generation &&
      this.lifecycle.isCurrent(scope);
    this.loading = true;
    this.error = null;
    this.notify();
    try {
      const inventory = await loadSystemsInventory(scope.client, {
        signal: request.signal,
        isCurrent,
      });
      if (!inventory || !isCurrent()) {
        return;
      }
      const initial = this.inventory === null;
      this.inventory = inventory;
      this.projectRows();
      this.sampledAtMs = Date.now();
      this.recordTelemetry(true);
      // Only initial entry picks a default. Later updates never replace an explicit or missing selection.
      if (initial && this.selectedId === null) {
        const currentSession = this.context.gateway.snapshot.sessionKey;
        this.selectedId =
          this.rows.find((row) =>
            row.sessions.some((relation) => relation.session.key === currentSession),
          )?.environment.id ??
          this.rows.find((row) => row.environment.id === "gateway")?.environment.id ??
          this.rows[0]?.environment.id ??
          null;
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.loading = false;
        this.request = undefined;
        const refreshQueued = this.refreshQueued;
        this.refreshQueued = false;
        this.notify();
        if (refreshQueued) {
          void this.refresh();
        }
      }
    }
  }

  /** Refresh selected-host measurements without reloading profiles or changing the desktop source. */
  async refreshTelemetry(): Promise<void> {
    const selected = this.selected;
    const inventory = this.inventory;
    const scope = this.lifecycle.capture();
    if (
      !this.presented ||
      !this.current ||
      !scope ||
      !selected ||
      !inventory ||
      this.loading ||
      this.telemetryRequest
    ) {
      return;
    }
    const gatewayHost = selected.environment.id === "gateway";
    if (!gatewayHost && selected.environment.type !== "node") {
      return;
    }
    const request = new AbortController();
    this.telemetryRequest = request;
    const generation = this.generation;
    const id = this.selectedId;
    const isCurrent = () =>
      this.presented &&
      this.current &&
      this.lifecycle.isCurrent(scope) &&
      this.telemetryRequest === request &&
      generation === this.generation &&
      this.selectedId === id;
    try {
      if (gatewayHost) {
        const info = await scope.client.request<SystemInfoResult>(
          "system.info",
          {},
          { signal: request.signal },
        );
        if (!isCurrent() || !this.inventory) {
          return;
        }
        const { systemInfo: _previousError, ...errors } = this.inventory.errors;
        this.inventory = { ...this.inventory, gatewaySystemInfo: info, errors };
        this.sampledAtMs = Date.now();
      } else {
        const result = await scope.client.request<{ nodes: NodeListNode[] }>(
          "node.list",
          {},
          { signal: request.signal },
        );
        if (!isCurrent() || !this.inventory) {
          return;
        }
        const { nodes: _previousError, ...errors } = this.inventory.errors;
        this.inventory = { ...this.inventory, nodes: result.nodes, errors };
      }
      this.projectRows();
      this.recordTelemetry(gatewayHost);
    } catch (error) {
      if (isCurrent() && this.inventory) {
        this.inventory = {
          ...this.inventory,
          errors: {
            ...this.inventory.errors,
            [gatewayHost ? "systemInfo" : "nodes"]: formatUiError(error),
          },
        };
      }
    } finally {
      if (isCurrent()) {
        this.telemetryRequest = undefined;
        this.notify();
      }
    }
  }
}

export type SystemsRouteData = { controller: SystemsController };
