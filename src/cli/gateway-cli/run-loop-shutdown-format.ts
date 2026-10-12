import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS,
  type GatewayBootLifecycleCompletion,
} from "../../infra/gateway-boot-lifecycle.js";
import { TailscaleBackendStoppedError } from "../../infra/tailscale-backend-stopped-error.js";
import type { GatewayDrainReason } from "../../process/gateway-work-admission.js";
import type { GatewayRunSignalRequest } from "./run-loop-request.js";

export function formatBootCompletionContext(
  completion: GatewayBootLifecycleCompletion,
  ...reasons: (string | undefined)[]
): GatewayBootLifecycleCompletion {
  const context = reasons.filter(Boolean).join("; ");
  return context
    ? {
        ...completion,
        reason: truncateUtf16Safe(
          `${context}; ${completion.reason ?? completion.outcome}`,
          GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS,
        ),
      }
    : completion;
}

export function formatShutdownReason(
  request: Pick<GatewayRunSignalRequest, "action" | "signal" | "restartReason">,
): GatewayDrainReason {
  const { action, signal, restartReason } = request;
  const trigger =
    restartReason && restartReason !== signal
      ? (`${signal}: ${truncateUtf16Safe(restartReason.replaceAll(/\s+/g, " "), 200)}` as const)
      : signal;
  return `${action === "stop" ? "stop" : "restart"} (${trigger})`;
}

export function formatShutdownCompletion(
  request: Parameters<typeof formatShutdownReason>[0],
  failed: boolean,
): GatewayBootLifecycleCompletion {
  return request.action !== "stop"
    ? { outcome: "planned_restart", reason: formatShutdownReason(request) }
    : {
        outcome: failed ? "forced_stop" : "clean_stop",
        reason: failed ? "gateway.stop_close_failed" : formatShutdownReason(request),
      };
}

export function formatRestartCompletion(
  request: Parameters<typeof formatShutdownReason>[0] | null,
  failed: boolean,
): GatewayBootLifecycleCompletion {
  return failed
    ? { outcome: "forced_stop", reason: "gateway.restart_close_failed" }
    : {
        outcome: "planned_restart",
        reason: request ? formatShutdownReason(request) : "gateway.restart",
      };
}

export function formatStartupFailureCompletion(
  error: unknown,
  startupReason?: GatewayBootLifecycleCompletion["startupReason"],
): GatewayBootLifecycleCompletion {
  // Only the exact pre-channel prerequisite error qualifies. Cleanup failures wrap it and
  // remain genuine unclean boots; matching error messages never bypass the breaker.
  const reason =
    startupReason ?? (error instanceof TailscaleBackendStoppedError ? error.code : undefined);
  return {
    outcome: "startup_failed",
    reason: truncateUtf16Safe(formatErrorMessage(error), GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS),
    ...(reason ? { startupReason: reason } : {}),
  };
}

export function formatHostExitCompletion(failed: boolean): GatewayBootLifecycleCompletion {
  return {
    outcome: failed ? "forced_stop" : "clean_stop",
    reason: failed ? "gateway.restart_close_failed" : "stop (host lifeline closed)",
  };
}
