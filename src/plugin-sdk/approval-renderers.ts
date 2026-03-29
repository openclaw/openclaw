import type { ReplyPayload } from "../auto-reply/types.js";
import type { ExecApprovalReplyDecision } from "../infra/exec-approval-reply.js";
import {
  buildPluginApprovalRequestMessage,
  buildPluginApprovalResolvedMessage,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "../infra/plugin-approvals.js";

const DEFAULT_ALLOWED_DECISIONS = ["allow-once", "allow-always", "deny"] as const;

export function buildPluginApprovalPendingReplyPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
  text?: string;
  approvalSlug?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return {
    text: params.text ?? buildPluginApprovalRequestMessage(params.request, params.nowMs),
    channelData: {
      execApproval: {
        approvalId: params.request.id,
        approvalSlug: params.approvalSlug ?? params.request.id.slice(0, 8),
        allowedDecisions: params.allowedDecisions ?? DEFAULT_ALLOWED_DECISIONS,
      },
      ...params.channelData,
    },
  };
}

export function buildPluginApprovalResolvedReplyPayload(params: {
  resolved: PluginApprovalResolved;
  text?: string;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return params.channelData
    ? {
        text: params.text ?? buildPluginApprovalResolvedMessage(params.resolved),
        channelData: params.channelData,
      }
    : {
        text: params.text ?? buildPluginApprovalResolvedMessage(params.resolved),
      };
}
