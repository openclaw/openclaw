import type { BackupStatusResult, StorageLocationsProbeResult } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { enableHostDesktop as enableHostDesktopConfig } from "../../components/desktop/host-desktop-setup.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { readSystemInfo } from "../../lib/system-info.ts";
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

// Worker lifecycle is only reported by environments.list; placement changes signal it moved.
function placementSignature(sessions: readonly GatewaySessionRow[]): string {
  return JSON.stringify(
    sessions
      .flatMap(({ key, placement }) =>
        placement && placement.state !== "local"
          ? [[key, "environmentId" in placement ? placement.environmentId : null, placement.state]]
          : [],
      )
      .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

export type SystemsSortMode = "name" | "online-first" | "offline-first";
export type SystemsStatusFilter = "all" | "online" | "offline";

type SystemsState = {
  inventory: SystemsInventory | null;
  rows: SystemsInventoryRow[];
  selectedId: string | null;
  query: string;
  sortMode: SystemsSortMode;
  statusFilter: SystemsStatusFilter;
  showStats: boolean;
  showDetails: boolean;
  desktopSetupError: string | null;
  backups: BackupStatusResult | null;
  backupsError: string | null;
};

export type Systems = ReturnType<typeof createSystems>;

/** The route cache owns selection/preferences; mounted views own observation and active reads. */
export function createSystems(context: ApplicationContext) {
  const state: SystemsState = {
    inventory: null,
    rows: [],
    selectedId: null,
    query: "",
    sortMode: "online-first",
    statusFilter: "all",
    showStats: true,
    showDetails: false,
    desktopSetupError: null,
    backups: null,
    backupsError: null,
  };
  const storageProbes = new Map<string, StorageLocationsProbeResult>();
  const presentationScope = gatewayPresentationScope(context.gateway);
  const lifecycle = createGatewayConnectionLifecycle(context.gateway.snapshot);
  type Scope = NonNullable<ReturnType<typeof lifecycle.capture>>;
  const storageProbeRequests = new Map<
    string,
    ReturnType<typeof createPageRequest<Scope, StorageLocationsProbeResult>>
  >();
  const telemetry = new Map<string, readonly SystemsTelemetrySample[]>();
  const listeners = createChangeListeners();
  const notify = listeners.publish;

  let desktopSetupRequest: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let subscriptions: Array<() => void> = [];

  let telemetryRequest: AbortController | undefined;
  let active = false;
  let refreshQueued: "automatic" | "manual" | undefined;
  const current = () => presentationScope === gatewayPresentationScope(context.gateway);

  const connected = () => current() && context.gateway.snapshot.phase === "connected";

  const needsInventoryRefresh = () => state.inventory === null || refreshQueued !== undefined;

  const sampledAtMs = () => state.inventory?.gatewaySampledAtMs ?? null;

  const loading = () => inventoryRequest.pending;

  const desktopAvailable = () => current() && isDesktopPanelAvailable(context.gateway.snapshot);

  const selected = () =>
    current() ? state.rows.find((row) => row.environment.id === state.selectedId) : undefined;

  function hostDesktopEnabled(): boolean {
    const config = resolveEditableSnapshotConfig(context.runtimeConfig.state.configSnapshot);
    const desktop = config?.desktop;
    return isRecord(desktop) && isRecord(desktop.host) && desktop.host.enabled === true;
  }

  const desktopSetupBusy = () => desktopSetupRequest !== undefined;

  const storageProbeBusy = (name: string) => storageProbeRequests.get(name)?.pending === true;

  const backupsRequest = createPageRequest<Scope, BackupStatusResult>(notify, {
    task: (scope, { signal }) => scope.client.request("backup.status", {}, { signal }),
    onComplete: (result) => {
      state.backups = result;
    },
    // The completion receipt carries failures to the native error boundary.
    onError: () => {},
  });

  function cancelBackups(): void {
    backupsRequest.cancel();
    for (const request of storageProbeRequests.values()) {
      request.cancel();
    }
    storageProbeRequests.clear();
  }

  function clearBackups(error: string | null = null): void {
    cancelBackups();
    state.backups = null;
    state.backupsError = error;
    storageProbes.clear();
  }

  async function readBackupState(name?: string): Promise<void> {
    const scope = lifecycle.capture();
    if (
      !active ||
      !current() ||
      !scope ||
      (name === undefined ? backupsRequest.pending : storageProbeBusy(name)) ||
      (name === undefined && document.visibilityState === "hidden") ||
      !hasOperatorReadAccess(context.gateway.snapshot.hello?.auth ?? null)
    ) {
      return;
    }
    if (name === undefined) {
      state.backupsError = null;
      return backupsRequest.run(scope);
    }
    const request = createPageRequest<Scope, StorageLocationsProbeResult>(notify, {
      task: (target, { signal }) =>
        target.client.request("storage.locations.probe", { name }, { signal }),
      onComplete: (result) => {
        storageProbes.set(name, result);
      },
      onError: (error) => {
        storageProbes.set(name, { state: "error", message: formatUiError(error) });
      },
    });
    storageProbeRequests.set(name, request);
    storageProbes.delete(name);
    return request.run(scope);
  }

  function resetDesktopSetup(): void {
    desktopSetupRequest?.resolve();
    desktopSetupRequest = undefined;
    state.desktopSetupError = null;
  }

  function canEnableHostDesktop(): boolean {
    const setup = selected()?.environment.desktopSetup;
    return (
      active &&
      connected() &&
      state.selectedId === "gateway" &&
      (setup?.state === "ready" || setup?.state === "managed") &&
      !hostDesktopEnabled() &&
      context.runtimeConfig.canPatch === true
    );
  }

  function enableHostDesktop() {
    const scope = lifecycle.capture();
    const runtimeConfig = context.runtimeConfig;
    if (!scope || !canEnableHostDesktop() || desktopSetupBusy()) {
      return undefined;
    }
    const request = Promise.withResolvers<void>();
    const isCurrent = () =>
      desktopSetupRequest === request &&
      active &&
      current() &&
      lifecycle.isCurrent(scope) &&
      context.runtimeConfig === runtimeConfig;
    desktopSetupRequest = request;
    state.desktopSetupError = null;
    notify();
    const completion = (async () => {
      try {
        const failure = await enableHostDesktopConfig(
          runtimeConfig,
          "systems: enable host desktop",
          () => isCurrent() && canEnableHostDesktop(),
        );
        if (isCurrent() && failure === null) {
          await refresh();
        } else if (isCurrent() && failure !== undefined) {
          state.desktopSetupError = failure;
        }
      } catch (error) {
        if (isCurrent()) {
          state.desktopSetupError = formatUiError(error);
        }
      } finally {
        if (isCurrent()) {
          desktopSetupRequest = undefined;
          request.resolve();
          notify();
        }
      }
    })();
    return { completion, retired: request.promise };
  }

  const telemetryHistory = (id: string) => (current() ? (telemetry.get(id) ?? []) : []);

  function projectRows(): void {
    state.rows =
      state.inventory && current()
        ? projectSystemsInventory(state.inventory, context.sessions.state.result?.sessions ?? [])
        : [];
  }

  function recordTelemetry(gatewaySampled: boolean): void {
    const currentIds = new Set(state.rows.map((row) => row.environment.id));
    for (const id of telemetry.keys()) {
      if (!currentIds.has(id)) {
        telemetry.delete(id);
      }
    }
    for (const row of state.rows) {
      const id = row.environment.id;
      const stats = systemMeasurements(row);
      if (!stats) {
        telemetry.delete(id);
        continue;
      }
      const gatewayHost = id === "gateway";
      if (gatewayHost && !gatewaySampled) {
        continue;
      }
      const at = row.node?.hostStats?.updatedAtMs ?? sampledAtMs();
      if (at === null) {
        continue;
      }
      const previous = telemetry.get(id) ?? [];
      const last = previous.at(-1);
      // node.list can return the same report across several UI polls.
      if (last && at <= last.at) {
        continue;
      }
      const staleAfter = gatewayHost ? SYSTEMS_GATEWAY_STALE_MS : SYSTEMS_NODE_STALE_MS;
      const history = last && at - last.at <= staleAfter ? previous : [];
      telemetry.set(id, [...history.slice(-(TELEMETRY_SAMPLE_LIMIT - 1)), { at, stats }]);
    }
  }

  function cancelRefresh(): void {
    inventoryRequest.cancel();
    telemetryRequest?.abort();
    telemetryRequest = undefined;
    refreshQueued = undefined;
  }

  function clear(): void {
    cancelRefresh();
    clearBackups();
    state.inventory = null;
    state.rows = [];
    state.selectedId = null;
    telemetry.clear();
    resetDesktopSetup();
    state.query = "";
  }

  const inventoryRequest = createPageRequest<
    "automatic" | "manual",
    { inventory: SystemsInventory | undefined; intent: "automatic" | "manual" }
  >(notify, {
    task: async (intent, { signal }) => ({
      inventory: await loadSystemsInventory(context.gateway, {
        signal,
        fresh: intent === "manual",
      }),
      intent,
    }),
    onComplete: ({ inventory, intent }) => {
      if (!inventory) {
        refreshQueued = refreshQueued === "manual" ? "manual" : intent;
        return;
      }
      const initial = state.inventory === null;
      state.inventory = inventory;
      projectRows();
      recordTelemetry(true);
      // Only initial entry picks a default. Later updates preserve explicit or missing selection.
      if (initial && state.selectedId === null) {
        const currentSession = context.gateway.snapshot.sessionKey;
        state.selectedId =
          state.rows.find((row) =>
            row.sessions.some((relation) => relation.session.key === currentSession),
          )?.environment.id ??
          state.rows.find((row) => row.environment.id === "gateway")?.environment.id ??
          state.rows[0]?.environment.id ??
          null;
      }
    },
    onError: () => {},
  });

  async function refresh(intent: "automatic" | "manual" = "automatic"): Promise<void> {
    const snapshot = context.gateway.snapshot;
    if (lifecycle.transition(snapshot)) {
      telemetry.clear();
    }
    const scope = lifecycle.capture();
    if (!active || !current() || !scope || !hasOperatorReadAccess(snapshot.hello?.auth ?? null)) {
      return;
    }
    const refreshIntent = refreshQueued === "manual" ? "manual" : intent;
    // Hidden pages and event bursts retain one refresh without cancelling useful work.
    if (loading() || document.visibilityState === "hidden") {
      refreshQueued = refreshIntent;
      return;
    }
    cancelRefresh();
    void readBackupState();
    const pending = inventoryRequest.run(refreshIntent);
    const receipt = inventoryRequest.read;
    await pending;
    if (inventoryRequest.read === receipt && refreshQueued) {
      void refresh();
    }
  }

  /** Refresh selected-host measurements without reloading profiles or changing the desktop source. */
  async function refreshTelemetry(): Promise<void> {
    const selectedRow = selected();
    const inventory = state.inventory;
    const scope = lifecycle.capture();
    if (
      !active ||
      !current() ||
      !scope ||
      !selectedRow ||
      !inventory ||
      loading() ||
      telemetryRequest
    ) {
      return;
    }
    const gatewayHost = selectedRow.environment.id === "gateway";
    if (!gatewayHost && selectedRow.environment.type !== "node") {
      return;
    }
    const request = new AbortController();
    telemetryRequest = request;
    const isCurrent = () =>
      active && current() && lifecycle.isCurrent(scope) && telemetryRequest === request;
    try {
      if (gatewayHost) {
        const sample = await readSystemInfo(context.gateway, request.signal);
        if (!isCurrent() || !state.inventory) {
          return;
        }
        const { systemInfo: _previousError, ...errors } = state.inventory.errors;
        state.inventory = {
          ...state.inventory,
          gatewaySystemInfo: sample.value,
          gatewaySampledAtMs: sample.at,
          errors,
        };
      } else {
        const result = await scope.client.request<{ nodes: NodeListNode[] }>(
          "node.list",
          {},
          { signal: request.signal },
        );
        if (!isCurrent() || !state.inventory) {
          return;
        }
        const { nodes: _previousError, ...errors } = state.inventory.errors;
        state.inventory = { ...state.inventory, nodes: result.nodes, errors };
      }
      projectRows();
      recordTelemetry(gatewayHost);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      if (isCurrent() && state.inventory) {
        state.inventory = {
          ...state.inventory,
          errors: {
            ...state.inventory.errors,
            [gatewayHost ? "systemInfo" : "nodes"]: formatUiError(error),
          },
        };
      }
    } finally {
      if (isCurrent()) {
        telemetryRequest = undefined;
        notify();
      }
    }
  }
  return {
    context,
    state,
    storageProbes,
    sampledAtMs,
    current,
    connected,
    needsInventoryRefresh,
    loading,
    get inventoryRead() {
      return inventoryRequest.read;
    },
    get backupsRead() {
      return backupsRequest.read;
    },
    storageProbeRead: (name: string) => storageProbeRequests.get(name)?.read ?? null,
    desktopAvailable,
    selected,
    hostDesktopEnabled,
    desktopSetupBusy,
    canEnableHostDesktop,
    telemetryHistory,
    select(id: string): void {
      if (!current() || !id.trim()) {
        return;
      }
      telemetryRequest?.abort();
      telemetryRequest = undefined;
      if (id !== state.selectedId) {
        resetDesktopSetup();
      }
      state.selectedId = id;
      notify();
    },
    updatePresentation(
      patch: Partial<
        Pick<SystemsState, "query" | "sortMode" | "statusFilter" | "showStats" | "showDetails">
      >,
    ): void {
      Object.assign(state, patch);
      notify();
    },
    /** A sidebar subscription only redraws; it never starts a second inventory reader. */
    setPresented(presented: boolean): void {
      if (active === presented) {
        return;
      }
      active = presented;
      if (!presented) {
        subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
        cancelRefresh();
        cancelBackups();
        resetDesktopSetup();
        return;
      }
      let location = context.router.getState().location;
      let placements = placementSignature(context.sessions.state.result?.sessions ?? []);
      subscriptions = [
        context.router.subscribe((next) => {
          if (next.location !== location) {
            location = next.location;
            // Navigation must release the action before Solid can commit page parking.
            desktopSetupRequest?.resolve();
          }
        }),
        // Gateway receipts cancel stale inventory, backup, and desktop work before connection or access changes settle.
        context.gateway.subscribe((snapshot) => {
          const changed = lifecycle.transition(snapshot);
          if (!current()) {
            clear();
          } else if (changed) {
            cancelRefresh();
            clearBackups();
            resetDesktopSetup();
            telemetry.clear();
            if (snapshot.phase === "connected") {
              void refresh();
            }
          }
          if (!hasOperatorReadAccess(snapshot.hello?.auth ?? null)) {
            clearBackups(t("systems.backups.readAccessRequired"));
          }
          notify();
        }),
        context.gateway.subscribeEvents((event) => {
          if (event.event === "config.changed") {
            cancelBackups();
            storageProbes.clear();
          }
          if (
            event.event === "presence" ||
            event.event === "node.pair.resolved" ||
            event.event === "node.runnerInventory.changed" ||
            event.event === "config.changed"
          ) {
            void refresh();
          } else if (
            event.event === "node.hostStats" &&
            isRecord(event.payload) &&
            typeof event.payload.nodeId === "string" &&
            state.selectedId === `node:${event.payload.nodeId}`
          ) {
            void refreshTelemetry();
          }
        }),
        // Rebuild session-to-machine bindings synchronously for selection, telemetry, and shared inventory readers.
        context.sessions.subscribe(() => {
          projectRows();
          notify();
          const next = placementSignature(context.sessions.state.result?.sessions ?? []);
          if (next !== placements) {
            placements = next;
            void refresh();
          }
        }),
      ];
      if (lifecycle.transition(context.gateway.snapshot)) {
        telemetry.clear();
      }
      if (!current()) {
        clear();
      } else {
        void refresh();
      }
    },
    refresh,
    refreshTelemetry,
    enableHostDesktop,
    refreshBackups: () => readBackupState(),
    probeStorage: (name: string) => readBackupState(name),
    subscribe: listeners.subscribe,
  };
}

export type SystemsRouteData = { controller: Systems };
