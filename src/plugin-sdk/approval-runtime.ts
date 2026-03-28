// Approval request/reply helpers for exec and plugin approval flows.

export {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprovalRequestPayload,
  type ExecApprovalResolved,
  type ExecHost,
} from "../infra/exec-approvals.js";
export {
  buildExecApprovalPendingReplyPayload,
  getExecApprovalApproverDmNoticeText,
  getExecApprovalReplyMetadata,
  type ExecApprovalPendingReplyParams,
  type ExecApprovalReplyDecision,
  type ExecApprovalReplyMetadata,
} from "../infra/exec-approval-reply.js";
export { resolveExecApprovalCommandDisplay } from "../infra/exec-approval-command-display.js";
export {
  resolveExecApprovalSessionTarget,
  type ExecApprovalSessionTarget,
} from "../infra/exec-approval-session-target.js";
export {
  buildPluginApprovalExpiredMessage,
  buildPluginApprovalRequestMessage,
  buildPluginApprovalResolvedMessage,
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  type PluginApprovalRequest,
  type PluginApprovalRequestPayload,
  type PluginApprovalResolved,
} from "../infra/plugin-approvals.js";
