import { normalizeExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
import type { SystemRunApprovalFileOperand, SystemRunApprovalPlan } from "./exec-approvals.js";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";

function normalizeSystemRunApprovalFileOperand(
  value: unknown,
): SystemRunApprovalFileOperand | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // SAFETY: Non-null, non-array object; each unknown field is validated below.
  const candidate = value as Record<string, unknown>;
  const argvIndex =
    typeof candidate.argvIndex === "number" &&
    Number.isInteger(candidate.argvIndex) &&
    candidate.argvIndex >= 0
      ? candidate.argvIndex
      : null;
  const filePath = normalizeNonEmptyString(candidate.path);
  const sha256 = normalizeNonEmptyString(candidate.sha256);
  if (argvIndex === null || !filePath || !sha256) {
    return null;
  }
  return {
    argvIndex,
    path: filePath,
    sha256,
  };
}

export function normalizeSystemRunApprovalPlan(value: unknown): SystemRunApprovalPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // SAFETY: Non-null, non-array object; each unknown field is validated below.
  const candidate = value as Record<string, unknown>;
  const argv = normalizeStringArray(candidate.argv);
  if (argv.length === 0) {
    return null;
  }
  const mutableFileOperand = normalizeSystemRunApprovalFileOperand(candidate.mutableFileOperand);
  if (candidate.mutableFileOperand !== undefined && mutableFileOperand === null) {
    return null;
  }
  const policySnapshot = normalizeExecApprovalPolicySnapshot(candidate.policySnapshot);
  if (candidate.policySnapshot !== undefined && policySnapshot === null) {
    return null;
  }
  const commandText =
    normalizeNonEmptyString(candidate.commandText) ?? normalizeNonEmptyString(candidate.rawCommand);
  if (!commandText) {
    return null;
  }
  return {
    argv,
    cwd: normalizeNonEmptyString(candidate.cwd),
    commandText,
    commandPreview: normalizeNonEmptyString(candidate.commandPreview),
    agentId: normalizeNonEmptyString(candidate.agentId),
    sessionKey: normalizeNonEmptyString(candidate.sessionKey),
    ...(policySnapshot ? { policySnapshot } : {}),
    mutableFileOperand: mutableFileOperand ?? undefined,
  };
}
