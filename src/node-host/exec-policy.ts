/** Evaluates node-host exec policy from security, approval, and allowlist context. */
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_ASK, DEFAULT_SECURITY } from "../infra/exec-approvals-config.js";
import {
  requiresExecApproval,
  resolveExecModePolicy,
  type ExecAsk,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";

/** One config owner for system.run and plugin-hosted execution. */
export function resolveNodeExecConfigPolicy(params: {
  cfg: OpenClawConfig;
  agentId: string | undefined;
}) {
  const agentExec = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.exec
    : undefined;
  const globalExec = params.cfg.tools?.exec;
  const layered = applyExecPolicyLayer(
    applyExecPolicyLayer({ security: DEFAULT_SECURITY, ask: DEFAULT_ASK }, globalExec),
    agentExec,
  );
  return { agentExec, globalExec, ...resolveExecModePolicy(layered) };
}

type ExecApprovalDecision = "allow-once" | "allow-always" | null;

/** Normalizes raw approval decisions from node-host payloads. */
export function resolveExecApprovalDecision(value: unknown): ExecApprovalDecision {
  if (value === "allow-once" || value === "allow-always") {
    return value;
  }
  return null;
}

/** Combines exec security, allowlist analysis, and approval state into an allow/deny decision. */
export function evaluateSystemRunPolicy(params: {
  security: ExecSecurity;
  ask: ExecAsk;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied?: boolean;
  approvalDecision: ExecApprovalDecision;
  approved?: boolean;
  isWindows: boolean;
  cmdInvocation: boolean;
  shellWrapperInvocation: boolean;
}) {
  // POSIX node execution intentionally uses `/bin/sh -lc` as a transport wrapper.
  // Keep allowlist decisions based on the analyzed inner shell payload there.
  // Windows `cmd.exe /c` wrappers still require explicit approval because they
  // change execution semantics for builtins and quoting/parsing behavior.
  const shellWrapperBlocked =
    params.security === "allowlist" &&
    params.shellWrapperInvocation &&
    params.isWindows &&
    params.cmdInvocation;
  const analysisOk = shellWrapperBlocked ? false : params.analysisOk;
  const allowlistSatisfied = shellWrapperBlocked ? false : params.allowlistSatisfied;
  const approvedByAsk = params.approvalDecision !== null || params.approved === true;
  const requiresAsk =
    params.security !== "deny" &&
    requiresExecApproval({
      ask: params.ask,
      security: params.security,
      analysisOk,
      allowlistSatisfied,
      durableApprovalSatisfied: params.durableApprovalSatisfied,
    });
  const context = {
    analysisOk,
    allowlistSatisfied,
    shellWrapperBlocked,
    approvalDecision: params.approvalDecision,
    approvedByAsk,
  };

  if (params.security === "deny") {
    return {
      allowed: false as const,
      eventReason: "security=deny" as const,
      errorMessage: "SYSTEM_RUN_DISABLED: security=deny",
      ...context,
    };
  }

  if (requiresAsk && !approvedByAsk) {
    return {
      allowed: false as const,
      eventReason: "approval-required" as const,
      errorMessage: "SYSTEM_RUN_DENIED: approval required",
      ...context,
    };
  }

  if (
    params.security === "allowlist" &&
    (!analysisOk || !allowlistSatisfied) &&
    !approvedByAsk &&
    !params.durableApprovalSatisfied
  ) {
    return {
      allowed: false as const,
      eventReason: "allowlist-miss" as const,
      errorMessage: shellWrapperBlocked
        ? "SYSTEM_RUN_DENIED: allowlist miss " +
          "(Windows shell wrappers like cmd.exe /c require approval; " +
          "approve once/always or run with --ask on-miss|always)"
        : "SYSTEM_RUN_DENIED: allowlist miss",
      ...context,
    };
  }

  return {
    allowed: true as const,
    ...context,
  };
}
