// Manages exec approval policy, allowlist entries, and host targeting.
import {
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsDefaultOverrides } from "./exec-approvals-contracts.js";
import type {
  ExecApprovalsFile,
  ExecApprovalsResolved,
  ExecApprovalsSnapshot,
} from "./exec-approvals-core.js";
import { resolveExecApprovalsFromFileInternal } from "./exec-approvals-resolver.js";
import { ensureExecApprovalsSnapshot, loadExecApprovals } from "./exec-approvals-store.js";
import { expandHomePrefix } from "./home-dir.js";

export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";
export * from "./exec-approvals-core.js";
export * from "./exec-approvals-generated-migration.js";
export type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
export type { AllowAlwaysPattern, ExecAllowlistEntry } from "./exec-approvals.types.js";
export type { ExecApprovalsDefaultOverrides } from "./exec-approvals-contracts.js";
export {
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  normalizeExecApprovalsInternal as normalizeExecApprovals,
  resolveExecApprovalsDisplayPath,
} from "./exec-approvals-config.js";
export { resolveExecApprovalsFromFileInternal as resolveExecApprovalsFromFile } from "./exec-approvals-resolver.js";
export {
  ensureExecApprovalsSnapshot,
  loadExecApprovals,
  loadExecApprovalsReadOnly,
  readExecApprovalsSnapshot,
  readExecApprovalsSnapshotAsync,
  restoreExecApprovalsSnapshotLocked,
  updateExecApprovals,
  withAgentExecApprovalsRemoved,
} from "./exec-approvals-store.js";

export function redactExecApprovals(
  snapshot: Omit<ExecApprovalsSnapshot, "raw"> & { raw?: ExecApprovalsSnapshot["raw"] },
): Omit<ExecApprovalsSnapshot, "raw"> {
  const { raw: _raw, ...rest } = snapshot;
  const socketPath = snapshot.file.socket?.path?.trim();
  // Socket connection material is runtime-only; presentation boundaries need only its path.
  return {
    ...rest,
    file: {
      ...snapshot.file,
      socket: socketPath ? { path: socketPath } : undefined,
    },
  };
}

function shapeResolvedExecApprovals(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  socket: "none" | "persisted";
}): ExecApprovalsResolved {
  const defaultSocketPath = resolveExecApprovalsSocketPath();
  return resolveExecApprovalsFromFileInternal({
    file: params.file,
    agentId: params.agentId,
    overrides: params.overrides,
    path: params.filePath,
    socketPath:
      params.socket === "persisted"
        ? expandHomePrefix(params.file.socket?.path ?? defaultSocketPath)
        : defaultSocketPath,
    token: params.socket === "persisted" ? (params.file.socket?.token ?? "") : "",
  });
}

export async function resolveExecApprovalsLocked(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): Promise<ExecApprovalsResolved> {
  const filePath = resolveExecApprovalsDisplayPath();
  if (!overrides?.requireSocket) {
    const file = loadExecApprovals();
    const resolved = shapeResolvedExecApprovals({
      file,
      filePath,
      agentId,
      overrides,
      socket: "none",
    });
    if (
      (resolved.agent.security === "full" || resolved.agent.security === "deny") &&
      resolved.agent.ask === "off" &&
      !file.socket?.token?.trim()
    ) {
      return resolved;
    }
  }
  return shapeResolvedExecApprovals({
    file: (await ensureExecApprovalsSnapshot()).file,
    filePath: resolveExecApprovalsDisplayPath(),
    agentId,
    overrides,
    socket: "persisted",
  });
}

export {
  maxAsk,
  minSecurity,
  normalizeExecApprovalUnavailableDecisions,
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalRequestAllowedDecisions,
  resolveExecApprovalUnavailableDecisions,
} from "./exec-approvals-policy.js";
export {
  createExecApprovalPolicySnapshot,
  hasDurableExecApproval,
  hasExactCommandDurableExecApproval,
  hasNodeCommandAllowAlwaysMarker,
  isExecApprovalPolicySnapshotCurrent,
  resolveAllowAlwaysPatternCoverage,
  resolveAllowAlwaysPersistenceDecision,
  resolveDurableExecApprovalRequirement,
} from "./exec-approvals-allow-always.js";
export type { AllowAlwaysPersistenceDecision } from "./exec-approvals-contracts.js";
export {
  commitExecAuthorizationLocked,
  recordAllowlistMatchesUse,
} from "./exec-approvals-authorization.js";
export type { ExecApprovalUsageAuthorization } from "./exec-approvals-authorization.js";
