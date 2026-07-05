import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import type { GatewayEventFrame, GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable } from "../api/types.ts";
import {
  closeDevicePairSetup as closeDevicePairSetupState,
  openDevicePairSetup as openDevicePairSetupState,
  refreshDevicePairSetup as refreshDevicePairSetupState,
  type DevicePairSetup,
  type DevicePairSetupState,
} from "../lib/device-pair-setup.ts";
import {
  clearResolvedExecApprovalPrompt,
  dismissExecApprovalPrompt,
  enqueueExecApprovalPrompt,
  isStaleApprovalResolutionError,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  parsePluginApprovalRequested,
  refreshPendingApprovalQueue,
  type ExecApprovalDecision,
  type ExecApprovalPromptState,
  type ExecApprovalRequest,
} from "./exec-approval.ts";
import type { ApplicationGateway } from "./gateway.ts";

export type ApplicationStatusBanner = {
  tone: "danger" | "warn" | "info";
  text: string;
};

export type ApplicationOverlaySnapshot = {
  updateAvailable: UpdateAvailable | null;
  updateRunning: boolean;
  updateStatusBanner: ApplicationStatusBanner | null;
  approvalQueue: readonly ExecApprovalRequest[];
  approvalBusy: boolean;
  approvalError: string | null;
  devicePairSetupOpen: boolean;
  devicePairSetupLoading: boolean;
  devicePairSetupError: string | null;
  devicePairSetup: DevicePairSetup | null;
  devicePairPendingCount: number;
};

export type ApplicationOverlays = {
  readonly snapshot: ApplicationOverlaySnapshot;
  subscribe: (listener: (snapshot: ApplicationOverlaySnapshot) => void) => () => void;
  runUpdate: () => Promise<void>;
  dismissUpdate: () => void;
  decideApproval: (decision: ExecApprovalDecision) => Promise<void>;
  openDevicePairSetup: () => Promise<void>;
  refreshDevicePairSetup: () => Promise<void>;
  closeDevicePairSetup: () => void;
  dispose: () => void;
};

const UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
const UPDATE_RESTART_HEALTH_PENDING_REASON = "restart-health-pending";
const UPDATE_RESTART_VERIFICATION_POLL_MS = 250;
const UPDATE_RESTART_VERIFICATION_TIMEOUT_MS = 10_000;
const UPDATE_HANDOFF_POLL_MS = 1_000;
const UPDATE_HANDOFF_TIMEOUT_MS = 35 * 60_000;
const PENDING_UPDATE_HANDOFF_REASONS = new Set([
  UPDATE_HANDOFF_STARTED_REASON,
  UPDATE_RESTART_HEALTH_PENDING_REASON,
]);

type UpdateRestartStatusResponse = {
  sentinel?: {
    kind?: string;
    status?: string;
    stats?: {
      reason?: string | null;
      after?: { version?: string | null } | null;
    } | null;
  } | null;
};

function readUpdateAvailable(hello: GatewayHelloOk | null): UpdateAvailable | null {
  const snapshot = hello?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const update = (snapshot as { updateAvailable?: unknown }).updateAvailable;
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return null;
  }
  const value = update as Partial<UpdateAvailable>;
  return typeof value.currentVersion === "string" &&
    typeof value.latestVersion === "string" &&
    typeof value.channel === "string"
    ? {
        currentVersion: value.currentVersion,
        latestVersion: value.latestVersion,
        channel: value.channel,
      }
    : null;
}

function resolveUpdateStatusBanner(params: {
  status?: string;
  reason?: string;
}): ApplicationStatusBanner {
  const status = (params.status ?? "error").trim() || "error";
  const reason = (params.reason ?? "unexpected-error").trim() || "unexpected-error";
  const guidance =
    {
      dirty: "Commit or stash changes, then retry.",
      "no-upstream": "Set an upstream branch, then retry.",
      "not-git-install":
        "Not a git checkout. Run `openclaw update` from the CLI for a global reinstall.",
      "not-openclaw-root":
        "Run the update from an OpenClaw checkout or use the CLI global reinstall path.",
      "deps-install-failed": "Dependency install failed. Fix the install error and retry.",
      "build-failed": "Build failed. Fix the build error and retry.",
      "ui-build-failed": "The control UI rebuild failed. Fix the UI build error and retry.",
      "global-install-failed":
        "The global package install did not verify on disk. Retry or reinstall from the CLI.",
      "restart-disabled":
        "The update was not applied because gateway restarts are disabled. Enable restarts in config, then retry.",
      "restart-unavailable":
        "This global install cannot be safely replaced while restarts are disabled and no supervisor is present.",
      "restart-unhealthy":
        "The replacement process never became healthy. The previous process stayed up so you can recover.",
      "doctor-failed": "Doctor repair failed. Run `openclaw doctor --non-interactive` and retry.",
    }[reason] ?? "See the gateway logs for the exact failure and retry once the cause is fixed.";
  return {
    tone: status === "skipped" ? "warn" : "danger",
    text: `Update ${status}: ${reason}. ${guidance}`,
  };
}

