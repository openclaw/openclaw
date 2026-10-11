import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  SystemInfoResult,
} from "@openclaw/gateway-protocol";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { GATEWAY_EVENT_DEVICE_PAIR_CHANGED } from "../../../../src/gateway/events.js";
import type { PresenceEntry } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context-types.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { readPresenceEntries } from "../../app/user-profile.ts";
import { showSecretRevealDialog } from "../../components/secret-reveal-dialog.ts";
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
import { useVisiblePoll } from "../../lib/reactive/visible-poll.ts";
import { canReadSystemInfo, readSystemInfo } from "../../lib/system-info.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { DevicesDialogController } from "./devices-dialogs.ts";
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

class DevicesPageController {
  constructor(
    public context: ApplicationContext,
    private readonly publish: () => void,
  ) {}

  presence: PresenceEntry[] = [];
  private gatewaySystemInfo: SystemInfoResult | null = null;
  private desktopEnvironments: EnvironmentSummary[] = [];
  private systemInfoUnavailable = false;
  private pageState = createInitialDevicesState();
  private canManagePairing = false;
  private canAdmin = false;
  private execApprovalsTarget: "gateway" | "node" = "gateway";
  private execApprovalsTargetNodeId: string | null = null;
  private readonly dialogs = new DevicesDialogController({
    canManagePairing: () => this.canManagePairing,
    gatewayConnected: () => this.gateway.connected,
    requestGeneration: () => this.requestGeneration,
    gatewayClient: () => this.gateway.client,
    gatewayUrl: () => this.context.gateway.connection.gatewayUrl,
    runPageTask: (task) => this.runPageTask(task),
    setDevicesError: (message) => {
      this.pageState.devicesError = message;
      // The controller writes outside the page's task cycle; the callout must
      // render without waiting for the next unrelated update.
      this.publish();
    },
  });

