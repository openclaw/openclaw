import { requiresExecApproval, type ExecAsk, type ExecSecurity } from "../infra/exec-approvals.js";

export type ExecApprovalDecision = "allow-once" | "allow-always" | null;

export type SystemRunPolicyDecision = {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  windowsShellWrapperBlocked: boolean;
  requiresAsk: boolean;
  approvalDecision: ExecApprovalDecision;
  approvedByAsk: boolean;
} & (
  | {
      allowed: true;
    }
  | {
      allowed: false;
      eventReason: "security=deny" | "approval-required" | "allowlist-miss";
      errorMessage: string;
    }
);

export function resolveExecApprovalDecision(value: unknown): ExecApprovalDecision {
  if (value === "allow-once" || value === "allow-always") {
    return value;
  }
  return null;
}

export function formatSystemRunAllowlistMissMessage(params?: {
  windowsShellWrapperBlocked?: boolean;
}): string {
  if (params?.windowsShellWrapperBlocked) {
    return (
      "SYSTEM_RUN_DENIED: allowlist miss " +
      "(Windows shell wrappers like cmd.exe /c require approval; " +
      "approve once/always or run with --ask on-miss|always)"
    );
  }
  return "SYSTEM_RUN_DENIED: allowlist miss";
}

export function evaluateSystemRunPolicy(params: {
  security: ExecSecurity;
  ask: ExecAsk;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  approvalDecision: ExecApprovalDecision;
  approved?: boolean;
  isWindows: boolean;
  cmdInvocation: boolean;
}): SystemRunPolicyDecision {
  const windowsShellWrapperBlocked =
    params.security === "allowlist" && params.isWindows && params.cmdInvocation;
  const analysisOk = windowsShellWrapperBlocked ? false : params.analysisOk;
  const allowlistSatisfied = windowsShellWrapperBlocked ? false : params.allowlistSatisfied;
  const approvedByAsk = params.approvalDecision !== null || params.approved === true;

  if (params.security === "deny") {
    return {
      allowed: false,
      eventReason: "security=deny",
      errorMessage: "SYSTEM_RUN_DISABLED: security=deny",
      analysisOk,
      allowlistSatisfied,
      windowsShellWrapperBlocked,
      requiresAsk: false,
      approvalDecision: params.approvalDecision,
      approvedByAsk,
    };
  }

  const requiresAsk = requiresExecApproval({
    ask: params.ask,
    security: params.security,
    analysisOk,
    allowlistSatisfied,
  });
  if (requiresAsk && !approvedByAsk) {
    return {
      allowed: false,
      eventReason: "approval-required",
      errorMessage: "SYSTEM_RUN_DENIED: approval required",
      analysisOk,
      allowlistSatisfied,
      windowsShellWrapperBlocked,
      requiresAsk,
      approvalDecision: params.approvalDecision,
      approvedByAsk,
    };
  }

  if (params.security === "allowlist" && (!analysisOk || !allowlistSatisfied) && !approvedByAsk) {
    return {
      allowed: false,
      eventReason: "allowlist-miss",
      errorMessage: formatSystemRunAllowlistMissMessage({ windowsShellWrapperBlocked }),
      analysisOk,
      allowlistSatisfied,
      windowsShellWrapperBlocked,
      requiresAsk,
      approvalDecision: params.approvalDecision,
      approvedByAsk,
    };
  }

  return {
    allowed: true,
    analysisOk,
    allowlistSatisfied,
    windowsShellWrapperBlocked,
    requiresAsk,
    approvalDecision: params.approvalDecision,
    approvedByAsk,
  };
}
