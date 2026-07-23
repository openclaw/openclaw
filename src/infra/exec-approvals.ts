// Public facade for exec approval policy, persistence, and socket services.
export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";
export type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
export type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  EXEC_TARGET_VALUES,
  normalizeExecAsk,
  normalizeExecHost,
  normalizeExecMode,
  normalizeExecSecurity,
  normalizeExecTarget,
  requireValidExecTarget,
  resolveExecModeFromPolicy,
  resolveExecModePolicy,
  resolveExecPolicyForMode,
} from "./exec-approvals-core.js";
export type {
  ExecApprovalCommandSpan,
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
  ExecApprovalResolved,
  ExecApprovalUnavailableDecision,
  ExecApprovalsAgent,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecApprovalsResolved,
  ExecApprovalsSnapshot,
  ExecAsk,
  ExecHost,
  ExecMode,
  ExecSecurity,
  ExecTarget,
  SystemRunApprovalBinding,
  SystemRunApprovalFileOperand,
  SystemRunApprovalPlan,
} from "./exec-approvals-core.js";

export {
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  mergeExecApprovalsSocketDefaults,
  normalizeExecApprovals,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
  resolveExecApprovalsTranscriptPath,
} from "./exec-approvals-config.js";

export {
  ensureExecApprovals,
  ensureExecApprovalsSnapshot,
  loadExecApprovals,
  loadExecApprovalsAsync,
  readExecApprovalsSnapshot,
  restoreExecApprovalsSnapshot,
  restoreExecApprovalsSnapshotLocked,
  saveExecApprovals,
  updateExecApprovals,
  withAgentExecApprovalsRemoved,
} from "./exec-approvals-store.js";

export {
  commandRequiresSecurityAuditSuppressionApproval,
  DEFAULT_EXEC_APPROVAL_DECISIONS,
  isExecApprovalDecisionAllowed,
  maxAsk,
  minSecurity,
  normalizeExecApprovalUnavailableDecisions,
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalRequestAllowedDecisions,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
  resolveExecApprovalsLocked,
  resolveExecApprovalUnavailableDecisions,
} from "./exec-approvals-policy.js";
export type { ExecApprovalsDefaultOverrides } from "./exec-approvals-policy.js";

export {
  addAllowlistEntry,
  addDurableCommandApproval,
  createExecApprovalPolicySnapshot,
  hasDurableExecApproval,
  hasExactCommandDurableExecApproval,
  hasNodeCommandAllowAlwaysMarker,
  isExecApprovalPolicySnapshotCurrent,
  persistAllowAlwaysDecision,
  persistAllowAlwaysPatterns,
  resolveAllowAlwaysPatternCoverage,
  resolveAllowAlwaysPersistenceDecision,
  resolveDurableExecApprovalRequirement,
} from "./exec-approvals-allow-always.js";
export type {
  AllowAlwaysPersistenceDecision,
  AllowAlwaysPersistenceReason,
} from "./exec-approvals-allow-always.js";

export {
  commitExecAuthorizationLocked,
  recordAllowlistMatchesUse,
  recordAllowlistUse,
} from "./exec-approvals-authorization.js";
export type { ExecApprovalUsageAuthorization } from "./exec-approvals-authorization.js";

export { requestExecApprovalViaSocket } from "./exec-approvals-socket.js";
