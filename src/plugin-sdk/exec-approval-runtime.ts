// Narrow exec-approval helpers for channel plugins that only need reply metadata
// and payload formatting, without loading the broader approval runtime surface.

export type { ExecApprovalRequest } from "../infra/exec-approvals.js";
export {
  buildExecApprovalPendingReplyPayload,
  getExecApprovalReplyMetadata,
} from "../infra/exec-approval-reply.js";
export { resolveExecApprovalCommandDisplay } from "../infra/exec-approval-command-display.js";
export { buildPluginApprovalRequestMessage } from "../infra/plugin-approvals.js";