  private routeDataInitialized = false;
  gateway!: ReturnType<typeof useGatewayPage>;
  bindGateway() {
    this.gateway = useGatewayPage({
      getGateway: () => this.context.gateway,
      onIdentityChange: (change) => this.resetServerState(change.snapshot),
      invalidateRequests: (change) => {
        this.pageState.requestGeneration = this.gateway.epoch;
        if (!change.identityChanged && change.snapshot.phase !== "connected") {
          this.resetServerState(change.snapshot);
        }
        this.presenceTask.cancel();
      },
      onSnapshot: (change) => this.handleGatewaySnapshot(change),
      ensureInitialData: () => this.ensureInitialData(),
    });
  }
  private readonly presenceTask = createPageRequest({
    // Gateway identity invalidates same-client reconnects and source replacements.
    args: () =>
      [
        this.gateway.connected ? this.gateway.gateway : null,
        this.gateway.connected ? this.gateway.client : null,
      ] as const,
    task: ([gateway, client], { signal }) =>
      gateway && client ? client.request("system-presence", {}, { signal }) : undefined,
    onComplete: (response) => {
      if (Array.isArray(response)) {
        // SAFETY: system-presence returns listSystemPresence() rows conforming to PresenceEntry.
        this.presence = response as PresenceEntry[];
        this.publish();
      }
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        this.presence = [];
        this.publish();
      }
    },
  });
  private readonly systemInfoTask = createPageRequest({
    args: () =>
      [this.gateway.gateway, this.canLoadSystemInfo ? this.gateway.client : null] as const,
    task: ([gateway, client], { signal }) =>
      gateway && client
        ? readSystemInfo(gateway, signal).then((sample) => sample.value)
        : undefined,
    onComplete: (result) => {
      this.gatewaySystemInfo = result;
      // Quiet node reloads also fetch stats; a fresh snapshot restarts the periodic deadline.
      this.systemInfoPolling.stop();
      this.systemInfoPolling.start();
      this.publish();
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        this.gatewaySystemInfo = null;
        this.systemInfoUnavailable = true;
        this.systemInfoPolling.stop();
        this.publish();
      }
    },
  });
  private readonly environmentsTask = createPageRequest({
    args: () =>
      [this.gateway.gateway, this.canLoadDesktopEnvironments ? this.gateway.client : null] as const,
    task: ([gateway, client], { signal }) =>
      gateway && client
        ? client.request<EnvironmentsListResult>("environments.list", {}, { signal })
        : undefined,
    onComplete: (result) => {
      this.desktopEnvironments = result.environments;
      this.publish();
    },
    onError: () => {
      this.desktopEnvironments = [];
      this.publish();
    },
  });
  private systemInfoPolling!: ReturnType<typeof useVisiblePoll>;
  private polling!: ReturnType<typeof useVisiblePoll>;

  bindPolling() {
    this.systemInfoPolling = useVisiblePoll(SYSTEM_INFO_POLL_INTERVAL_MS, () =>
      this.refreshSystemInfo(),
    );
    this.polling = useVisiblePoll(DEVICES_ACTIVE_POLL_INTERVAL_MS, () => {
      this.refreshNodeInventory(true);
      if (this.canManagePairing) {
        void this.runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
      }
    });
  }
  bindEvents() {
    createEffect(
      () => this.context.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (this.gateway.gateway !== gateway || this.context.gateway !== gateway) {
            return;
          }
          const presence = event.event === "presence" ? readPresenceEntries(event.payload) : null;
          if (presence) {
            const connectivityChanged =
              presenceConnectivitySignature(presence) !==
              presenceConnectivitySignature(this.presence);
            this.presenceTask.cancel();
            this.presence = presence;
            this.publish();
            if (connectivityChanged) {
              if (this.canManagePairing) {
                void this.runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
              }
              this.refreshNodeInventory(true);
            }
          }
          if (
            event.event === GATEWAY_EVENT_DEVICE_PAIR_CHANGED ||
            event.event === "device.pair.requested" ||
            event.event === "device.pair.resolved"
          ) {
            if (this.canManagePairing) {
              void this.runPageTask((pageState) => loadDevices(pageState, { quiet: true }));
            }
          }
          if (
            event.event === "node.pair.requested" ||
            event.event === "node.pair.resolved" ||
            event.event === "node.runnerInventory.changed" ||
            event.event === "node.hostStats"
          ) {
            this.refreshNodeInventory(true);
          }
        }),
    );
  }

  dispose() {
    this.dialogs.cancel();
    this.presenceTask.cancel();
    this.resetInventoryDetails();
    this.presence = [];
    this.canManagePairing = false;
    this.canAdmin = false;
  }

  setRouteData(data: DevicesRouteData | undefined) {
    this.applyRouteData(data);
    this.ensureInitialData();
    this.publish();
  }

  get requestGeneration(): number {
    return this.pageState.requestGeneration;
  }

  private handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    this.pageState.client = snapshot.client;
    this.pageState.connected = snapshot.phase === "connected";
    this.pageState.requestGeneration = this.gateway.epoch;
    const connected = snapshot.phase === "connected";
    const auth = snapshot.hello?.auth ?? null;
    this.canAdmin = connected && hasOperatorAdminAccess(auth);
    this.canManagePairing = connected && (!auth || hasOperatorPairingAccess(auth));
    if (!this.canLoadSystemInfo) {
      this.systemInfoTask.cancel();
      this.gatewaySystemInfo = null;
    }
    if (!this.canLoadDesktopEnvironments) {
      this.environmentsTask.cancel();
      this.desktopEnvironments = [];
    }
    if (
      this.routeDataInitialized &&
      snapshot.phase === "connected" &&
      snapshot.client &&
      (change.identityChanged || change.connectionChanged)
    ) {
      const initialPresence = readPresenceEntries(snapshot.hello?.snapshot);
      this.presence = initialPresence ?? [];
      void this.loadPresence();
    }
    if (change.initial || change.identityChanged || change.connectionChanged) {
      this.refreshSystemInfo();
      if (this.canLoadDesktopEnvironments) {
        void this.environmentsTask.run();
      }
    }
    this.syncPolling();
    this.publish();
  }

  private applyRouteData(data: DevicesRouteData | undefined) {
    if (!data) {
      return;
    }
    this.routeDataInitialized = true;
    const snapshot = this.context.gateway.snapshot;
    if (!this.gateway.isRouteDataCurrent(data)) {
      this.resetServerState(snapshot);
      this.presence = readPresenceEntries(snapshot.hello?.snapshot) ?? [];
      void this.loadPresence();
      return;
    }
    this.pageState = {
      ...data.devices,
      client: snapshot.client,
      connected: snapshot.phase === "connected",
      requestGeneration: this.gateway.epoch,
    };
    const initialPresence = readPresenceEntries(snapshot.hello?.snapshot);
    if (initialPresence) {
      this.presence = initialPresence;
    }
    void this.loadPresence();
  }

  private resetServerState(snapshot: ApplicationGatewaySnapshot) {
    this.dialogs.cancel();
    this.pageState.requestGeneration += 1;
    const next = createInitialDevicesState({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
    next.requestGeneration = this.gateway.epoch;
    this.pageState = next;
    this.presenceTask.cancel();
    this.presence = [];
    this.resetInventoryDetails();
  }

  private async runPageTask<T>(
    task: (pageState: DevicesPageDataState) => T | Promise<T>,
  ): Promise<T> {
    const pageState = this.pageState;
    try {
      const result = task(pageState);
      if (this.pageState === pageState) {
        this.publish();
      }
      return await result;
    } finally {
      if (this.pageState === pageState) {
        this.publish();
      }
    }
  }

  private runAdminTask(task: (pageState: DevicesPageDataState) => unknown) {
    if (this.canAdmin) {
      void this.runPageTask(task);
    }
  }

  private bindNode(nodeId: string | null, agentId?: string) {
    if (!this.canAdmin) {
      return;
    }
    const config = this.context.runtimeConfig;
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

  private ensureInitialData() {
    const pageState = this.pageState;
    if (!pageState.connected || !pageState.client || !this.routeDataInitialized) {
      return;
    }
    if (!pageState.nodes.length && !pageState.nodesLoading) {
      this.refreshNodeInventory();
    }
    if (this.canManagePairing && !pageState.devicesList && !pageState.devicesLoading) {
      void this.runPageTask((current) => loadDevices(current));
    }
    const config = this.context.runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void this.context.runtimeConfig.refresh();
    }
    if (this.canAdmin && !pageState.execApprovalsSnapshot && !pageState.execApprovalsLoading) {
      void this.runPageTask((current) =>
        loadExecApprovals(current, this.resolveExecApprovalsTarget()),
      );
    }
  }

  private syncPolling() {
    if (this.canLoadSystemInfo) {
      this.systemInfoPolling.start();
    } else {
      this.systemInfoPolling.stop();
    }
    if (this.gateway.connected && this.gateway.client) {
      this.polling.start();
      return;
    }
    this.polling.stop();
  }

  private get canLoadSystemInfo(): boolean {
    const snapshot = this.gateway.snapshot;
    return this.gateway.connected && !this.systemInfoUnavailable && canReadSystemInfo(snapshot);
  }

  private get canLoadDesktopEnvironments(): boolean {
    const snapshot = this.gateway.snapshot;
    return this.gateway.connected && Boolean(snapshot && isDesktopPanelAvailable(snapshot));
  }

  private refreshSystemInfo() {
    if (this.canLoadSystemInfo && !this.systemInfoTask.pending) {
      void this.systemInfoTask.run();
    }
  }

  private refreshNodeInventory(quiet = false) {
    this.refreshSystemInfo();
    if (this.canLoadDesktopEnvironments && !this.environmentsTask.pending) {
      void this.environmentsTask.run();
    }
    void this.runPageTask((pageState) => loadNodes(pageState, { quiet }));
  }

  private resetInventoryDetails() {
    // A replacement source or reconnect must retire callbacks before its data can arrive.
    this.systemInfoTask.cancel();
    this.environmentsTask.cancel();
    this.systemInfoPolling.stop();
    this.gatewaySystemInfo = null;
    this.desktopEnvironments = [];
    this.systemInfoUnavailable = false;
  }

  private loadPresence(): Promise<void> {
    const gateway = this.gateway.gateway;
    const client = this.gateway.client;
    if (!gateway || !this.gateway.connected || !client) {
      return Promise.resolve();
    }
    return this.presenceTask.run([gateway, client]);
  }

  // A rotation always ends in a dialog: with the replacement when the Gateway issued it
  // to this operator, otherwise with what it did instead. The reveal sits deliberately
  // outside the confirmation slot, which a reconnect aborts — aborting a shown secret
  // would destroy the only copy the Gateway can hand out.
  private async reportRotationOutcome(
    device: { id: string; name: string },
    role: string,
    scopes?: string[],
  ) {
    if (!this.canManagePairing) {
      return;
    }
    const outcome = await this.runPageTask((pageState) =>
      rotateDeviceToken(pageState, {
        deviceId: device.id,
        gatewayUrl: this.context.gateway.connection.gatewayUrl,
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
  private async changeExecApprovalsTarget(kind: "gateway" | "node", nodeId: string | null) {
    const devices = this.pageState;
    if (devices.execApprovalsDirty && !(await this.dialogs.confirmExecApprovalsDiscard())) {
      this.publish();
      return;
    }
    if (this.pageState !== devices) {
      return;
    }
    this.execApprovalsTarget = kind;
    this.execApprovalsTargetNodeId = nodeId;
    devices.execApprovalsSnapshot = null;
    devices.execApprovalsForm = null;
    devices.execApprovalsDirty = false;
    devices.execApprovalsSelectedAgent = null;
    this.publish();
  }

  private resolveExecApprovalsTarget(): ExecApprovalsTarget {
    return this.execApprovalsTarget === "node" && this.execApprovalsTargetNodeId
      ? { kind: "node", nodeId: this.execApprovalsTargetNodeId }
      : { kind: "gateway" };
  }

  viewProps(): DevicesProps {
    const devices = this.pageState;
    const config = this.context.runtimeConfig.state;
    const gatewaySnapshot = this.context.gateway.snapshot;
    const gatewayVersion =
      gatewaySnapshot.phase === "connected"
        ? gatewaySnapshot.hello?.server?.version?.trim() || null
        : null;
    return {
      loading: devices.nodesLoading,
      nodes: devices.nodes,
      presence: this.presence,
      gatewayVersion,
      basePath: this.context.basePath,
      gatewaySystemInfo: this.gatewaySystemInfo,
      desktopEnvironments: this.desktopEnvironments,
      lastError: devices.lastError,
      devicesLoading: devices.devicesLoading,
      devicesError: devices.devicesError,
      devicesList: devices.devicesList,
      canPairDevice: this.canAdmin,
      canManagePairing: this.canManagePairing,
      canAdmin: this.canAdmin,
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
      execApprovalsTarget: this.execApprovalsTarget,
      execApprovalsTargetNodeId: this.execApprovalsTargetNodeId,
      onDevicePairSetupOpen: () => {
        if (this.canAdmin) {
          void this.context.overlays.openDevicePairSetup();
        }
      },
      onDeviceApprove: (requestId) => {
        if (this.canManagePairing) {
          void this.runPageTask((pageState) => approveDevicePairing(pageState, requestId));
        }
      },
      onDeviceReject: (requestId) => void this.dialogs.confirmPairingReject("device", requestId),
      onNodeApprove: (requestId) => {
        if (this.canManagePairing) {
          void this.runPageTask((pageState) => approveNodePairingRequest(pageState, requestId));
        }
      },
      onNodeReject: (requestId) => void this.dialogs.confirmPairingReject("node", requestId),
      onInventoryRemove: (entry) =>
        void this.dialogs.confirmInventoryRemoval({ kind: "entry", entry }),
      onInventoryCleanup: (entries) => {
        if (entries.length > 0) {
          void this.dialogs.confirmInventoryRemoval({ kind: "stale", entries });
        }
      },
      onDeviceRotate: (device, role, scopes) =>
        void this.reportRotationOutcome(device, role, scopes),
      onDeviceRevoke: (deviceId, role) => void this.dialogs.confirmTokenRevoke(deviceId, role),
      onDeviceRename: (device) => void this.dialogs.editAlias(device),
      onLoadConfig: () => void this.context.runtimeConfig.discardDraft({ reloadOnly: true }),
      onLoadExecApprovals: () =>
        this.runAdminTask((pageState) =>
          loadExecApprovals(pageState, this.resolveExecApprovalsTarget()),
        ),
      onBindDefault: (nodeId) => this.bindNode(nodeId),
      onBindAgent: (agentId, nodeId) => this.bindNode(nodeId, agentId),
      onSaveBindings: () => {
        if (this.canAdmin) {
          void this.context.runtimeConfig.save();
        }
      },
      onExecApprovalsTargetChange: (kind, nodeId) =>
        void this.changeExecApprovalsTarget(kind, nodeId),
      onExecApprovalsSelectAgent: (agentId) => {
        devices.execApprovalsSelectedAgent = agentId;
        this.publish();
      },
      onExecApprovalsPatch: (path, value) =>
        this.runAdminTask((pageState) => updateExecApprovalsFormValue(pageState, path, value)),
      onExecApprovalsRemove: (path) =>
        this.runAdminTask((pageState) => removeExecApprovalsFormValue(pageState, path)),
      onSaveExecApprovals: () =>
        this.runAdminTask((pageState) =>
          saveExecApprovals(pageState, this.resolveExecApprovalsTarget()),
        ),
    };
  }
}

export const DevicesPage = defineSolidBridge<{ routeData?: DevicesRouteData }>(
  "openclaw-devices-page",
  (props) => {
    const context = useApplication();
    // This signal publishes changes from the synchronous page owner, including lifecycle effects.
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const controller = new DevicesPageController(context, () => setRevision((value) => value + 1));
    controller.bindPolling();
    controller.bindGateway();
    controller.bindEvents();
    const config = projectRuntimeConfig(context.runtimeConfig);
    createEffect(
      () => props.routeData,
      (data) => controller.setRouteData(data),
    );
    onCleanup(() => controller.dispose());
    const view = createMemo(() => {
      revision();
      config.read();
      void controller.gateway.snapshot;
      return controller.viewProps();
    });
    return (
      <>
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
      </>
    );
  },
  { properties: { routeData: { default: undefined, attribute: false } } },
);
