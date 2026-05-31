export {
  ensureExecApprovals,
  loadExecApprovals,
  normalizeExecApprovals,
  readExecApprovalsSnapshot,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
  restoreExecApprovalsSnapshot,
  saveExecApprovals,
} from "../infra/exec-approvals.js";

export type {
  ExecAllowlistEntry,
  ExecApprovalsAgent,
  ExecApprovalsDefaultOverrides,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecApprovalsResolved,
  ExecApprovalsSnapshot,
  ExecAsk,
  ExecSecurity,
} from "../infra/exec-approvals.js";
