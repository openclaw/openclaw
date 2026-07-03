/**
 * Runtime SDK subpath for building approval replies and exec approval presentations.
 */
export {
  buildApprovalInteractiveReplyFromActionDescriptors,
  buildApprovalPresentation,
  buildApprovalPresentationFromActionDescriptors,
  buildExecApprovalPresentation,
  buildExecApprovalActionDescriptors,
  buildExecApprovalPendingReplyPayload,
  getExecApprovalApproverDmNoticeText,
  getExecApprovalReplyMetadata,
  parseExecApprovalCommandText,
  type ExecApprovalActionDescriptor,
  type ExecApprovalPendingReplyParams,
  type ExecApprovalReplyDecision,
  type ExecApprovalReplyMetadata,
} from "../infra/exec-approval-reply.js";
export { resolveExecApprovalCommandDisplay } from "../infra/exec-approval-command-display.js";
export type { ExecApprovalAllowAlwaysUnavailableReason } from "../infra/exec-approval-unavailable-copy.js";
export {
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalDecision,
} from "../infra/exec-approvals.js";
export { buildPluginApprovalPendingReplyPayload } from "./approval-renderers.js";
