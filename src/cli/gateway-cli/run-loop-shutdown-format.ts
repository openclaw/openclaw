import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import {
  GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS,
  type GatewayBootLifecycleCompletion,
} from "../../infra/gateway-boot-lifecycle.js";
import type {
  GatewayDrainReason,
  GatewayShutdownTrigger,
} from "../../process/gateway-work-admission.js";

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

export function formatShutdownReason(request: {
  action: "stop" | "restart" | "external-restart";
  signal: GatewayShutdownTrigger;
  restartReason?: string;
}): GatewayDrainReason {
  const { action, signal, restartReason } = request;
  const trigger =
    restartReason && restartReason !== signal
      ? (`${signal}: ${truncateUtf16Safe(restartReason.replaceAll(/\s+/g, " "), 200)}` as const)
      : signal;
  return `${action === "stop" ? "stop" : "restart"} (${trigger})`;
}

// Blocker descriptions can contain task identities and request origins.
export function formatDrainCounts(snapshot: GatewayActiveWorkSnapshot): string {
  return Object.entries(snapshot.counts)
    .filter(([name, count]) => name !== "totalActive" && count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
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
  return {
    outcome: "startup_failed",
    reason: truncateUtf16Safe(formatErrorMessage(error), GATEWAY_BOOT_REASON_MAX_UTF16_CODE_UNITS),
    ...(startupReason ? { startupReason } : {}),
  };
}

export function formatHostExitCompletion(failed: boolean): GatewayBootLifecycleCompletion {
  return {
    outcome: failed ? "forced_stop" : "clean_stop",
    reason: failed ? "gateway.restart_close_failed" : "stop (host lifeline closed)",
  };
}
