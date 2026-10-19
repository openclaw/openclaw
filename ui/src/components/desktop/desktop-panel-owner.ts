import type {
  DesktopObserveResult,
  DesktopSource,
  EnvironmentSummary,
  WorkerDesktopAppId,
} from "@openclaw/gateway-protocol";
import { t } from "../../i18n/index.ts";
import { registerDesktopEnglish } from "../../i18n/locales/en-desktop.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { createDockLayout } from "../dock-layout.ts";
import type { DesktopPanelToggleDetail } from "../panel-toggle-contract.ts";
import * as desktopTransport from "./desktop-client.ts";
import {
  DesktopConnectionHandoff,
  releaseDesktopObservation,
  type DesktopCredentials,
  type ObservedDesktopConnection,
  type PendingDesktopConnection,
} from "./desktop-panel-connection.ts";
import * as desktopAuth from "./desktop-panel-credentials.ts";
import type { DesktopPanelControls, DesktopPanelInputs } from "./desktop-panel-inputs.ts";
import { desktopPanelLayout } from "./desktop-panel-layout.ts";
import {
  createDesktopPanelLifecycle,
  type DesktopPanelInputSnapshot,
} from "./desktop-panel-lifecycle.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";
import { DesktopSessionOwner } from "./desktop-session-owner.ts";
import { desktopSourceForEnvironment } from "./desktop-source.ts";

registerDesktopEnglish();

