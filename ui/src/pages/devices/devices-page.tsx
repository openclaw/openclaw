import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { GATEWAY_EVENT_DEVICE_PAIR_CHANGED } from "../../../../src/gateway/events.js";
import type { PresenceEntry } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { showSecretRevealDialog } from "../../components/secret-reveal-dialog.tsx";
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
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage, type GatewayPageChange } from "../../lib/reactive/gateway-page.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { canReadSystemInfo, readSystemInfo } from "../../lib/system-info.ts";
import { createDevicesDialogs } from "./devices-dialogs.ts";
import { createPageRequest } from "./page-request.ts";
import { DevicesView } from "./view.tsx";
import type { DevicesProps } from "./view.types.ts";

registerEnglishCatalog(registerDevicesEnglish);

const DEVICES_DOCS_URL = "https://docs.openclaw.ai/nodes";

export type DevicesRouteData = {
  // Client identity alone cannot distinguish provider replacement or reconnect epochs.
  gateway: ApplicationContext["gateway"];
  gatewaySnapshot: ApplicationGatewaySnapshot;
  devices: DevicesPageDataState;
};

const DEVICES_ACTIVE_POLL_INTERVAL_MS = 30_000;
const SYSTEM_INFO_POLL_INTERVAL_MS = 60_000;

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
  let canManagePairing = false;
  let canAdmin = false;
  let execApprovalsTarget: "gateway" | "node" = "gateway";
  let execApprovalsTargetNodeId: string | null = null;
  let routeDataInitialized = false;
  let publishData = () => {};
  // Request admission and policy drafts retain their synchronous mutation contract.
  const pageData = projectSource(() => dataState, {
    read: (readState) => readState(),
    subscribe: (_source, notify) => {
      publishData = notify;
      return () => {
        publishData = () => {};
      };
    },
    equality: "revision",
  });
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const dialogs = createDevicesDialogs({
    canManagePairing: () => canManagePairing,
    gatewayConnected: () => gatewayBinding.connected,
    requestGeneration: () => dataState.requestGeneration,
    gatewayClient: () => gatewayBinding.client,
    gatewayUrl: () => context.gateway.connection.gatewayUrl,
    runPageTask,
    setDevicesError: (message) => {
      dataState.devicesError = message;
      publishData();
    },
  });
  const presenceTask = createPageRequest({
    task: (signal) =>
      gatewayBinding.connected && gatewayBinding.gateway
        ? gatewayBinding.client?.request<PresenceEntry[]>("system-presence", {}, { signal })
        : undefined,
    onComplete: updatePresence,
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        updatePresence([]);
      }
    },
  });
  const systemInfoTask = createPageRequest({
    task: (signal) =>
      gatewayBinding.gateway && canLoadSystemInfo() && gatewayBinding.client
        ? readSystemInfo(gatewayBinding.gateway, signal).then((sample) => sample.value)
        : undefined,
    onComplete: (result) => {
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
  const environmentsTask = createPageRequest({
    task: (signal) =>
      gatewayBinding.gateway && canLoadDesktopEnvironments()
        ? gatewayBinding.client?.request<EnvironmentsListResult>(
            "environments.list",
            {},
            { signal },
          )
        : undefined,
    onComplete: (result) => setDesktopEnvironments(result.environments),
    onError: () => setDesktopEnvironments([]),
  });
  const systemInfoPolling = useVisiblePoll(SYSTEM_INFO_POLL_INTERVAL_MS, refreshSystemInfo);
  const polling = useVisiblePoll(DEVICES_ACTIVE_POLL_INTERVAL_MS, () => {
    refreshNodeInventory(true);
    if (canManagePairing) {
      void runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
    }
  });
  const gatewayBinding = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: (change) => resetServerState(change.snapshot),
    invalidateRequests: (change) => {
      dataState.requestGeneration = gatewayBinding.epoch;
      if (!change.identityChanged && change.snapshot.phase !== "connected") {
        resetServerState(change.snapshot);
      }
      presenceTask.cancel();
    },
    onSnapshot: handleGatewaySnapshot,
    ensureInitialData,
  });
  // Gateway events refresh pairing and presence inventory within the bound request generation.
  createEffect(
    () => context.gateway,
    (gateway) =>
      gateway.subscribeEvents((event) => {
        if (gatewayBinding.gateway !== gateway || context.gateway !== gateway) {
          return;
        }
        const entries = event.event === "presence" ? readPresenceEntries(event.payload) : null;
        if (entries) {
          presenceTask.cancel();
          if (updatePresence(entries)) {
            if (canManagePairing) {
              void runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
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
            void runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
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
      }),
  );
  onCleanup(() => {
    dialogs.cancel();
    presenceTask.cancel();
    systemInfoTask.cancel();
    environmentsTask.cancel();
    canManagePairing = false;
    canAdmin = false;
  });

  function setRouteData(data: DevicesRouteData | undefined) {
    applyRouteData(data);
    ensureInitialData();
    publishData();
  }

  function handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    dataState.client = snapshot.client;
    dataState.connected = snapshot.phase === "connected";
    dataState.requestGeneration = gatewayBinding.epoch;
    const connected = snapshot.phase === "connected";
    const auth = snapshot.hello?.auth ?? null;
    canAdmin = connected && hasOperatorAdminAccess(auth);
    canManagePairing = connected && (!auth || hasOperatorPairingAccess(auth));
    if (change.identityChanged || !connected) {
      clearInventorySamples();
    }
    if (!canLoadSystemInfo()) {
      systemInfoTask.cancel();
      setGatewaySystemInfo(null);
    }
    if (!canLoadDesktopEnvironments()) {
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
      updatePresence(initialPresence ?? []);
      void presenceTask.run();
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

  function applyRouteData(data: DevicesRouteData | undefined) {
    if (!data) {
      return;
    }
    routeDataInitialized = true;
    const snapshot = context.gateway.snapshot;
    if (!gatewayBinding.isRouteDataCurrent(data)) {
      resetServerState(snapshot);
      clearInventorySamples();
      updatePresence(readPresenceEntries(snapshot.hello?.snapshot) ?? []);
      void presenceTask.run();
      return;
    }
    dataState = {
      ...data.devices,
      client: snapshot.client,
      connected: snapshot.phase === "connected",
      requestGeneration: gatewayBinding.epoch,
    };
    const initialPresence = readPresenceEntries(snapshot.hello?.snapshot);
    if (initialPresence) {
      updatePresence(initialPresence);
    }
    void presenceTask.run();
  }

  function resetServerState(snapshot: ApplicationGatewaySnapshot) {
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

  function bindNode(nodeId: string | null, agentId?: string) {
    if (!canAdmin) {
      return;
    }
    const config = context.runtimeConfig;
    const target =
      agentId === undefined
        ? { path: [] }
        : config.agentEntry(agentId, { ensure: Boolean(nodeId) });
    if (!target) {
      return;
    }
    const path = [...target.path, "tools", "exec", "node"];
    if (nodeId) {
      config.patchForm(path, nodeId);
    } else {
      config.removeFormValue(path);
    }
  }

  function ensureInitialData() {
    const pageState = dataState;
    if (!pageState.connected || !pageState.client || !routeDataInitialized) {
      return;
    }
    if (!pageState.nodes.length && !pageState.nodesLoading) {
      refreshNodeInventory();
    }
    if (canManagePairing && !pageState.devicesList && !pageState.devicesLoading) {
      void runPageTask((current) => loadDevices(current));
    }
    const config = context.runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void context.runtimeConfig.refresh();
    }
    if (canAdmin && !pageState.execApprovalsSnapshot && !pageState.execApprovalsLoading) {
      void runPageTask((current) => loadExecApprovals(current, resolveExecApprovalsTarget()));
    }
  }

  function syncPolling() {
    if (canLoadSystemInfo()) {
      systemInfoPolling.start();
    } else {
      systemInfoPolling.stop();
    }
    if (gatewayBinding.connected && gatewayBinding.client) {
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

  function refreshNodeInventory(quiet = false) {
    refreshSystemInfo();
    if (canLoadDesktopEnvironments() && !environmentsTask.pending) {
      void environmentsTask.run();
    }
    void runPageTask((pageState) => loadNodes(pageState, { quiet }));
  }

  function clearInventorySamples() {
    // Binding disposal also resets request state; only live snapshots publish samples.
    updatePresence([]);
    setGatewaySystemInfo(null);
    setDesktopEnvironments([]);
  }

  // A rotation always ends in a dialog: with the replacement when the Gateway issued it
  // to this operator, otherwise with what it did instead. The reveal sits deliberately
  // outside the confirmation slot, which a reconnect aborts — aborting a shown secret
  // would destroy the only copy the Gateway can hand out.
  async function reportRotationOutcome(
    device: { id: string; name: string },
    role: string,
    scopes?: string[],
  ) {
    if (!canManagePairing) {
      return;
    }
    const outcome = await runPageTask((pageState) =>
      rotateDeviceToken(pageState, {
        deviceId: device.id,
        gatewayUrl: context.gateway.connection.gatewayUrl,
        role,
        scopes,
      }),
    );
    if (!outcome) {
      return;
    }
    await (outcome.delivery === "in-band"
      ? showSecretRevealDialog({
          title: t("devices.inventory.rotatePromptTitle", { role }),
          message: t("devices.inventory.rotatePromptBody"),
          secret: outcome.token,
          acknowledgeLabel: t("devices.inventory.rotateAcknowledge"),
          dismissHint: t("devices.inventory.rotateDismissHint"),
        })
      : showSecretRevealDialog({
          // The title carries the announcement and the device, so the body is only the
          // reassurance. Naming the transient disconnect here would raise an alarm the
          // very next line has to walk back.
          title: t("devices.inventory.rotateWithheldTitle", { device: device.name }),
          status: "success",
          message: t("devices.inventory.rotateWithheldNext"),
          callout: t("devices.inventory.rotateWithheldException"),
          acknowledgeLabel: t("common.close"),
          note: t("devices.inventory.rotateWithheldNote"),
        }));
  }

  // Retargeting discards the draft for the target being left, so a dirty form
  // asks first. Cancelling restores nothing because nothing is written until the
  // operator confirms: the target, the form, the scope and the dirty flag are
  // still the ones the selector was rendered from, and the re-render puts the
  // selector itself back on that target.
  async function changeExecApprovalsTarget(kind: "gateway" | "node", nodeId: string | null) {
    const devices = dataState;
    if (devices.execApprovalsDirty && !(await dialogs.confirmExecApprovalsDiscard())) {
      publishData();
      return;
    }
    if (dataState !== devices) {
      return;
    }
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

  function viewProps(): DevicesProps {
    const devices = pageData.read();
    const config = configProjection.read().state;
    const gatewaySnapshot = gatewayBinding.snapshot ?? context.gateway.snapshot;
    const gatewayVersion =
      gatewaySnapshot.phase === "connected"
        ? gatewaySnapshot.hello?.server?.version?.trim() || null
        : null;
    return {
      loading: devices.nodesLoading,
      nodes: devices.nodes,
      presence: presence(),
      gatewayVersion,
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
      configForm: currentConfigObject(config),
      configLoading: config.configLoading,
      configSaving: config.configSaving,
      configDirty: config.configFormDirty,
      configFormMode: config.configFormMode,
      execApprovalsLoading: devices.execApprovalsLoading,
      execApprovalsSaving: devices.execApprovalsSaving,
      execApprovalsDirty: devices.execApprovalsDirty,
      execApprovalsSnapshot: devices.execApprovalsSnapshot,
      execApprovalsForm: devices.execApprovalsForm,
      execApprovalsSelectedAgent: devices.execApprovalsSelectedAgent,
      execApprovalsTarget,
      execApprovalsTargetNodeId,
      onDevicePairSetupOpen: () => {
        if (canAdmin) {
          void context.overlays.openDevicePairSetup();
        }
      },
      onDeviceApprove: (requestId) => {
        if (canManagePairing) {
          void runPageTask((pageState) => approveDevicePairing(pageState, requestId));
        }
      },
      onDeviceReject: (requestId) => void dialogs.confirmPairingReject("device", requestId),
      onNodeApprove: (requestId) => {
        if (canManagePairing) {
          void runPageTask((pageState) => approveNodePairingRequest(pageState, requestId));
        }
      },
      onNodeReject: (requestId) => void dialogs.confirmPairingReject("node", requestId),
      onInventoryRemove: (entry) => void dialogs.confirmInventoryRemoval({ kind: "entry", entry }),
      onInventoryCleanup: (entries) => {
        if (entries.length > 0) {
          void dialogs.confirmInventoryRemoval({ kind: "stale", entries });
        }
      },
      onDeviceRotate: (device, role, scopes) => void reportRotationOutcome(device, role, scopes),
      onDeviceRevoke: (deviceId, role) => void dialogs.confirmTokenRevoke(deviceId, role),
      onDeviceRename: (device) => void dialogs.editAlias(device),
      onLoadConfig: () => void context.runtimeConfig.discardDraft({ reloadOnly: true }),
      onLoadExecApprovals: () =>
        runAdminTask((pageState) => loadExecApprovals(pageState, resolveExecApprovalsTarget())),
      onBindDefault: (nodeId) => bindNode(nodeId),
      onBindAgent: (agentId, nodeId) => bindNode(nodeId, agentId),
      onSaveBindings: () => {
        if (canAdmin) {
          void context.runtimeConfig.save();
        }
      },
      onExecApprovalsTargetChange: (kind, nodeId) => void changeExecApprovalsTarget(kind, nodeId),
      onExecApprovalsSelectAgent: (agentId) => {
        devices.execApprovalsSelectedAgent = agentId;
        publishData();
      },
      onExecApprovalsPatch: (path, value) =>
        runAdminTask((pageState) => updateExecApprovalsFormValue(pageState, path, value)),
      onExecApprovalsRemove: (path) =>
        runAdminTask((pageState) => removeExecApprovalsFormValue(pageState, path)),
      onSaveExecApprovals: () =>
        runAdminTask((pageState) => saveExecApprovals(pageState, resolveExecApprovalsTarget())),
    };
  }

  const view = createMemo(viewProps);
  createEffect(
    createMemo(() => props.routeData),
    // Receipt adoption samples live admission; useGatewayPage owns Gateway observation.
    (data) => untrack(() => setRouteData(data)),
  );
  return (
    <openclaw-devices-page>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header">
          <div>
            <div class="page-title">{titleForRoute("devices", t)}</div>
            <div class="page-subtitle">
              {subtitleForRoute("devices", t)} <LearnMoreLink url={DEVICES_DOCS_URL} />
            </div>
          </div>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        <DevicesView {...view()} />
      </SettingsWorkspace>
    </openclaw-devices-page>
  );
}
