import type { GatewayRequestHandlers } from "./types.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

function parseRestartDelayMs(value: unknown): number | undefined {
  // Be liberal in what we accept: callers may pass numbers as strings due to env/flag interpolation.
  const nRaw =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
        ? Number(value)
        : null;
  if (nRaw === null || !Number.isFinite(nRaw)) {
    return undefined;
  }
  // Match scheduleGatewaySigusr1Restart clamping (0..60000) so behavior is obvious to callers.
  const ms = Math.floor(nRaw);
  return Math.min(Math.max(ms, 0), 60_000);
}

export const gatewayHandlers: GatewayRequestHandlers = {
  "gateway.restart": async ({ params, respond, context }) => {
    const reasonRaw = (params as { reason?: unknown }).reason;
    const noteRaw = (params as { note?: unknown }).note;
    const sessionKeyRaw = (params as { sessionKey?: unknown }).sessionKey;
    const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;

    const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
    const note = typeof noteRaw === "string" ? noteRaw.trim() : "";
    const sessionKey =
      typeof sessionKeyRaw === "string" ? sessionKeyRaw.trim() || undefined : undefined;

    const restartDelayMs = parseRestartDelayMs(restartDelayMsRaw);

    const restartReason = reason || "gateway.restart";

    const payload: RestartSentinelPayload = {
      kind: "restart",
      status: "ok",
      ts: Date.now(),
      sessionKey,
      message: note || reason || null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: "gateway.restart",
        reason: restartReason,
      },
    };

    let sentinelPath: string | null = null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
    } catch (err) {
      context.logGateway.warn(`failed to write restart sentinel: ${String(err)}`);
      sentinelPath = null;
    }

    const restart = scheduleGatewaySigusr1Restart({
      delayMs: restartDelayMs,
      reason: restartReason,
    });

    if (!restart.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "restart scheduling failed"));
      return;
    }

    respond(
      true,
      {
        ok: true,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
