import type { ReplyPayload } from "../auto-reply/types.js";
import type { ExecApprovalReplyDecision } from "../infra/exec-approval-reply.js";
import {
  buildApprovalInteractiveReply,
  type ExecApprovalReplyDecision,
} from "../infra/exec-approval-reply.js";
import {
  buildPluginApprovalRequestMessage,
  buildPluginApprovalResolvedMessage,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "../infra/plugin-approvals.js";

const DEFAULT_ALLOWED_DECISIONS = ["allow-once", "allow-always", "deny"] as const;

export function buildApprovalPendingReplyPayload(params: {
  approvalId: string;
  approvalSlug: string;
  text: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  const allowedDecisions = params.allowedDecisions ?? DEFAULT_ALLOWED_DECISIONS;
  return {
    text: params.text,
    interactive: buildApprovalInteractiveReply({
      approvalId: params.approvalId,
      allowedDecisions,
    }),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        allowedDecisions,
        state: "pending",
      },
      ...params.channelData,
    },
  };
}

export function buildApprovalResolvedReplyPayload(params: {
  approvalId: string;
  approvalSlug: string;
  text: string;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return {
    text: params.text,
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        state: "resolved",
      },
      ...params.channelData,
    },
  };
}

export function buildPluginApprovalPendingReplyPayload(params: {
  request: PluginApprovalRequest;
  nowMs: number;
  text?: string;
  approvalSlug?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return buildApprovalPendingReplyPayload({
    approvalId: params.request.id,
    approvalSlug: params.approvalSlug ?? params.request.id.slice(0, 8),
    text: params.text ?? buildPluginApprovalRequestMessage(params.request, params.nowMs),
    allowedDecisions: params.allowedDecisions,
    channelData: params.channelData,
  });
}

export function buildPluginApprovalResolvedReplyPayload(params: {
  resolved: PluginApprovalResolved;
  text?: string;
  approvalSlug?: string;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return buildApprovalResolvedReplyPayload({
    approvalId: params.resolved.id,
    approvalSlug: params.approvalSlug ?? params.resolved.id.slice(0, 8),
    text: params.text ?? buildPluginApprovalResolvedMessage(params.resolved),
    channelData: params.channelData,
  });
}
