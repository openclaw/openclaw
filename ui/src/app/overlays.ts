import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  GATEWAY_EVENT_UPDATE_RUN_CHANGED,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import { registerListener } from "../../../src/shared/listeners.js";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { showToast } from "../lib/toast.ts";
import {
  clearExecApprovalTimers,
  clearResolvedExecApprovalPrompt,
  enqueueExecApprovalPrompt,
  isStaleApprovalResolutionError,
  parseApprovalRequestedEvent,
  parseApprovalResolvedEvent,
  resolveApprovalRequest,
  type ExecApprovalPromptState,
} from "./exec-approval.ts";
import { gatewayPresentationScope } from "./gateway-presentation-scope.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import {
  createOverlayApprovalRefresher,
  readOverlayOperatorAccessTransition,
} from "./overlays-access.ts";
import type { ApplicationOverlays, ApplicationOverlaySnapshot } from "./overlays-types.ts";
import {
  createApplicationUpdateOverlays,
  type ApplicationUpdateOverlayHooks,
} from "./overlays-updates.ts";

export function createApplicationOverlays(
  gateway: ApplicationGateway,
  hooks: ApplicationUpdateOverlayHooks = {},
): ApplicationOverlays {
  const updates = createApplicationUpdateOverlays(gateway, publish, hooks);
  const runConnectionBootstrap = (key: string, task: () => Promise<unknown>) =>
    hooks.connectionBootstrap?.run(key, task) ?? task();
  let snapshot: ApplicationOverlaySnapshot = {
    ...updates.snapshot,
    approvalQueue: [],
    approvalBusy: false,
    approvalCanGrant: false,
    approvalErrors: new Map(),
    devicePairSetupOpen: false,
    devicePairSetupLifecycle: { phase: "selection", access: "full" },
    devicePairPendingCount: 0,
  };
  const listeners = new Set<(next: ApplicationOverlaySnapshot) => void>();
  let disposed = false;
  let activeClient = gateway.snapshot.client;
  let presentationScopeKey = gatewayPresentationScope(gateway).key;
  let connectedSource: NonNullable<typeof activeClient> | null = null; // Retries start a new source epoch.
  let connectedEpoch = 0;
  let operatorAccess = readGatewayOperatorAccess(gateway.snapshot);
  let approvalAccessGeneration = 0;
  let approvalGrantGeneration = 0;
  let approvalDecision: {
    client: NonNullable<typeof activeClient>;
    epoch: number;
    accessGeneration: number;
    grantGeneration: number;
    id: string;
  } | null = null;
  type PairingModule = typeof import("./overlays-pairing.ts");
  let pairing: ReturnType<PairingModule["createOverlayPairing"]> | null = null;
  const promptState: ExecApprovalPromptState = {
    client: activeClient,
    execApprovalQueue: [],
    execApprovalBusy: false,
    execApprovalErrors: new Map(),
    execApprovalExpiryTimers: new Map(),
  };

  function publish() {
    snapshot = {
      ...snapshot,
      ...updates.snapshot,
      approvalQueue: promptState.execApprovalQueue,
      approvalBusy: promptState.execApprovalBusy,
      approvalCanGrant:
        gateway.snapshot.phase === "connected" &&
        readGatewayOperatorAccess(gateway.snapshot).canGrantApprovals,
      approvalErrors: new Map(promptState.execApprovalErrors),
      ...(pairing ? pairing.runtime.readDevicePairSetupSnapshot(pairing.state) : {}),
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
  }
  promptState.execApprovalChanged = publish;
  const publishDevicePairSetupOperation = async (operation: Promise<void>) => {
    publish();
    await operation;
    if (!disposed && pairing) {
      pairing.runtime.syncDevicePairSetupCountdown(pairing.state, publish);
      publish();
    }
  };
  const isCurrentClient = (client: NonNullable<typeof activeClient>) =>
    !disposed &&
    activeClient === client &&
    gateway.snapshot.client === client &&
    gateway.snapshot.phase === "connected";

  const refreshApprovals = createOverlayApprovalRefresher({
    gateway,
    state: promptState,
    getConnectedEpoch: () => connectedEpoch,
    getReviewGeneration: () => approvalAccessGeneration,
    canReview: () => operatorAccess.canReviewApprovals,
    isCurrentClient,
    isDisposed: () => disposed,
    publish,
  });

  const synchronizeGateway = (next: ApplicationGateway["snapshot"]) => {
    const previousClient = activeClient;
    const nextScopeKey = gatewayPresentationScope(gateway).key;
    const identityChanged = previousClient !== next.client || presentationScopeKey !== nextScopeKey;
    presentationScopeKey = nextScopeKey;
    const connected = next.phase === "connected";
    const nextConnectedSource = connected ? next.client : null;
    const connectedSourceChanged = connectedSource !== nextConnectedSource || identityChanged;
    const accessTransition = readOverlayOperatorAccessTransition(operatorAccess, next);
    if (connectedSourceChanged || accessTransition.reviewChanged) {
      refreshApprovals.cancel();
    }
    operatorAccess = accessTransition.access;
    if (accessTransition.reviewChanged) {
      approvalAccessGeneration += 1;
    }
    if (accessTransition.grantChanged) {
      approvalGrantGeneration += 1;
    }
    if (accessTransition.grantRevoked) {
      // Review can remain available without a decision grant. Retire the
      // in-flight owner without discarding the still-readable approval queue.
      const revokedDecision = approvalDecision;
      if (
        revokedDecision &&
        promptState.execApprovalQueue.some((entry) => entry.id === revokedDecision.id)
      ) {
        promptState.execApprovalErrors.set(revokedDecision.id, t("execApproval.reviewOnly"));
      }
      approvalDecision = null;
      promptState.execApprovalBusy = false;
    }
    if (accessTransition.adminRevoked) {
      // Losing setup authority retires both the modal and any retained bearer code.
      pairing?.close();
    }
    if (accessTransition.pairingChanged) {
      pairing?.pendingCount.invalidate({
        clear: !operatorAccess.canAdmin,
      });
    }
    activeClient = next.client;
    connectedSource = nextConnectedSource;
    promptState.client = next.client;
    if (pairing) {
      pairing.state.client = next.client;
      pairing.state.connected = connected;
    }
    if (identityChanged || !connected) {
      approvalDecision = null;
      pairing?.close();
    }
    if (connected && !operatorAccess.canReviewApprovals) {
      approvalDecision = null;
    }
    if (identityChanged || !next.client || !operatorAccess.canReviewApprovals) {
      promptState.execApprovalQueue = [];
      promptState.execApprovalErrors.clear();
      clearExecApprovalTimers(promptState);
    }
    if (!connected || identityChanged || !operatorAccess.canReviewApprovals) {
      promptState.execApprovalBusy = false;
    }
    if (!connected || !next.client) {
      if (next.phase !== "reload-required" && !next.client) {
        connectedEpoch = 0;
      }
      updates.synchronizeGateway(next);
      publish();
      return;
    }
    const connectedClient = next.client;
    updates.synchronizeGateway(next);
    if (
      accessTransition.pairingChanged &&
      pairing?.state.devicePairSetupOpen &&
      operatorAccess.canAdmin
    ) {
      void runConnectionBootstrap("pairing-pending-count", async () =>
        pairing?.pendingCount.refresh(),
      ).catch(() => undefined);
    }
    if (connectedSourceChanged) {
      connectedEpoch += 1;
    }
    if (
      (connectedSourceChanged || accessTransition.reviewChanged) &&
      operatorAccess.canReviewApprovals
    ) {
      void runConnectionBootstrap("approvals", () =>
        refreshApprovals.refresh(connectedClient, connectedEpoch, approvalAccessGeneration),
      ).catch(() => undefined);
    }
  };
  // Revoke approval and pairing authority during the Gateway receipt, before views run.
  const stopGateway = gateway.subscribe(synchronizeGateway);

  const stopEvents = gateway.subscribeEvents((event) => {
    if (disposed) {
      return;
    }
    if (pairing?.handleEvent(event)) {
      return;
    }
    if (event.event === GATEWAY_EVENT_UPDATE_AVAILABLE) {
      updates.handleUpdateAvailable(
        event.payload as GatewayUpdateAvailableEventPayload | undefined,
      );
      return;
    }
    if (event.event === GATEWAY_EVENT_UPDATE_RUN_CHANGED) {
      updates.handleUpdateRunChanged(event.payload);
      return;
    }
    if (
      !operatorAccess.canReviewApprovals ||
      !readGatewayOperatorAccess(gateway.snapshot).canReviewApprovals
    ) {
      return;
    }
    const requestedApproval = parseApprovalRequestedEvent(event.event, event.payload);
    if (requestedApproval) {
      enqueueExecApprovalPrompt(promptState, requestedApproval);
      publish();
      return;
    }
    const resolvedApproval = parseApprovalResolvedEvent(event.event, event.payload);
    if (resolvedApproval) {
      clearResolvedExecApprovalPrompt(promptState, resolvedApproval.id);
      publish();
    }
  });
  synchronizeGateway(gateway.snapshot);

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener) => registerListener(listeners, listener),
    refreshUpdateStatus: updates.refreshUpdateStatus,
    acknowledgeUpdateRun: updates.acknowledgeUpdateRun,
    captureUpdateTarget: updates.captureUpdateTarget,
    runUpdate: updates.runUpdate,
    holdUpdate: updates.holdUpdate,
    diagnoseUpdateFailure: updates.diagnoseUpdateFailure,
    reportUpdateFailure: updates.reportUpdateFailure,
    async decideApproval(decision, approvalId, projectedApproval) {
      const active = approvalId
        ? (promptState.execApprovalQueue.find((entry) => entry.id === approvalId) ??
          (projectedApproval?.id === approvalId ? projectedApproval : undefined))
        : promptState.execApprovalQueue[0];
      const client = gateway.snapshot.client;
      if (!active || promptState.execApprovalBusy || disposed) {
        return;
      }
      const isProjectedApproval = active === projectedApproval;
      if (!client || gateway.snapshot.phase !== "connected") {
        promptState.execApprovalErrors.set(active.id, t("sessionsView.actionRequiresConnection"));
        publish();
        return;
      }
      if (!readGatewayOperatorAccess(gateway.snapshot).canGrantApprovals) {
        promptState.execApprovalErrors.set(active.id, t("execApproval.reviewOnly"));
        publish();
        return;
      }
      promptState.execApprovalBusy = true;
      promptState.execApprovalErrors.delete(active.id);
      const operation = {
        client,
        epoch: connectedEpoch,
        accessGeneration: approvalAccessGeneration,
        grantGeneration: approvalGrantGeneration,
        id: active.id,
      };
      approvalDecision = operation;
      const isCurrentOperation = () =>
        approvalDecision === operation &&
        operation.epoch === connectedEpoch &&
        operation.accessGeneration === approvalAccessGeneration &&
        operation.grantGeneration === approvalGrantGeneration &&
        readGatewayOperatorAccess(gateway.snapshot).canGrantApprovals &&
        isCurrentClient(operation.client);
      publish();
      try {
        await resolveApprovalRequest(client, active, decision);
        if (!isCurrentOperation()) {
          return;
        }
        clearResolvedExecApprovalPrompt(promptState, active.id);
      } catch (error) {
        if (isStaleApprovalResolutionError(error)) {
          if (!isCurrentOperation()) {
            return;
          }
          clearResolvedExecApprovalPrompt(promptState, active.id);
          const currentClient = activeClient;
          const epoch = connectedEpoch;
          if (currentClient && isCurrentOperation()) {
            await refreshApprovals.refresh(currentClient, epoch);
          }
          return;
        }
        if (
          isCurrentOperation() &&
          (isProjectedApproval ||
            promptState.execApprovalQueue.some((entry) => entry.id === active.id))
        ) {
          promptState.execApprovalErrors.set(active.id, `Approval failed: ${formatUiError(error)}`);
        }
      } finally {
        // Reconnect can admit a new decision while this request is still settling.
        // Only the operation that owns the busy state may release it.
        if (approvalDecision === operation) {
          approvalDecision = null;
          promptState.execApprovalBusy = false;
          publish();
        }
      }
    },
    async openDevicePairSetup() {
      const client = gateway.snapshot.client;
      const epoch = connectedEpoch;
      const canOpen = () =>
        !disposed &&
        gateway.snapshot.phase === "connected" &&
        gateway.snapshot.client === client &&
        connectedEpoch === epoch &&
        readGatewayOperatorAccess(gateway.snapshot).canAdmin;
      if (!canOpen()) {
        return false;
      }
      if (!pairing) {
        let feature: PairingModule;
        try {
          feature = await import("./overlays-pairing.ts");
        } catch (error) {
          if (canOpen()) {
            showToast({ message: formatUiError(error) });
          }
          return false;
        }
        // Loading the interaction must not revive authority from an earlier connection.
        if (!canOpen()) {
          return false;
        }
        pairing ??= feature.createOverlayPairing({
          gateway,
          isDisposed: () => disposed,
          publish,
        });
      }
      pairing.state.pendingCount = 0;
      const setupOperation = pairing.runtime.openDevicePairSetup(pairing.state);
      // Pairing-list latency must not keep a ready setup code behind the loading state.
      void pairing.pendingCount.refresh();
      await publishDevicePairSetupOperation(setupOperation);
      return pairing.state.devicePairSetupOpen;
    },
    async refreshDevicePairSetup() {
      if (!pairing || disposed || !readGatewayOperatorAccess(gateway.snapshot).canAdmin) {
        return;
      }
      await publishDevicePairSetupOperation(pairing.runtime.refreshDevicePairSetup(pairing.state));
    },
    async setDevicePairSetupAccess(access) {
      if (!pairing || disposed || !readGatewayOperatorAccess(gateway.snapshot).canAdmin) {
        return;
      }
      await publishDevicePairSetupOperation(
        pairing.runtime.setDevicePairSetupAccess(pairing.state, access),
      );
    },
    closeDevicePairSetup() {
      pairing?.close();
      publish();
    },
    dispose() {
      disposed = true;
      approvalDecision = null;
      refreshApprovals.cancel();
      updates.dispose();
      pairing?.close(false);
      stopGateway();
      stopEvents();
      clearExecApprovalTimers(promptState);
      promptState.execApprovalErrors.clear();
      listeners.clear();
    },
  };
}
