import type { NodePermissionDetails } from "../../packages/gateway-protocol/src/node-permissions.js";
import type { ExecEventPayload } from "./invoke-types.js";

export type SystemRunInvokeResult = {
  ok: boolean;
  payloadJSON?: string | null;
  error?: { code?: string; message?: string; details?: NodePermissionDetails } | null;
};

export type SystemRunDeniedReason =
  | "security=deny"
  | "approval-required"
  | "auto-review-denied"
  | "approval-state-write-failed"
  | "allowlist-miss"
  | "execution-plan-miss"
  | "companion-unavailable"
  | "cwd-unavailable"
  | "permission:screenRecording";

export function normalizeDeniedReason(reason: string | null | undefined): SystemRunDeniedReason {
  switch (reason) {
    case "security=deny":
    case "approval-required":
    case "allowlist-miss":
    case "execution-plan-miss":
    case "companion-unavailable":
    case "cwd-unavailable":
    case "permission:screenRecording":
      return reason;
    default:
      return "approval-required";
  }
}

export async function sendSystemRunDenied(
  opts: {
    sendNodeEvent?: (event: string, payload: ExecEventPayload) => Promise<void>;
    sendInvokeResult: (result: SystemRunInvokeResult) => Promise<void>;
  },
  execution: Pick<ExecEventPayload, "sessionKey" | "runId" | "suppressNotifyOnExit"> & {
    commandText: string;
  },
  message: string,
  reason: SystemRunDeniedReason = "approval-required",
  permissionDetails?: NodePermissionDetails,
): Promise<null> {
  await opts.sendNodeEvent?.("exec.denied", {
    sessionKey: execution.sessionKey,
    runId: execution.runId,
    host: "node",
    command: execution.commandText,
    reason,
    suppressNotifyOnExit: execution.suppressNotifyOnExit,
  });
  await opts.sendInvokeResult({
    ok: false,
    // A missing companion reply can follow execution; it is not a policy denial.
    error: {
      code: permissionDetails
        ? "PERMISSION_MISSING"
        : reason === "companion-unavailable"
          ? "UNAVAILABLE"
          : "SYSTEM_RUN_DENIED",
      message,
      ...(permissionDetails ? { details: permissionDetails } : {}),
    },
  });
  return null;
}