function resolveUpdateVerificationBanner(params: {
  expectedVersion: string;
  actualVersion: string | null;
}): ApplicationStatusBanner {
  const actualSuffix = params.actualVersion
    ? ` Expected v${params.expectedVersion}, running v${params.actualVersion}.`
    : "";
  return {
    tone: "danger",
    text: `Update installed but running version did not change — restart may have been blocked.${actualSuffix}`,
  };
}

function resolvePostRestartUpdateBanner(
  reason: string | null | undefined,
): ApplicationStatusBanner {
  const normalizedReason = reason?.trim() || "restart-unhealthy";
  const guidance =
    normalizedReason === "restart-unhealthy"
      ? "The replacement process never became healthy and the previous process stayed up."
      : "Check the gateway logs for the replacement failure.";
  return {
    tone: "danger",
    text: `Update error: ${normalizedReason}. ${guidance}`,
  };
}

function resolvePendingUpdateHandoffTimeoutBanner(): ApplicationStatusBanner {
  return {
    tone: "danger",
    text: "Update handoff started, but completion was not reported after reconnect. Run `openclaw update status` for the final result.",
  };
}

function isPendingUpdateHandoffSentinel(
  sentinel: UpdateRestartStatusResponse["sentinel"],
): boolean {
  const reason = sentinel?.stats?.reason;
  return (
    sentinel?.kind === "update" &&
    sentinel.status === "skipped" &&
    typeof reason === "string" &&
    PENDING_UPDATE_HANDOFF_REASONS.has(reason)
  );
}

function isGatewayEvent(value: unknown): value is GatewayEventFrame {
  return Boolean(value && typeof value === "object" && "event" in value);
}

type UpdateRunResponse = {
  ok?: boolean;
  result?: {
    status?: string;
    reason?: string;
    after?: { version?: string | null } | null;
  };
  handoff?: { status?: string };
};