/** Synchronous authority for connections, credentials, and source selection; Solid owns rendering. */
export function createDesktopPanel(
  host: SolidBridgeElement<DesktopPanelInputs>,
  scheduleAfterRender: (callback: () => void | (() => void)) => void,
) {
  const notify = () => lifecycle.notify();
  let active = false;
  let controls: DesktopPanelControls;
  let environments: EnvironmentSummary[] = [];
  let loading = false;
  let phase: DesktopPanelState = "picker";
  let currentId: string | null = null;
  let currentSource: DesktopSource | null = null;
  let controlling = false;
  let errorText: string | null = null;
  let noticeText: string | null = null;
  let disconnectedReason: string | null = null;
  let desktopApps: WorkerDesktopAppId[] = [];
  let sizingMode: desktopTransport.DesktopSizingMode = "fit";
  let canResize = false;
  const handoff = new DesktopConnectionHandoff();
  let savedCredentials: DesktopCredentials | undefined;
  let credentialAuth: "vnc-password" | "ard-account" | undefined;
  let pendingConnection: PendingDesktopConnection | null = null;
  let operation = 0;
  let controlTakeoverRecoveryUsed = false;
  // Automatic resolution follows the session; an explicit choice owns its pop-out target.
  let selection: "pending" | "resolved" | "explicit" | "picker" = "pending";
  const usesAutomaticSource = () => selection === "pending" || selection === "resolved";
  const sessionSource = new DesktopSessionOwner(
    host,
    notify,
    () => currentId,
    (target) => {
      if (usesAutomaticSource()) {
        returnToPicker("pending");
        void refreshEnvironments(undefined, target);
      }
    },
    () => {
      // Inventory refresh advances operationId; active viewers and credential prompts keep their owner.
      if (
        (phase === "picker" || (phase === "inventory-error" && usesAutomaticSource())) &&
        !host.suppressed &&
        (host.embedded ? host.presented : host.documentMode || dockLayout.open)
      ) {
        void refreshEnvironments();
      }
    },
    () =>
      (phase === "picker" && !loading) || phase === "inventory-error"
        ? null
        : (currentId ?? (usesAutomaticSource() ? host.requestedSource : null)),
    (error) => {
      // Failed refreshes keep an attached viewer, but cannot strand initial target loading.
      if (usesAutomaticSource() && (phase === "picker" || phase === "inventory-error")) {
        sessionSource.invalidate();
        operation += 1;
        loading = false;
        errorText = t("desktop.errors.listFailed", { error: formatUiError(error) });
        phase = "inventory-error";
        notify();
      }
    },
  );
  const keyboardTarget = () => (controlling ? handoff.handle : null);
  const dockLayout = createDockLayout({
    layout: desktopPanelLayout,
    reservationPrefix: "desktop",
    isAvailable: () => host.available,
    isFullscreen: () => controls?.fullscreenMode.ownsFullscreen() ?? false,
    isEmbedded: () => host.embedded,
    notify,
  });
  const lifecycle = createDesktopPanelLifecycle(host, scheduleAfterRender, {
    dockLayout,
    reconcile,
    subscribeClient: (client) => sessionSource.subscribe(client),
    handleToggleRequest: (event) => handleToggleRequest(event),
    detach,
  });

  const audioTarget = () => ({
    connected: phase === "connected",
    reconnect: () => void connectEnvironment(currentId, controlling),
  });

  function detach(): void {
    active = false;
    if (host.documentMode && usesAutomaticSource()) {
      returnToPicker("pending");
    } else {
      disconnectConnection();
    }
    sessionSource.clearDesktopSource();
    savedCredentials = undefined;
    dockLayout.dispose();
  }

  function reconcile(
    next: DesktopPanelInputSnapshot,
    previous: DesktopPanelInputSnapshot | undefined,
  ): void {
    if (next.suppressed !== previous?.suppressed) {
      const restored = dockLayout.setSuppressed(host.suppressed);
      if (host.suppressed) {
        returnToPicker();
      } else if (restored) {
        void refreshEnvironments();
      }
    }
    const gatewayAvailabilityChanged =
      next.client !== previous?.client || next.available !== previous?.available;
    // Embedded source props track placement without replacing a picker's explicit choice.
    const contextChanged =
      gatewayAvailabilityChanged ||
      next.sessions !== previous?.sessions ||
      next.embedded !== previous?.embedded ||
      next.documentMode !== previous?.documentMode ||
      next.sessionKey !== previous?.sessionKey ||
      next.documentControl !== previous?.documentControl ||
      (next.requestedSource !== previous?.requestedSource &&
        (!host.embedded || host.suppliedEnvironments !== null || usesAutomaticSource()));
    if ((host.documentMode || host.embedded) && contextChanged) {
      // Release input and invalidate pending work before resolving a different session or machine.
      returnToPicker("pending");
      if (host.available && (!host.embedded || (host.presented && host.refreshOnPresentation))) {
        void refreshEnvironments();
      }
    } else if (
      host.embedded &&
      next.presented !== previous?.presented &&
      phase !== "disconnected"
    ) {
      controls.pictureInPicture.close();
      controls.mobileKeyboard.reset();
      if (!host.presented) {
        controls.audio.retire();
      }
      if (
        handoff.setPresented(host.presented, () => returnToPicker("pending")) &&
        host.refreshOnPresentation
      ) {
        void refreshEnvironments();
      }
    } else if (gatewayAvailabilityChanged) {
      if (!host.available && dockLayout.open) {
        dockLayout.hideWithoutPersisting();
        returnToPicker();
      } else if (host.available && dockLayout.restoreOpenState()) {
        void refreshEnvironments();
      }
    }
    if (
      next.suppliedEnvironments !== previous?.suppliedEnvironments &&
      host.suppliedEnvironments !== null
    ) {
      environments = [...host.suppliedEnvironments];
      notify();
      const selected = environments.find((entry) => entry.id === currentId);
      if (currentSource) {
        sessionSource.setDesktopSource(currentSource, selected?.desktopAvailability);
      }
    }
    if (!previous && !host.documentMode && !host.embedded && dockLayout.open) {
      void refreshEnvironments();
    }
    dockLayout.syncReservation();
    host.onFocusTargetChange?.({
      kind: "desktop",
      control: controlling,
      ...(selection === "picker"
        ? {}
        : selection === "explicit" || host.sessionKey === null
          ? { source: currentId }
          : { session: host.sessionKey }),
    });
  }

  const handleToggleRequest = (event: Event): void => {
    if (host.documentMode || host.suppressed || (host.embedded && !host.presented)) {
      return;
    }
    const detail =
      event instanceof CustomEvent && typeof event.detail === "object" && event.detail !== null
        ? (event.detail as DesktopPanelToggleDetail) // SAFETY: shared panel event payload; consumed fields are validated below.
        : null;
    if (!host.embedded && (detail?.dock === "right" || detail?.dock === "bottom")) {
      dockLayout.setDock(detail.dock, false);
    }
    if (detail?.open === false) {
      closePanel();
      return;
    }
    if (!host.available || (host.embedded && !host.client)) {
      return;
    }
    const wasOpen = host.embedded || dockLayout.open;
    if (!host.embedded) {
      dockLayout.setOpen(true);
    }
    const environmentId = detail?.environmentId ?? (detail?.open === true ? currentId : null);
    if (environmentId) {
      void connectRequestedEnvironment(environmentId, Boolean(detail?.environmentId));
    } else if (host.embedded) {
      returnToPicker(host.sessionKey !== null ? "pending" : "picker");
      void refreshEnvironments();
    } else if (!wasOpen) {
      void refreshEnvironments();
    } else if (detail?.open !== true) {
      closePanel();
    }
  };

  function closePanel(): void {
    returnToPicker();
    if (!host.embedded) {
      dockLayout.setOpen(false);
    }
  }

  function returnToPicker(sourceSelection: typeof selection = "picker"): void {
    disconnectConnection();
    phase = "picker";
    selection = sourceSelection;
    currentId = null;
    currentSource = null;
    savedCredentials = undefined;
    credentialAuth = undefined;
    desktopApps = [];
    controlling = false;
    sizingMode = "fit";
    canResize = false;
    disconnectedReason = null;
    notify();
    sessionSource.clearDesktopSource();
  }

  function disconnectConnection(retainViewer = false): void {
    // Native close can precede Solid mounting; each Solid owner handles its disposal.
    if (active) {
      controls.audio.close();
      controls.pictureInPicture.close();
      controls.mobileKeyboard.reset();
    }
    operation += 1;
    lifecycle.cancelSurfaceWait();
    pendingConnection = null;
    handoff.begin(retainViewer);
    if (!retainViewer) {
      sessionSource.invalidate();
      loading = false;
      if (active) {
        controls.launcher.clear();
      }
    }
  }

  async function refreshEnvironments(
    expectedOperationId?: number,
    resolvedSessionTarget?: string | null,
    refresh = false,
  ): Promise<boolean> {
    if (!host.client || !host.available || (host.embedded && !host.presented)) {
      return false;
    }
    const operationId = expectedOperationId ?? ++operation;
    loading = true;
    errorText = null;
    notify();
    let refreshed = false;
    let requestedSource: string | undefined;
    if (host.suppliedEnvironments !== null) {
      environments = [...host.suppliedEnvironments];
      loading = false;
      notify();
      const selected = environments.find(
        (entry) => entry.id === host.requestedSource && entry.desktop,
      );
      if (selected && selection === "pending") {
        selection = "resolved";
        await connectEnvironment(selected.id, false);
      }
      return true;
    }
    const inventoryRequest = sessionSource.loadInventory({
      automatic: selection === "pending",
      target: resolvedSessionTarget,
      refresh,
      isCurrent: () => operationId === operation && (!host.embedded || host.presented),
    });
    try {
      const inventory = await inventoryRequest.result;
      if (inventory && inventoryRequest.isCurrent()) {
        requestedSource = inventory.selectedSource;
        environments = inventory.environments;
        notify();
        refreshed = true;
      }
    } catch (error) {
      if (inventoryRequest.isCurrent()) {
        errorText = t("desktop.errors.listFailed", { error: formatUiError(error) });
        if (host.requestedSource !== null || host.sessionKey !== null) {
          // Keep an explicit target through retry; an unresolved session has no environment yet.
          phase = "inventory-error";
        }
      }
    } finally {
      if (inventoryRequest.isCurrent()) {
        loading = false;
        notify();
      }
    }
    if (refreshed && inventoryRequest.isCurrent() && selection === "pending") {
      if (requestedSource !== undefined) {
        selection = "resolved";
        notify();
        await connectEnvironment(requestedSource, host.documentControl);
      } else if (host.requestedSource !== null || host.sessionKey !== null) {
        noticeText = t("desktop.sourceUnavailable");
        notify();
      }
    }
    return refreshed;
  }

  async function connectRequestedEnvironment(
    environmentId: string,
    explicit = true,
  ): Promise<void> {
    // Showing a live source must not release its current input controller.
    if (
      environmentId === currentId &&
      (phase === "connecting" || phase === "connected" || phase === "credentials")
    ) {
      if (explicit) {
        selection = "explicit";
        notify();
      }
      return;
    }
    returnToPicker(explicit ? "explicit" : selection);
    currentId = environmentId;
    phase = "connecting";
    const operationId = operation;
    const inventoryLoaded = await refreshEnvironments(operationId, environmentId);
    if (operationId !== operation) {
      return;
    }
    if (!inventoryLoaded) {
      phase = "inventory-error";
      notify();
      return;
    }
    void connectEnvironment(environmentId, false);
  }

  async function connectEnvironment(
    environmentId: string | null,
    control: boolean,
    takeoverRecovery = false,
  ): Promise<void> {
    const client = host.client;
    if (!environmentId || !client || !host.available || (host.embedded && !host.presented)) {
      return;
    }
    if (currentId !== environmentId) {
      savedCredentials = undefined;
      credentialAuth = undefined;
      sizingMode = "fit";
    }
    canResize = false;
    const environment = environments.find((candidate) => candidate.id === environmentId);
    desktopApps = [...(environment?.worker?.desktopApps ?? [])];
    disconnectConnection(currentId === environmentId);
    const operationId = operation;
    const source = desktopSourceForEnvironment(environment ?? { id: environmentId });
    currentId = environmentId;
    currentSource = source;
    sessionSource.setDesktopSource(source, environment?.desktopAvailability);
    controlling = control;
    phase = "connecting";
    errorText = null;
    disconnectedReason = null;
    if (!takeoverRecovery) {
      noticeText = null;
    }
    controlTakeoverRecoveryUsed = takeoverRecovery;
    notify();
    try {
      const supplied = desktopAuth.forObserve(source, credentialAuth, savedCredentials);
      const observed = await client.request<DesktopObserveResult>("desktop.observe", {
        source,
        control,
        ...(supplied ? { credentials: supplied } : {}),
      });
      const abandon = () => releaseDesktopObservation(client, observed.wsPath);
      if (operationId !== operation) {
        abandon();
        return;
      }
      controlling = observed.control;
      canResize = observed.canResize === true;
      notify();
      if ((!canResize || !controlling) && sizingMode === "match") {
        sizingMode = "fit";
      }
      const authResult = desktopAuth.forConnection(observed, savedCredentials);
      if (authResult.phase === "credentials") {
        handoff.disconnect();
      }
      handoff.retainObservation(abandon);
      credentialAuth = authResult.auth ?? credentialAuth;
      if (authResult.phase === "credentials") {
        pendingConnection = { environmentId, control, observed, operationId };
        phase = "credentials";
        notify();
        return;
      }
      await connectObserved(
        { environmentId, control, observed, operationId },
        authResult.credentials,
      );
    } catch (error) {
      const requiredAuth = desktopAuth.desktopCredentialRequirement(error);
      if (requiredAuth && operationId === operation) {
        handoff.disconnect();
        credentialAuth = requiredAuth;
        pendingConnection = { environmentId, control, operationId };
        phase = "credentials";
        notify();
        return;
      }
      failConnection(operationId, error);
    }
  }

  async function connectObserved(
    pending: ObservedDesktopConnection,
    credentials?: DesktopCredentials,
  ): Promise<void> {
    const client = host.client;
    if (!client || pending.operationId !== operation) {
      return;
    }
    phase = "connecting";
    notify();
    try {
      const target = lifecycle.surface() ?? (await lifecycle.waitForSurface());
      if (pending.operationId !== operation) {
        return;
      }
      if (!target) {
        throw new Error("Desktop render target is unavailable");
      }
      controls.audio.connect(pending.observed, client.gatewayUrl);
      const connection = await host.desktopClientFactory().connect({
        // noVNC applies this to a same-document element; retain live theme inheritance.
        background: "var(--bg)",
        isCurrent: () => pending.operationId === operation,
        wsUrl: pending.observed.wsPath,
        gatewayUrl: client.gatewayUrl,
        credentials,
        viewOnly: !pending.observed.control,
        canResize: pending.observed.canResize,
        sizingMode,
        target,
        onConnect: () => {
          if (pending.operationId === operation) {
            handoff.setSizingMode(sizingMode);
            handoff.markConnected();
            phase = "connected";
            notify();
          }
        },
        onDisconnect: (detail) => {
          if (pending.operationId === operation) {
            handleDesktopDisconnect(pending.environmentId, detail);
          }
        },
        onSecurityFailure: (detail) => {
          if (pending.operationId === operation) {
            const reason = formatUiExternalText(detail.reason, t("desktop.unknownReason"));
            errorText = t("desktop.errors.securityFailed", { reason });
            notify();
            failConnection(pending.operationId, new Error(reason));
          }
        },
      });
      if (pending.operationId !== operation) {
        connection.disconnect();
        return;
      }
      handoff.attach(connection);
      handoff.setSizingMode(sizingMode);
    } catch (error) {
      failConnection(pending.operationId, error);
    }
  }

  function failConnection(operationId: number, error: unknown): void {
    if (operationId !== operation) {
      return;
    }
    disconnectConnection();
    phase = "disconnected";
    disconnectedReason = formatUiError(error);
    notify();
  }

  function handleCredentialsSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const pending = pendingConnection;
    if (!pending || pending.operationId !== operation) {
      return;
    }
    const credentials = desktopAuth.fromForm(
      // SAFETY: the credentials form is the currentTarget of its submit handler.
      new FormData(event.currentTarget as HTMLFormElement),
      credentialAuth,
    );
    if (!credentials) {
      return;
    }
    savedCredentials = credentials;
    pendingConnection = null;
    if (pending.observed) {
      void connectObserved({ ...pending, observed: pending.observed }, credentials);
    } else {
      void connectEnvironment(pending.environmentId, pending.control);
    }
  }

  function handleDesktopDisconnect(
    environmentId: string | null,
    { code, reason, clean }: desktopTransport.DesktopDisconnectDetail,
  ): void {
    disconnectConnection();
    if (code === 1008 && credentialAuth === "ard-account" && environmentId !== null) {
      savedCredentials = savedCredentials?.username
        ? { username: savedCredentials.username }
        : undefined;
      pendingConnection = {
        environmentId,
        control: controlling,
        operationId: operation,
      };
      phase = "credentials";
      errorText = t("desktop.errors.securityFailed", {
        reason: formatUiExternalText(reason, t("desktop.unknownReason")),
      });
      notify();
      return;
    }
    if (
      code === 4000 &&
      (reason === "control-taken" || reason?.startsWith("control-taken:")) &&
      controlling &&
      environmentId !== null &&
      (!host.embedded || host.presented) &&
      !controlTakeoverRecoveryUsed
    ) {
      const operator = formatUiExternalText(reason.slice("control-taken:".length));
      noticeText = operator ? t("desktop.controlTakenBy", { operator }) : t("desktop.controlTaken");
      notify();
      void connectEnvironment(environmentId, false, true);
      return;
    }
    phase = "disconnected";
    disconnectedReason =
      formatUiExternalText(reason, code ? t("desktop.closeCode", { code: String(code) }) : "") ||
      (!clean ? t("desktop.errors.connectionFailed") : null);
    notify();
  }

  return {
    notify,
    subscribe: lifecycle.subscribe,
    attach(nextControls: DesktopPanelControls, retainOpen: boolean) {
      controls = nextControls;
      active = true;
      lifecycle.attach(retainOpen);
    },
    inputsChanged: notify,
    surface: lifecycle.surface,
    launchTarget: () => ({
      client: host.client,
      source: currentSource,
      presented: !host.embedded || host.presented,
      state: phase,
      apps: desktopApps,
    }),
    get view() {
      return {
        documentMode: host.documentMode,
        embedded: host.embedded,
        surfaceRef: lifecycle.surfaceRef,
        workspaceControls: host.workspaceControls,
        content: {
          state: phase,
          loading,
          automaticSource: usesAutomaticSource(),
          hasTarget: host.sessionKey !== null || host.requestedSource !== null,
          errorText: controls.launcher.feedback().error ?? errorText,
          noticeText,
          availability: sessionSource.desktopAvailability,
          picker: {
            automatic: usesAutomaticSource() && host.embedded && host.sessionKey !== null,
            environments,
            onRefresh: () => void refreshEnvironments(undefined, undefined, true),
            onConnect: (environmentId: string) => {
              selection = "explicit";
              notify();
              void connectEnvironment(environmentId, false);
            },
          },
          credentials: {
            ardAccount: credentialAuth === "ard-account",
            username: savedCredentials?.username ?? "",
            onSubmit: handleCredentialsSubmit,
          },
          recovery: {
            reason: disconnectedReason,
            onRetry: () => {
              if ((phase === "inventory-error" && host.documentMode) || !currentId) {
                if (selection !== "picker") {
                  selection = "pending";
                }
                phase = "picker";
                notify();
                void refreshEnvironments(undefined, undefined, true);
                return;
              }
              if (phase === "inventory-error" && currentId) {
                void connectRequestedEnvironment(currentId);
                return;
              }
              void connectEnvironment(currentId, controlling);
            },
          },
        },
        controlling,
        desktopApps,
        launchingApp: controls.launcher.feedback().app ?? null,
        startup: sessionSource.startupEnvironment,
        sizing: {
          mode: sizingMode,
          canResize: canResize && controlling && phase === "connected",
          onChange: (mode: desktopTransport.DesktopSizingMode) => {
            sizingMode = mode;
            notify();
            handoff.setSizingMode(mode);
          },
        },
        mobileKeyboard: controls.mobileKeyboard,
        pictureInPicture: controls.pictureInPicture,
        audio: controls.audio,
        fullscreenMode: controls.fullscreenMode,
        dockLayout,
        onControlToggle: () => void connectEnvironment(currentId, !controlling),
        onTakeControl: () => void connectEnvironment(currentId, true),
        onLaunch: (app: WorkerDesktopAppId) => void controls.launcher.launch(app),
        onClose: closePanel,
        onDocumentClose: () => host.onDocumentClose?.(),
        focusTarget: () => ({
          basePath: host.basePath,
          source: currentId,
          control: controlling,
          workspaceControls: host.workspaceControls,
        }),
        onDisconnect: () => {
          if (host.embedded && (host.sessionKey !== null || host.suppliedEnvironments !== null)) {
            handleDesktopDisconnect(currentId, { clean: true });
          } else {
            returnToPicker();
          }
        },
      };
    },
    audioTarget,
    keyboardTarget,
    dockLayout,
    handleToggleRequest,
  };
}

export type DesktopPanelOwner = ReturnType<typeof createDesktopPanel>;
