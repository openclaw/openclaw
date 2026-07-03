import type { GatewayBrowserClient } from "../../api/gateway.ts";

type UpdateStatusBanner = { tone: "danger" | "warn" | "info"; text: string };

export type ConfigUpdateState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  applySessionKey: string;
  updateRunning: boolean;
  pendingUpdateExpectedVersion: string | null;
  pendingUpdateHandoff: boolean;
  updateStatusBanner: UpdateStatusBanner | null;
  lastError: string | null;
  chatError?: string | null;
};

const UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";

function resolveUpdateStatusBanner(params: {
  status?: string;
  reason?: string;
  handoff?: { command?: string; message?: string };
}): UpdateStatusBanner {
  const status = (params.status ?? "error").trim() || "error";
  const reason = (params.reason ?? "unexpected-error").trim() || "unexpected-error";
  const tone = status === "skipped" ? "warn" : "danger";
  const handoffCommand = params.handoff?.command?.trim();
  const handoffMessage = params.handoff?.message?.trim();
  const handoffUnavailableGuidance = handoffCommand
    ? `Run \`${handoffCommand}\` from a shell outside the Gateway process.`
    : (handoffMessage ??
      "OpenClaw could not find a safe supervisor handoff. Run `openclaw update` from a shell outside the Gateway process.");
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
        "The update was not applied because gateway restarts are disabled. Enable restarts in config, then retry — or run `openclaw update` from the CLI.",
      "restart-unavailable":
        "This global install cannot be safely replaced while restarts are disabled and no supervisor is present.",
      "managed-service-handoff-unavailable": handoffUnavailableGuidance,
      "restart-unhealthy":
        "The replacement process never became healthy. The previous process stayed up so you can recover.",
      "doctor-failed": "Doctor repair failed. Run `openclaw doctor --non-interactive` and retry.",
    }[reason] ?? "See the gateway logs for the exact failure and retry once the cause is fixed.";
  return {
    tone,
    text: `Update ${status}: ${reason}. ${guidance}`,
  };
}

export async function runUpdate(state: ConfigUpdateState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.updateRunning = true;
  state.lastError = null;
  state.chatError = null;
  state.updateStatusBanner = null;
  try {
    const res = await state.client.request<{
      ok?: boolean;
      result?: { status?: string; reason?: string; after?: { version?: string | null } };
      handoff?: { status?: string; command?: string; message?: string };
    }>("update.run", {
      sessionKey: state.applySessionKey,
    });
    const status = res.result?.status ?? (res.ok === true ? "ok" : "error");
    const handoffStarted =
      res.ok === true &&
      status === "skipped" &&
      res.result?.reason === UPDATE_HANDOFF_STARTED_REASON &&
      res.handoff?.status === "started";
    if (handoffStarted) {
      state.pendingUpdateExpectedVersion = res.result?.after?.version ?? null;
      state.pendingUpdateHandoff = true;
      return;
    }
    if (status === "ok" && res.ok === true) {
      state.pendingUpdateExpectedVersion = res.result?.after?.version ?? null;
      state.pendingUpdateHandoff = false;
      return;
    }
    state.pendingUpdateExpectedVersion = null;
    state.pendingUpdateHandoff = false;
    state.updateStatusBanner = resolveUpdateStatusBanner({
      status,
      reason: res.result?.reason,
      handoff: res.handoff,
    });
  } catch (err) {
    state.lastError = String(err);
    state.pendingUpdateExpectedVersion = null;
    state.pendingUpdateHandoff = false;
  } finally {
    state.updateRunning = false;
  }
}
