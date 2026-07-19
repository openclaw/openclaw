// Formats update-restart sentinel state for status reports.
// The sentinel is written by update flows; status only turns it into operator-facing hints.

import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import {
  CONTROL_PLANE_UPDATE_CONFIRMATION_PENDING_REASON,
  CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON,
  CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON,
} from "../infra/update-control-plane-sentinel.js";

type Formatter = (value: string) => string;

function readReason(payload: RestartSentinelPayload): string | null {
  const reason = payload.stats?.reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}

function readAfterVersion(payload: RestartSentinelPayload): string | null {
  const version = payload.stats?.after?.version;
  return typeof version === "string" && version.trim().length > 0 ? version : null;
}

function isUpdateTransactionConfirmed(payload: RestartSentinelPayload): boolean {
  return payload.stats?.confirmationTier === "human"
    ? payload.stats.confirmationStatus === "human-confirmed"
    : payload.stats?.confirmationStatus === "delivery-acked";
}

/** Returns the one-line update restart status value, or null when no update sentinel applies. */
export function formatUpdateRestartStatusValue(
  payload: RestartSentinelPayload | null | undefined,
  opts: {
    ok?: Formatter;
    warn?: Formatter;
    muted?: Formatter;
    nowMs?: number;
    formatTimeAgo?: (ageMs: number) => string;
  } = {},
): string | null {
  if (!payload || payload.kind !== "update") {
    return null;
  }

  const age =
    opts.formatTimeAgo && Number.isFinite(payload.ts)
      ? ` · ${opts.formatTimeAgo(Math.max(0, (opts.nowMs ?? Date.now()) - payload.ts))}`
      : "";
  const reason = readReason(payload);
  const warn = opts.warn ?? ((value: string) => value);
  const ok = opts.ok ?? ((value: string) => value);
  const muted = opts.muted ?? ((value: string) => value);

  if (payload.status === "error") {
    if (reason?.startsWith("update-rollback-completed")) {
      return warn(`rolled back · previous package and state restored${age}`);
    }
    if (reason?.startsWith("update-rollback-failed")) {
      return warn(`rollback failed · run openclaw doctor --deep${age}`);
    }
    return warn(
      `failed · ${reason ?? "restart failed"} · run openclaw gateway status --deep${age}`,
    );
  }

  if (payload.status === "skipped") {
    if (reason === CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON) {
      // Handoff already started in the control plane; gateway restart should not be duplicated.
      return warn(`handoff running · gateway restart pending · run openclaw update status${age}`);
    }
    if (reason === CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON) {
      // Restart completed enough to defer, but health proof still needs a deep gateway check.
      return warn(`restart pending health verification · run openclaw gateway status --deep${age}`);
    }
    if (reason === CONTROL_PLANE_UPDATE_CONFIRMATION_PENDING_REASON) {
      if (isUpdateTransactionConfirmed(payload)) {
        return ok(`confirmed · cleanup pending${age}`);
      }
      const phase = payload.stats?.updatePhase ?? "restart";
      const tier = payload.stats?.confirmationTier ?? "delivery";
      return warn(`update ${phase} · awaiting ${tier} confirmation${age}`);
    }
    return muted(`skipped · ${reason ?? "restart skipped"}${age}`);
  }

  const version = readAfterVersion(payload);
  return ok(`verified${version ? ` · gateway ${version}` : ""}${age}`);
}

/** Returns follow-up action lines for update restart failures or pending handoffs. */
export function formatUpdateRestartActionLines(
  payload: RestartSentinelPayload | null | undefined,
): string[] {
  if (!payload || payload.kind !== "update") {
    return [];
  }
  if (payload.status === "error") {
    return [
      "Update restart failed; run openclaw gateway status --deep.",
      "If the service is down, run openclaw gateway restart or openclaw gateway install --force.",
    ];
  }
  const reason = readReason(payload);
  if (
    payload.status === "skipped" &&
    (reason === CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON ||
      reason === CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON ||
      (reason === CONTROL_PLANE_UPDATE_CONFIRMATION_PENDING_REASON &&
        !isUpdateTransactionConfirmed(payload)))
  ) {
    return [
      "Update restart is still pending; run openclaw update status --json for handoff state.",
      "If it stays pending, run openclaw gateway status --deep.",
    ];
  }
  return [];
}

/** Doctor-ready transaction detail without mutating the update marker. */
export function formatUpdateTransactionDoctorLines(
  payload: RestartSentinelPayload | null | undefined,
): string[] {
  if (!payload || payload.kind !== "update" || !payload.stats?.updatePhase) {
    return [];
  }
  return [
    `Update transaction: phase=${payload.stats.updatePhase}; confirmation=${payload.stats.confirmationTier ?? "delivery"}/${payload.stats.confirmationStatus ?? "pending"}.`,
    ...(payload.stats.reason ? [`Update transaction reason: ${payload.stats.reason}`] : []),
  ];
}
