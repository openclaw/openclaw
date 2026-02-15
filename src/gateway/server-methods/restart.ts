import type { GatewayRequestHandlers } from "./types.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateGatewayRestartParams,
} from "../protocol/index.js";

const DEFAULT_RESTART_DELAY_MS = 2000;
const MAX_RESTART_DELAY_MS = 60_000;

function clampRestartDelayMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RESTART_DELAY_MS;
  }
  return Math.min(Math.max(Math.floor(value), 0), MAX_RESTART_DELAY_MS);
}

function clampOptionalMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

export const restartHandlers: GatewayRequestHandlers = {
  "gateway.restart": async ({ params, respond, context }) => {
    if (!validateGatewayRestartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid gateway.restart params: ${formatValidationErrors(validateGatewayRestartParams.errors)}`,
        ),
      );
      return;
    }

    const mode = (params as { mode?: "soft" | "hard" }).mode === "hard" ? "hard" : "soft";
    const delayMs = clampRestartDelayMs((params as { delayMs?: unknown }).delayMs);
    const reason =
      typeof (params as { reason?: unknown }).reason === "string"
        ? (params as { reason?: string }).reason?.trim() || undefined
        : undefined;
    const note =
      typeof (params as { note?: unknown }).note === "string"
        ? (params as { note?: string }).note?.trim() || undefined
        : undefined;
    const sessionKey =
      typeof (params as { sessionKey?: unknown }).sessionKey === "string"
        ? (params as { sessionKey?: string }).sessionKey?.trim() || undefined
        : undefined;
    const restartExpectedMs = clampOptionalMs(
      (params as { restartExpectedMs?: unknown }).restartExpectedMs,
    );

    const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
    const payload: RestartSentinelPayload = {
      kind: "restart",
      status: "ok",
      ts: Date.now(),
      sessionKey,
      deliveryContext,
      threadId,
      message: note ?? reason ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: `gateway.restart.${mode}`,
        reason: reason ?? null,
      },
    };

    try {
      await writeRestartSentinel(payload);
    } catch {
      // Sentinel is best-effort.
    }

    const scheduledAtMs = Date.now() + delayMs;
    respond(
      true,
      {
        ok: true,
        mode,
        scheduledAtMs,
        delayMs,
        reason,
        restartExpectedMs,
      },
      undefined,
    );

    if (mode === "hard") {
      setTimeout(() => {
        context.requestGatewayShutdown({
          reason: reason ?? "gateway.restart",
          restartExpectedMs: restartExpectedMs ?? null,
          exitAfterClose: true,
        });
      }, delayMs);
      return;
    }

    scheduleGatewaySigusr1Restart({
      delayMs,
      reason: reason ?? "gateway.restart",
    });
  },
};
