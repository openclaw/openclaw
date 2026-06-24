import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import type { GatewayEventFrame, GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable } from "../api/types.ts";
import type { ApplicationGateway } from "./context.ts";
import {
  clearResolvedExecApprovalPrompt,
  dismissExecApprovalPrompt,
  enqueueExecApprovalPrompt,
  isStaleApprovalResolutionError,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  parsePluginApprovalRequested,
  pruneExecApprovalQueue,
  refreshPendingApprovalQueue,
  type ExecApprovalDecision,
  type ExecApprovalPromptState,
  type ExecApprovalRequest,
} from "./exec-approval.ts";

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
};

export type ApplicationOverlays = {
  readonly snapshot: ApplicationOverlaySnapshot;
  subscribe: (listener: (snapshot: ApplicationOverlaySnapshot) => void) => () => void;
  runUpdate: (sessionKey: string) => Promise<void>;
  dismissUpdate: () => void;
  decideApproval: (decision: ExecApprovalDecision) => Promise<void>;
  dispose: () => void;
};

const UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";

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

function isGatewayEvent(value: unknown): value is GatewayEventFrame {
  return Boolean(value && typeof value === "object" && "event" in value);
}

export function createApplicationOverlays(gateway: ApplicationGateway): ApplicationOverlays {
  let snapshot: ApplicationOverlaySnapshot = {
    updateAvailable: null,
    updateRunning: false,
    updateStatusBanner: null,
    approvalQueue: [],
    approvalBusy: false,
    approvalError: null,
  };
  const listeners = new Set<(next: ApplicationOverlaySnapshot) => void>();
  const expiryTimers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  let disposed = false;
  let activeClient = gateway.snapshot.client;
  const promptState: ExecApprovalPromptState = {
    client: activeClient,
    execApprovalQueue: [],
    execApprovalBusy: false,
    execApprovalError: null,
  };

  const publish = () => {
    snapshot = {
      updateAvailable: snapshot.updateAvailable,
      updateRunning: snapshot.updateRunning,
      updateStatusBanner: snapshot.updateStatusBanner,
      approvalQueue: promptState.execApprovalQueue,
      approvalBusy: promptState.execApprovalBusy,
      approvalError: promptState.execApprovalError,
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const scheduleExpiryPublish = (entry: ExecApprovalRequest) => {
    const timer = globalThis.setTimeout(
      () => {
        expiryTimers.delete(timer);
        if (disposed) {
          return;
        }
        promptState.execApprovalQueue = pruneExecApprovalQueue(promptState.execApprovalQueue);
        publish();
      },
      Math.max(0, entry.expiresAtMs - Date.now() + 500),
    );
    expiryTimers.add(timer);
  };

  const refreshApprovals = async () => {
    await refreshPendingApprovalQueue(promptState);
    if (!disposed) {
      publish();
      for (const entry of promptState.execApprovalQueue) {
        scheduleExpiryPublish(entry);
      }
    }
  };

  const stopGateway = gateway.subscribe((next) => {
    const previousClient = activeClient;
    activeClient = next.client;
    promptState.client = next.client;
    if (!next.connected || !next.client) {
      promptState.execApprovalQueue = [];
      promptState.execApprovalError = null;
      snapshot = { ...snapshot, updateAvailable: null };
      publish();
      return;
    }
    snapshot = { ...snapshot, updateAvailable: readUpdateAvailable(next.hello) };
    if (previousClient !== next.client) {
      void refreshApprovals();
    } else {
      publish();
    }
  });

  const stopEvents = gateway.subscribeEvents((event) => {
    if (disposed || !isGatewayEvent(event)) {
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
        scheduleExpiryPublish(entry);
        publish();
      }
      return;
    }
    if (event.event === "plugin.approval.requested") {
      const entry = parsePluginApprovalRequested(event.payload);
      if (entry) {
        enqueueExecApprovalPrompt(promptState, entry);
        scheduleExpiryPublish(entry);
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
    async runUpdate(sessionKey) {
      const client = gateway.snapshot.client;
      if (!client || !gateway.snapshot.connected || disposed || snapshot.updateRunning) {
        return;
      }
      snapshot = { ...snapshot, updateRunning: true, updateStatusBanner: null };
      publish();
      try {
        const response = await client.request<{
          ok?: boolean;
          result?: { status?: string; reason?: string };
          handoff?: { status?: string };
        }>("update.run", { sessionKey });
        const status = response.result?.status ?? (response.ok === true ? "ok" : "error");
        if (
          response.ok === true &&
          status === "skipped" &&
          response.result?.reason === UPDATE_HANDOFF_STARTED_REASON &&
          response.handoff?.status === "started"
        ) {
          return;
        }
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
        snapshot = {
          ...snapshot,
          updateStatusBanner: {
            tone: "danger",
            text: `Update error: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      } finally {
        snapshot = { ...snapshot, updateRunning: false };
        publish();
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
        dismissExecApprovalPrompt(promptState, active.id);
      } catch (error) {
        if (isStaleApprovalResolutionError(error)) {
          dismissExecApprovalPrompt(promptState, active.id);
          await refreshApprovals();
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
    dispose() {
      disposed = true;
      stopGateway();
      stopEvents();
      for (const timer of expiryTimers) {
        globalThis.clearTimeout(timer);
      }
      expiryTimers.clear();
      listeners.clear();
    },
  };
}