export function createApplicationOverlays(gateway: ApplicationGateway): ApplicationOverlays {
  let snapshot: ApplicationOverlaySnapshot = {
    updateAvailable: null,
    updateRunning: false,
    updateStatusBanner: null,
    approvalQueue: [],
    approvalBusy: false,
    approvalError: null,
    devicePairSetupOpen: false,
    devicePairSetupLoading: false,
    devicePairSetupError: null,
    devicePairSetup: null,
    devicePairPendingCount: 0,
  };
  const listeners = new Set<(next: ApplicationOverlaySnapshot) => void>();
  let disposed = false;
  let activeClient = gateway.snapshot.client;
  let pendingUpdateExpectedVersion: string | null = null;
  let pendingUpdateHandoff = false;
  let updateRunGeneration = 0;
  let updateVerificationGeneration = 0;
  let updateVerificationTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let devicePairPendingCountGeneration = 0;
  const devicePairSetupState: DevicePairSetupState & { pendingCount: number } = {
    client: gateway.snapshot.client,
    connected: gateway.snapshot.connected,
    devicePairSetupOpen: false,
    devicePairSetupLoading: false,
    devicePairSetupError: null,
    devicePairSetup: null,
    pendingCount: 0,
  };
  const promptState: ExecApprovalPromptState = {
    client: activeClient,
    execApprovalQueue: [],
    execApprovalBusy: false,
    execApprovalError: null,
    execApprovalExpiryTimers: new Map(),
  };

  const publish = () => {
    snapshot = {
      updateAvailable: snapshot.updateAvailable,
      updateRunning: snapshot.updateRunning,
      updateStatusBanner: snapshot.updateStatusBanner,
      approvalQueue: promptState.execApprovalQueue,
      approvalBusy: promptState.execApprovalBusy,
      approvalError: promptState.execApprovalError,
      devicePairSetupOpen: devicePairSetupState.devicePairSetupOpen,
      devicePairSetupLoading: devicePairSetupState.devicePairSetupLoading,
      devicePairSetupError: devicePairSetupState.devicePairSetupError,
      devicePairSetup: devicePairSetupState.devicePairSetup,
      devicePairPendingCount: devicePairSetupState.pendingCount,
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  promptState.execApprovalExpired = publish;

  const refreshDevicePairPendingCount = async () => {
    const client = gateway.snapshot.client;
    if (
      !client ||
      !gateway.snapshot.connected ||
      disposed ||
      !devicePairSetupState.devicePairSetupOpen
    ) {
      return;
    }
    const generation = ++devicePairPendingCountGeneration;
    let result: { pending?: unknown };
    try {
      result = await client.request<{ pending?: unknown }>("device.pair.list", {});
    } catch {
      return;
    }
    if (
      disposed ||
      generation !== devicePairPendingCountGeneration ||
      gateway.snapshot.client !== client ||
      !gateway.snapshot.connected ||
      !devicePairSetupState.devicePairSetupOpen
    ) {
      return;
    }
    devicePairSetupState.pendingCount = Array.isArray(result.pending) ? result.pending.length : 0;
    publish();
  };

  const refreshApprovals = async (client: NonNullable<typeof activeClient>) => {
    const applied = await refreshPendingApprovalQueue(promptState, {
      isCurrentClient: (requestClient) =>
        !disposed &&
        requestClient === client &&
        activeClient === client &&
        gateway.snapshot.client === client &&
        gateway.snapshot.connected,
    });
    if (applied && !disposed) {
      publish();
    }
  };

  const publishUpdateBanner = (updateStatusBanner: ApplicationStatusBanner | null) => {
    snapshot = { ...snapshot, updateStatusBanner };
    publish();
  };

  const cancelUpdateVerification = () => {
    updateVerificationGeneration += 1;
    if (updateVerificationTimer !== null) {
      globalThis.clearTimeout(updateVerificationTimer);
      updateVerificationTimer = null;
    }
  };

  const waitForUpdateVerification = (delayMs: number, generation: number) =>
    new Promise<boolean>((resolve) => {
      const timer = globalThis.setTimeout(() => {
        if (updateVerificationTimer === timer) {
          updateVerificationTimer = null;
        }
        resolve(generation === updateVerificationGeneration && !disposed);
      }, delayMs);
      updateVerificationTimer = timer;
    });

  const verifyPendingUpdateVersion = async (client: NonNullable<typeof activeClient>) => {
    const generation = updateVerificationGeneration;
    const expectedVersion = pendingUpdateExpectedVersion?.trim() || null;
    const pendingHandoff = pendingUpdateHandoff;
    if (!expectedVersion && !pendingHandoff) {
      return;
    }
    const isCurrentVerification = () =>
      generation === updateVerificationGeneration &&
      !disposed &&
      activeClient === client &&
      gateway.snapshot.client === client &&
      gateway.snapshot.connected;
    const deadline =
      Date.now() +
      (pendingHandoff ? UPDATE_HANDOFF_TIMEOUT_MS : UPDATE_RESTART_VERIFICATION_TIMEOUT_MS);
    const pollMs = pendingHandoff ? UPDATE_HANDOFF_POLL_MS : UPDATE_RESTART_VERIFICATION_POLL_MS;
    while (isCurrentVerification() && Date.now() < deadline) {
      let response: UpdateRestartStatusResponse | null;
      try {
        response = await client.request<UpdateRestartStatusResponse>("update.status", {});
      } catch {
        response = null;
      }
      if (!isCurrentVerification()) {
        return;
      }
      const sentinel = response?.sentinel;
      if (isPendingUpdateHandoffSentinel(sentinel)) {
        if (!(await waitForUpdateVerification(pollMs, generation))) {
          return;
        }
        continue;
      }
      if (sentinel?.kind === "update" && sentinel.status && sentinel.status !== "ok") {
        pendingUpdateExpectedVersion = null;
        pendingUpdateHandoff = false;
        publishUpdateBanner(resolvePostRestartUpdateBanner(sentinel.stats?.reason));
        return;
      }
      const actualVersion = sentinel?.stats?.after?.version?.trim() || null;
      if (
        sentinel?.kind === "update" &&
        sentinel.status === "ok" &&
        !actualVersion &&
        !expectedVersion
      ) {
        pendingUpdateExpectedVersion = null;
        pendingUpdateHandoff = false;
        publish();
        return;
      }
      if (sentinel?.kind === "update" && actualVersion) {
        pendingUpdateExpectedVersion = null;
        pendingUpdateHandoff = false;
        publishUpdateBanner(
          expectedVersion && actualVersion !== expectedVersion
            ? resolveUpdateVerificationBanner({ expectedVersion, actualVersion })
            : null,
        );
        return;
      }
      if (!(await waitForUpdateVerification(pollMs, generation))) {
        return;
      }
    }
    if (!isCurrentVerification()) {
      return;
    }
    const currentVersion = gateway.snapshot.hello?.server?.version?.trim() || null;
    pendingUpdateExpectedVersion = null;
    pendingUpdateHandoff = false;
    publishUpdateBanner(
      expectedVersion && currentVersion !== expectedVersion
        ? resolveUpdateVerificationBanner({ expectedVersion, actualVersion: currentVersion })
        : pendingHandoff
          ? resolvePendingUpdateHandoffTimeoutBanner()
          : null,
    );
  };

  const stopGateway = gateway.subscribe((next) => {
    updateRunGeneration += 1;
    cancelUpdateVerification();
    const previousClient = activeClient;
    activeClient = next.client;
    promptState.client = next.client;
    devicePairSetupState.client = next.client;
    devicePairSetupState.connected = next.connected;
    if (previousClient !== next.client || !next.connected) {
      devicePairPendingCountGeneration += 1;
      closeDevicePairSetupState(devicePairSetupState);
      devicePairSetupState.pendingCount = 0;
    }
    if (!next.connected || !next.client) {
      promptState.execApprovalQueue = [];
      promptState.execApprovalBusy = false;
      promptState.execApprovalError = null;
      snapshot = { ...snapshot, updateAvailable: null, updateRunning: false };
      for (const timer of promptState.execApprovalExpiryTimers?.values() ?? []) {
        globalThis.clearTimeout(timer);
      }
      promptState.execApprovalExpiryTimers?.clear();
      publish();
      return;
    }
    snapshot = { ...snapshot, updateAvailable: readUpdateAvailable(next.hello) };
    if (previousClient !== next.client) {
      void refreshApprovals(next.client);
      if (next.client) {
        void verifyPendingUpdateVersion(next.client);
      }
    } else {
      publish();
    }
  });

  const stopEvents = gateway.subscribeEvents((event) => {
    if (disposed || !isGatewayEvent(event)) {
      return;
    }
    if (event.event === "device.pair.requested" || event.event === "device.pair.resolved") {
      void refreshDevicePairPendingCount();
      return;
    }
    if (event.event === GATEWAY_EVENT_UPDATE_AVAILABLE) {
      const payload = event.payload as GatewayUpdateAvailableEventPayload | undefined;
      snapshot = { ...snapshot, updateAvailable: payload?.updateAvailable ?? null };
      publish();
      return;
    }
    if (event.event === "exec.approval.requested") {
      const entry = parseExecApprovalRequested(event.payload);
      if (entry) {
        enqueueExecApprovalPrompt(promptState, entry);
        publish();
      }
      return;
    }
    if (event.event === "plugin.approval.requested") {
      const entry = parsePluginApprovalRequested(event.payload);
      if (entry) {
        enqueueExecApprovalPrompt(promptState, entry);
        publish();
      }
      return;
    }
    if (event.event === "exec.approval.resolved" || event.event === "plugin.approval.resolved") {
      const resolved = parseExecApprovalResolved(event.payload);
      if (resolved) {
        clearResolvedExecApprovalPrompt(promptState, resolved.id);
        publish();
      }
    }
  });

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async runUpdate() {
      const client = gateway.snapshot.client;
      if (!client || !gateway.snapshot.connected || disposed || snapshot.updateRunning) {
        return;
      }
      const generation = ++updateRunGeneration;
      snapshot = { ...snapshot, updateRunning: true, updateStatusBanner: null };
      publish();
      try {
        const response = await client.request<UpdateRunResponse>("update.run", {});
        if (
          disposed ||
          generation !== updateRunGeneration ||
          activeClient !== client ||
          gateway.snapshot.client !== client
        ) {
          return;
        }
        const status = response.result?.status ?? (response.ok === true ? "ok" : "error");
        const expectedVersion = response.result?.after?.version?.trim() || null;
        if (
          response.ok === true &&
          status === "skipped" &&
          response.result?.reason === UPDATE_HANDOFF_STARTED_REASON &&
          response.handoff?.status === "started"
        ) {
          pendingUpdateExpectedVersion = expectedVersion;
          pendingUpdateHandoff = true;
          return;
        }
        if (response.ok === true && status === "ok") {
          pendingUpdateExpectedVersion = expectedVersion;
          pendingUpdateHandoff = false;
          return;
        }
        pendingUpdateExpectedVersion = null;
        pendingUpdateHandoff = false;
        if (response.ok !== true || status !== "ok") {
          snapshot = {
            ...snapshot,
            updateStatusBanner: resolveUpdateStatusBanner({
              status,
              reason: response.result?.reason,
            }),
          };
        }
      } catch (error) {
        if (
          disposed ||
          generation !== updateRunGeneration ||
          activeClient !== client ||
          gateway.snapshot.client !== client
        ) {
          return;
        }
        snapshot = {
          ...snapshot,
          updateStatusBanner: {
            tone: "danger",
            text: `Update error: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      } finally {
        if (
          !disposed &&
          generation === updateRunGeneration &&
          activeClient === client &&
          gateway.snapshot.client === client
        ) {
          snapshot = { ...snapshot, updateRunning: false };
          publish();
        }
      }
    },
    dismissUpdate() {
      snapshot = { ...snapshot, updateAvailable: null };
      publish();
    },
    async decideApproval(decision) {
      const active = promptState.execApprovalQueue[0];
      const client = gateway.snapshot.client;
      if (!active || !client || promptState.execApprovalBusy || disposed) {
        return;
      }
      promptState.execApprovalBusy = true;
      promptState.execApprovalError = null;
      publish();
      try {
        const method =
          active.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
        await client.request(method, { id: active.id, decision });
        if (
          disposed ||
          activeClient !== client ||
          gateway.snapshot.client !== client ||
          !gateway.snapshot.connected
        ) {
          return;
        }
        dismissExecApprovalPrompt(promptState, active.id);
      } catch (error) {
        if (isStaleApprovalResolutionError(error)) {
          if (
            disposed ||
            activeClient !== client ||
            gateway.snapshot.client !== client ||
            !gateway.snapshot.connected
          ) {
            return;
          }
          dismissExecApprovalPrompt(promptState, active.id);
          const currentClient = activeClient;
          if (
            currentClient &&
            gateway.snapshot.client === currentClient &&
            gateway.snapshot.connected
          ) {
            await refreshApprovals(currentClient);
          }
          return;
        }
        if (promptState.execApprovalQueue.some((entry) => entry.id === active.id)) {
          promptState.execApprovalError = `Approval failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      } finally {
        promptState.execApprovalBusy = false;
        publish();
      }
    },
    async openDevicePairSetup() {
      if (disposed) {
        return;
      }
      devicePairSetupState.pendingCount = 0;
      const setupOperation = openDevicePairSetupState(devicePairSetupState);
      // Pairing-list latency must not keep a ready setup code behind the loading state.
      void refreshDevicePairPendingCount();
      publish();
      await setupOperation;
      if (!disposed) {
        publish();
      }
    },
    async refreshDevicePairSetup() {
      if (disposed) {
        return;
      }
      const operation = refreshDevicePairSetupState(devicePairSetupState);
      publish();
      await operation;
      if (!disposed) {
        publish();
      }
    },
    closeDevicePairSetup() {
      devicePairPendingCountGeneration += 1;
      closeDevicePairSetupState(devicePairSetupState);
      devicePairSetupState.pendingCount = 0;
      publish();
    },
    dispose() {
      disposed = true;
      updateRunGeneration += 1;
      devicePairPendingCountGeneration += 1;
      cancelUpdateVerification();
      closeDevicePairSetupState(devicePairSetupState);
      stopGateway();
      stopEvents();
      for (const timer of promptState.execApprovalExpiryTimers?.values() ?? []) {
        globalThis.clearTimeout(timer);
      }
      promptState.execApprovalExpiryTimers?.clear();
      listeners.clear();
    },
  };
}
