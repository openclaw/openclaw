import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createSignal, latest, onSettled } from "solid-js";
import { GATEWAY_EVENT_DEVICE_PAIR_CHANGED } from "../../../../src/gateway/events.js";
import type { PresenceEntry } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import {
  hasOperatorAdminAccess,
  hasOperatorPairingAccess,
  hasOperatorReadAccess,
} from "../../app/operator-access.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { LearnMoreLink } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { presenceConnectivitySignature } from "../../lib/nodes/inventory.ts";
import {
  approveDevicePairing,
  approveNodePairingRequest,
  createInitialDevicesState,
  loadDevices,
  loadExecApprovals,
  loadNodes,
  removeExecApprovalsFormValue,
  rotateDeviceToken,
  saveExecApprovals,
  updateExecApprovalsFormValue,
  type ExecApprovalsTarget,
  type DevicesPageDataState,
} from "../../lib/nodes/page-operations.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage, type GatewayPageChange } from "../../lib/reactive/gateway-page.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { projectMutableSource } from "../../lib/reactive/projection.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { canReadSystemInfo, readSystemInfo } from "../../lib/system-info.ts";
import { createDevicesDialogs } from "./devices-dialogs.ts";
import { createInventoryPresentation } from "./devices-inventory-presentation.ts";
import { createDevicePolicyActions } from "./devices-policy-actions.ts";
import { createDevicePolicyReads } from "./devices-policy-reads.ts";
import {
  createDeviceInventoryRead,
  type InventoryReadReceipt,
} from "./view-inventory-readiness.tsx";
import { DevicesView } from "./view.tsx";
import type { DevicesProps, DevicesRouteData } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

