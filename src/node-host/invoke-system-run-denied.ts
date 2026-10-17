import type { NodePermissionDetails } from "../../packages/gateway-protocol/src/node-permissions.js";
import { EXEC_AUTO_REVIEW_DENIAL_GUIDANCE } from "../infra/exec-auto-review.js";
import type { ExecEventPayload } from "./invoke-types.js";

export const APPROVAL_SCRIPT_OPERAND_BINDING_DENIED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval missing script operand binding";
export const APPROVAL_STATE_WRITE_FAILED_MESSAGE =
  "SYSTEM_RUN_DENIED: approval state could not be persisted";

const EXEC_SECURITY_POLICY_DENIAL_GUIDANCE =
  "Execution is disabled by policy. Do not attempt to bypass or work around this restriction. Ask the operator to change the exec security policy if this command is required.";

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
  | "timeout"
  | "response-lost"
  | "cwd-unavailable"
  | "permission:screenRecording";

const transportErrorCodes: Partial<Record<SystemRunDeniedReason, string>> = {
  "companion-unavailable": "UNAVAILABLE",
  timeout: "TIMEOUT",
  "response-lost": "UNKNOWN",
};

export function normalizeDeniedReason(reason: string | null | undefined): SystemRunDeniedReason {
  switch (reason) {
    case "security=deny":
    case "approval-required":
    case "allowlist-miss":
    case "execution-plan-miss":
    case "companion-unavailable":
    case "timeout":
    case "response-lost":
    case "cwd-unavailable":
    case "permission:screenRecording":
      return reason;
    default:
      return "approval-required";
  }
}

export function appendExecDenialGuidance(
  message: string,
  reason: string | null | undefined,
): string {
  const normalizedReason = normalizeDeniedReason(reason);
  const guidance =
    normalizedReason === "security=deny"
      ? EXEC_SECURITY_POLICY_DENIAL_GUIDANCE
      : normalizedReason === "allowlist-miss"
        ? EXEC_AUTO_REVIEW_DENIAL_GUIDANCE
        : undefined;
  return guidance && !message.includes(guidance) ? `${message}\n${guidance}` : message;
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
    // A missing or late companion reply can follow execution; it is not a policy denial.
    error: {
      code: permissionDetails
        ? "PERMISSION_MISSING"
        : (transportErrorCodes[reason] ?? "SYSTEM_RUN_DENIED"),
      message,
      ...(permissionDetails ? { details: permissionDetails } : {}),
    },
  });
  return null;
}