export function DevicesPage(props: { routeData?: DevicesRouteData }) {
  const context = useApplication();
  const [presence, setPresence] = createSignal<PresenceEntry[]>([], { ownedWrite: true });
  const [gatewaySystemInfo, setGatewaySystemInfo] = createSignal<SystemInfoResult | null>(null, {
    ownedWrite: true,
  });
  const [desktopEnvironments, setDesktopEnvironments] = createSignal<EnvironmentSummary[]>([], {
    ownedWrite: true,
  });
  // Event admission compares against the latest delivery, before Solid's next flush.
  let connectivitySignature = presenceConnectivitySignature([]);
  function updatePresence(entries: PresenceEntry[]) {
    const signature = presenceConnectivitySignature(entries);
    const connectivityChanged = signature !== connectivitySignature;
    connectivitySignature = signature;
    setPresence(entries);
    return connectivityChanged;
  }
  let systemInfoUnavailable = false;
  let dataState = createInitialDevicesState();
  const [nodesRead, setNodesRead] = createSignal<InventoryReadReceipt | null>(null);
  const [devicesRead, setDevicesRead] = createSignal<InventoryReadReceipt | null>(null);
  let canManagePairing = false;
  let canAdmin = false;
  let canRead = true;
  let configGateway: ApplicationContext["gateway"] | null = null;
  let configClient: ApplicationGatewaySnapshot["client"] = null;
  let execApprovalsTarget: "gateway" | "node" = "gateway";
  let execApprovalsTargetNodeId: string | null = null;
  let routeDataInitialized = false;
  let stopGatewayEvents: (() => void) | undefined;
  let publishData = () => {};
  // Request admission and policy drafts retain their synchronous mutation contract.
  const pageData = projectMutableSource(
    () => dataState,
    (readState) => readState(),
  );
  publishData = pageData.publish;
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const dialogs = createDevicesDialogs({
    canManagePairing: () => gatewayBinding.connected && canManagePairing,
    gatewayConnected: () => gatewayBinding.connected,
    gatewayClient: () => gatewayBinding.client,
    gatewayUrl: () => context.gateway.connection.gatewayUrl,
    runPageTask,
    runInventoryTask,
    rotateDevice: (params) =>
      inventoryActions.run(() => runPageTask((pageState) => rotateDeviceToken(pageState, params)))
        .result,
    setDevicesError: (message) => {
      dataState.devicesError = message;
      publishData();
    },
  });
  const presenceTask = createPageRequest(() => {}, {
    task: async (_args: void, { signal }) =>
      gatewayBinding.connected && canRead && gatewayBinding.gateway
        ? gatewayBinding.client?.request<PresenceEntry[]>("system-presence", {}, { signal })
        : undefined,
    onComplete: (entries) => {
      if (entries !== undefined) {
        updatePresence(entries);
      }
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        updatePresence([]);
      }
    },
  });
  const systemInfoTask = createPageRequest(() => {}, {
    task: async (_args: void, { signal }) =>
      gatewayBinding.gateway && canLoadSystemInfo() && gatewayBinding.client
        ? readSystemInfo(gatewayBinding.gateway, signal).then((sample) => sample.value)
        : undefined,
    onComplete: (result) => {
      if (result === undefined) {
        return;
      }
      setGatewaySystemInfo(result);
      // Quiet node reloads also fetch stats; a fresh snapshot restarts the periodic deadline.
      systemInfoPolling.stop();
      systemInfoPolling.start();
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        setGatewaySystemInfo(null);
        systemInfoUnavailable = true;
        systemInfoPolling.stop();
      }
    },
  });
  const environmentsTask = createPageRequest(() => {}, {
    task: async (_args: void, { signal }) =>
      gatewayBinding.gateway && canLoadDesktopEnvironments()
        ? gatewayBinding.client?.request<EnvironmentsListResult>(
            "environments.list",
            {},
            { signal },
          )
        : undefined,
    onComplete: (result) => {
      if (result !== undefined) {
        setDesktopEnvironments(result.environments);
      }
    },
    onError: () => setDesktopEnvironments([]),
  });
  const systemInfoPolling = useVisiblePoll(60_000, refreshSystemInfo);
  const polling = useVisiblePoll(30_000, () => {
    refreshNodeInventory(true);
    if (canManagePairing) {
      void refreshDeviceInventory(true);
    }
  });
  const gatewayBinding = useGatewayPage({
    // Replacement authority must advance while the old save presentation is held.
    getGateway: () => latest(() => context.gateway),
    onIdentityChange: (change) => {
      configGateway = null;
      configClient = null;
      resetServerState(change.snapshot);
    },
    invalidateRequests,
    onSnapshot: handleGatewaySnapshot,
    ensureInitialData,
  });
  const policyReads = createDevicePolicyReads({
    state: pageData.read,
    config: () => configProjection.read().state,
    hasConfig: () => bindingConfig(configRead().state) !== null,
    gateway: gatewayBinding,
    target: () => `${execApprovalsTarget}:${execApprovalsTargetNodeId ?? ""}`,
  });
  const approvalsSnapshot = createMemo(() => pageData.read().execApprovalsSnapshot);
  const configRead = createMemo(() => configProjection.read());
  const policyActions = createDevicePolicyActions({
    scope: () => ({
      state: pageData.read(),
      gateway: gatewayBinding.gateway,
      epoch: gatewayBinding.epoch,
      target: execApprovalsTarget === "node" ? execApprovalsTargetNodeId : null,
    }),
    canSave: () => canAdmin && gatewayBinding.connected,
    canEdit: () => canAdmin,
    runtimeConfig: () => context.runtimeConfig,
    isCurrent: (view) =>
      view.state === dataState &&
      view.gateway === context.gateway &&
      view.epoch === gatewayBinding.readEpoch(),
    read: (kind) => (kind === "bindings" ? configRead : approvalsSnapshot),
    run: (kind) =>
      kind === "bindings"
        ? context.runtimeConfig.save()
        : runPageTask((pageState) => saveExecApprovals(pageState, resolveExecApprovalsTarget())),
    publish: () => publishData(),
  });
  const { scope: inventoryScope, read: inventoryRead } = createDeviceInventoryRead({
    scope: () => ({
      gateway: context.gateway,
      state: pageData.read(),
      epoch: gatewayBinding.epoch,
    }),
    nodesRead,
    devicesRead,
  });
  const inventoryActions = createInventoryPresentation({
    scope: inventoryScope,
    isCurrent: (scope) =>
      scope.gateway === context.gateway &&
      scope.state === dataState &&
      scope.epoch === gatewayBinding.epoch,
    read: inventoryRead,
    publish: () => publishData(),
  });
  function runInventoryTask(task: (pageState: DevicesPageDataState) => unknown) {
    return inventoryActions.run(() => runPageTask(task)).presented;
  }
  onSettled(() => {
    syncConfigCustody();
    // Config receipts record which connection owns the accepted policy draft.
    const stopConfig = configProjection.subscribe(syncConfigCustody);
    const stopRoute = context.router.subscribe(() => {
      inventoryActions.retire();
      const route = context.router.getState();
      if ((route.pendingMatches[0] ?? route.matches[0])?.routeId !== "devices") {
        policyActions.retire();
      }
    });
    return () => {
      policyActions.retire();
      inventoryActions.retire();
      stopRoute();
      stopConfig();
      stopGatewayEvents?.();
      dialogs.cancel();
      presenceTask.cancel();
      systemInfoTask.cancel();
      environmentsTask.cancel();
      canManagePairing = false;
      canAdmin = false;
    };
  });

  function setRouteData(data: DevicesRouteData | undefined) {
    applyRouteData(data);
    ensureInitialData();
    publishData();
  }

  function syncConfigCustody() {
    if (currentConfigObject(context.runtimeConfig.state)) {
      configGateway = gatewayBinding.gateway;
      configClient = gatewayBinding.client;
    }
  }

  function handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    dataState.client = snapshot.client;
    dataState.connected = snapshot.phase === "connected";
    dataState.requestGeneration = gatewayBinding.epoch;
    const connected = snapshot.phase === "connected";
    if (change.becameConnected) {
      systemInfoUnavailable = false;
    }
    syncAccess(snapshot);
    syncConfigCustody();
    if (change.initial || change.sourceChanged) {
      stopGatewayEvents?.();
      const gateway = context.gateway;
      stopGatewayEvents = gateway.subscribeEvents((event) => {
        if (gatewayBinding.gateway !== gateway || context.gateway !== gateway) {
          return;
        }
        const entries = event.event === "presence" ? readPresenceEntries(event.payload) : null;
        if (entries && canRead) {
          presenceTask.cancel();
          if (updatePresence(entries)) {
            if (canManagePairing) {
              void refreshDeviceInventory(true);
            }
            refreshNodeInventory(true);
          }
        }
        if (
          event.event === GATEWAY_EVENT_DEVICE_PAIR_CHANGED ||
          event.event === "device.pair.requested" ||
          event.event === "device.pair.resolved"
        ) {
          if (canManagePairing) {
            void refreshDeviceInventory(true);
          }
        }
        if (
          event.event === "node.pair.requested" ||
          event.event === "node.pair.resolved" ||
          event.event === "node.runnerInventory.changed" ||
          event.event === "node.hostStats"
        ) {
          refreshNodeInventory(true);
        }
      });
    }
    if (change.identityChanged) {
      clearInventorySamples();
    }
    if (connected && !canLoadSystemInfo()) {
      systemInfoTask.cancel();
      setGatewaySystemInfo(null);
    }
    if (connected && !canLoadDesktopEnvironments()) {
      environmentsTask.cancel();
      setDesktopEnvironments([]);
    }
    if (
      routeDataInitialized &&
      snapshot.phase === "connected" &&
      snapshot.client &&
      (change.identityChanged || change.connectionChanged)
    ) {
      const initialPresence = readPresenceEntries(snapshot.hello?.snapshot);
      if (initialPresence && canRead) {
        updatePresence(initialPresence);
      }
      void presenceTask.run();
      refreshNodeInventory(true);
      if (canManagePairing) {
        void refreshDeviceInventory(true);
      }
    }
    if (change.initial || change.identityChanged || change.connectionChanged) {
      refreshSystemInfo();
      if (canLoadDesktopEnvironments()) {
        void environmentsTask.run();
      }
    }
    syncPolling();
    publishData();
  }

  function invalidateRequests() {
    policyActions.retire();
    inventoryActions.retire();
    dataState.requestGeneration = gatewayBinding.epoch;
    dataState.nodesLoading = false;
    dataState.nodesQueuedRefresh = "none";
    dataState.devicesLoading = false;
    dataState.devicesQueuedRefresh = "none";
    dataState.execApprovalsLoading = false;
    dataState.execApprovalsSaving = false;
    presenceTask.cancel();
    systemInfoTask.cancel();
    environmentsTask.cancel();
  }

  function syncAccess(snapshot: ApplicationGatewaySnapshot) {
    if (snapshot.phase !== "connected") {
      return;
    }
    const auth = snapshot.hello?.auth ?? null;
    const nextRead = hasOperatorReadAccess(auth);
    const nextAdmin = hasOperatorAdminAccess(auth);
    const nextPairing = !auth || hasOperatorPairingAccess(auth);
    if ((canRead && !nextRead) || (canAdmin && !nextAdmin) || (canManagePairing && !nextPairing)) {
      gatewayBinding.invalidate();
      invalidateRequests();
    }
    canRead = nextRead;
    canAdmin = nextAdmin;
    canManagePairing = nextPairing;
    if (!canRead) {
      dataState.nodes = [];
      clearInventorySamples();
    }
    if (!canManagePairing) {
      dataState.devicesList = null;
      dataState.devicesError = null;
      dialogs.cancel();
    }
    if (!canAdmin) {
      dataState.execApprovalsSnapshot = null;
      dataState.execApprovalsForm = null;
      dataState.execApprovalsDirty = false;
      dataState.execApprovalsSelectedAgent = null;
    }
  }

  function applyRouteData(data: DevicesRouteData | undefined) {
    if (!data) {
      return;
    }
    routeDataInitialized = true;
    const snapshot = context.gateway.snapshot;
    if (!gatewayBinding.isRouteDataCurrent(data)) {
      resetServerState(snapshot);
      syncAccess(snapshot);
      clearInventorySamples();
      if (canRead) {
        updatePresence(readPresenceEntries(snapshot.hello?.snapshot) ?? []);
      }
      void presenceTask.run();
      return;
    }
    policyActions.retire();
    dataState = {
      ...data.devices,
      client: snapshot.client,
      connected: snapshot.phase === "connected",
      requestGeneration: gatewayBinding.epoch,
    };
    syncAccess(snapshot);
    const initialPresence = readPresenceEntries(snapshot.hello?.snapshot);
    if (initialPresence && canRead) {
      updatePresence(initialPresence);
    }
    void presenceTask.run();
  }

  function resetServerState(snapshot: ApplicationGatewaySnapshot) {
    policyActions.retire();
    inventoryActions.retire();
    dialogs.cancel();
    dataState.requestGeneration += 1;
    const next = createInitialDevicesState({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
    next.requestGeneration = gatewayBinding.epoch;
    dataState = next;
    presenceTask.cancel();
    systemInfoTask.cancel();
    environmentsTask.cancel();
    systemInfoPolling.stop();
    systemInfoUnavailable = false;
    canRead = false;
    canAdmin = false;
    canManagePairing = false;
    execApprovalsTarget = "gateway";
    execApprovalsTargetNodeId = null;
  }

  async function runPageTask<T>(
    task: (pageState: DevicesPageDataState) => T | Promise<T>,
  ): Promise<T> {
    const pageState = dataState;
    try {
      const result = task(pageState);
      if (dataState === pageState) {
        publishData();
      }
      return await result;
    } finally {
      if (dataState === pageState) {
        publishData();
      }
    }
  }

  function runAdminTask(task: (pageState: DevicesPageDataState) => unknown) {
    if (canAdmin) {
      void runPageTask(task);
    }
  }

  function ensureInitialData() {
    const pageState = dataState;
    if (!pageState.connected || !pageState.client || !routeDataInitialized) {
      return;
    }
    if (canRead && !pageState.nodes.length && !pageState.nodesLoading) {
      refreshNodeInventory();
    }
    if (canManagePairing && !pageState.devicesList && !pageState.devicesLoading) {
      void refreshDeviceInventory();
    }
    const config = context.runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void context.runtimeConfig.refresh();
    }
    if (canAdmin && !pageState.execApprovalsSnapshot && !pageState.execApprovalsLoading) {
      refreshExecApprovals();
    }
  }

  function syncPolling() {
    if (canLoadSystemInfo()) {
      systemInfoPolling.start();
    } else {
      systemInfoPolling.stop();
    }
    if (gatewayBinding.connected && gatewayBinding.client && canRead) {
      polling.start();
      return;
    }
    polling.stop();
  }

  function canLoadSystemInfo(): boolean {
    const snapshot = gatewayBinding.snapshot;
    return gatewayBinding.connected && !systemInfoUnavailable && canReadSystemInfo(snapshot);
  }

  function canLoadDesktopEnvironments(): boolean {
    const snapshot = gatewayBinding.snapshot;
    return gatewayBinding.connected && Boolean(snapshot && isDesktopPanelAvailable(snapshot));
  }

  function refreshSystemInfo() {
    if (canLoadSystemInfo() && !systemInfoTask.pending) {
      void systemInfoTask.run();
    }
  }

  function readInventory(kind: "nodes" | "devices", quiet: boolean) {
    const gateway = context.gateway;
    const state = dataState;
    const epoch = gatewayBinding.epoch;
    const queued = kind === "nodes" ? state.nodesLoading : state.devicesLoading;
    const result = runPageTask((current) =>
      kind === "nodes" ? loadNodes(current, { quiet }) : loadDevices(current, { quiet }),
    );
    // The first promise includes trailing refreshes; queued callers resolve before that drain.
    if (!queued) {
      const receipt = { gateway, state, epoch, result };
      (kind === "nodes" ? setNodesRead : setDevicesRead)(receipt);
    }
    return result;
  }

  function refreshDeviceInventory(quiet = false) {
    return readInventory("devices", quiet);
  }

  function refreshNodeInventory(quiet = false) {
    if (!canRead) {
      return;
    }
    refreshSystemInfo();
    if (canLoadDesktopEnvironments() && !environmentsTask.pending) {
      void environmentsTask.run();
    }
    void readInventory("nodes", quiet);
  }

  function clearInventorySamples() {
    // Binding disposal also resets request state; only live snapshots publish samples.
    updatePresence([]);
    setGatewaySystemInfo(null);
    setDesktopEnvironments([]);
  }

  // Confirm before discarding a target's dirty draft. Cancellation retains the target, form,
  // scope, and dirty flag; rendering restores the selector to that retained target.
  async function changeExecApprovalsTarget(kind: "gateway" | "node", nodeId: string | null) {
    const devices = dataState;
    if (devices.execApprovalsDirty && !(await dialogs.confirmExecApprovalsDiscard())) {
      publishData();
      return;
    }
    if (dataState !== devices) {
      return;
    }
    policyActions.retire();
    execApprovalsTarget = kind;
    execApprovalsTargetNodeId = nodeId;
    devices.execApprovalsSnapshot = null;
    devices.execApprovalsForm = null;
    devices.execApprovalsDirty = false;
    devices.execApprovalsSelectedAgent = null;
    publishData();
  }

  function resolveExecApprovalsTarget(): ExecApprovalsTarget {
    return execApprovalsTarget === "node" && execApprovalsTargetNodeId
      ? { kind: "node", nodeId: execApprovalsTargetNodeId }
      : { kind: "gateway" };
  }

  function refreshExecApprovals() {
    if (!canAdmin || dataState.execApprovalsLoading) {
      return;
    }
    const state = dataState;
    const result = runPageTask((current) =>
      loadExecApprovals(current, resolveExecApprovalsTarget()),
    );
    policyReads.observeApprovals(state, result);
  }

  function bindingConfig(config: ReturnType<typeof configRead>["state"]) {
    return canRead
      ? (currentConfigObject(config) ??
          (configGateway === gatewayBinding.gateway && configClient === gatewayBinding.client
            ? config.configForm
            : null))
      : null;
  }

  function viewProps(): DevicesProps {
    const devices = pageData.read();
    const config = configRead().state;
    const gatewaySnapshot = gatewayBinding.snapshot ?? context.gateway.snapshot;
    return {
      configRead: policyReads.config,
      execApprovalsRead: policyReads.approvals,
      loading: devices.nodesLoading,
      inventoryRead,
      inventoryScope: inventoryScope(),
      onReloadInventory: () => {
        refreshNodeInventory();
        if (canManagePairing) {
          void refreshDeviceInventory();
        }
      },
      connected: gatewayBinding.connected,
      nodes: devices.nodes,
      presence: presence(),
      gatewayVersion: gatewaySnapshot.hello?.server?.version?.trim() || null,
      basePath: context.basePath,
      gatewaySystemInfo: gatewaySystemInfo(),
      desktopEnvironments: desktopEnvironments(),
      lastError: devices.lastError,
      devicesLoading: devices.devicesLoading,
      devicesError: devices.devicesError,
      devicesList: devices.devicesList,
      canPairDevice: canAdmin,
      canManagePairing,
      canAdmin,
      configForm: bindingConfig(config),
      configLoading: config.configLoading,
      configSaving: config.configSaving,
      configDirty: config.configFormDirty,
      configFormMode: config.configFormMode,
      execApprovalsLoading: devices.execApprovalsLoading,
      execApprovalsSaving: devices.execApprovalsSaving,
      execApprovalsDirty: devices.execApprovalsDirty,
      execApprovalsSnapshot: approvalsSnapshot(),
      execApprovalsForm: devices.execApprovalsForm,
      execApprovalsSelectedAgent: devices.execApprovalsSelectedAgent,
      execApprovalsTarget,
      execApprovalsTargetNodeId,
      onDevicePairSetupOpen: () => {
        if (canAdmin && gatewayBinding.connected) {
          void context.overlays.openDevicePairSetup();
        }
      },
      onDeviceApprove: (requestId) => {
        if (canManagePairing) {
          void runInventoryTask((pageState) => approveDevicePairing(pageState, requestId));
        }
      },
      onDeviceReject: (requestId) => void dialogs.confirmPairingReject("device", requestId),
      onNodeApprove: (requestId) => {
        if (canManagePairing) {
          void runInventoryTask((pageState) => approveNodePairingRequest(pageState, requestId));
        }
      },
      onNodeReject: (requestId) => void dialogs.confirmPairingReject("node", requestId),
      onInventoryRemove: (entry) => void dialogs.confirmInventoryRemoval({ kind: "entry", entry }),
      onInventoryCleanup: (entries) => {
        if (entries.length > 0) {
          void dialogs.confirmInventoryRemoval({ kind: "stale", entries });
        }
      },
      onDeviceRotate: (device, role, scopes) =>
        void dialogs.reportRotationOutcome(device, role, scopes),
      onDeviceRevoke: (deviceId, role) => void dialogs.confirmTokenRevoke(deviceId, role),
      onDeviceRename: (device) => void dialogs.editAlias(device),
      onLoadConfig: () => void context.runtimeConfig.discardDraft({ reloadOnly: true }),
      onLoadExecApprovals: refreshExecApprovals,
      onBindDefault: (nodeId) => policyActions.bindNode(nodeId),
      onBindAgent: (agentId, nodeId) => policyActions.bindNode(nodeId, agentId),
      onSaveBindings: () => void policyActions.save("bindings"),
      onExecApprovalsTargetChange: (kind, nodeId) => void changeExecApprovalsTarget(kind, nodeId),
      onExecApprovalsSelectAgent: (agentId) => {
        devices.execApprovalsSelectedAgent = agentId;
        publishData();
      },
      onExecApprovalsPatch: (path, value) =>
        runAdminTask((pageState) => updateExecApprovalsFormValue(pageState, path, value)),
      onExecApprovalsRemove: (path) =>
        runAdminTask((pageState) => removeExecApprovalsFormValue(pageState, path)),
      onSaveExecApprovals: () => void policyActions.save("approvals"),
    };
  }

  const view = createMemo(viewProps);
  createEffect(
    createMemo(() => props.routeData),
    // Receipt adoption samples live admission; useGatewayPage owns Gateway observation.
    setRouteData,
  );
  return (
    <openclaw-devices-page>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <div>
            <h1 class="page-title">{titleForRoute("devices", t)}</h1>
            <div class="page-subtitle">
              {subtitleForRoute("devices", t)}{" "}
              <LearnMoreLink url={"https://docs.openclaw.ai/nodes"} />
            </div>
          </div>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        <DevicesView
          {...view()}
          inventorySaving={inventoryActions.saving()}
          configSaving={policyActions.configSaving() || view().configSaving}
          execApprovalsSaving={policyActions.approvalsSaving() || view().execApprovalsSaving}
        />
      </SettingsWorkspace>
    </openclaw-devices-page>
  );
}
