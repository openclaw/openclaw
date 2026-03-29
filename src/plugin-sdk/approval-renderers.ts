import type { ReplyPayload } from "../auto-reply/types.js";
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

function neutralizeApprovalText(value: string): string {
  return value
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/<@/g, "<@\u200b")
    .replace(/<#/g, "<#\u200b");
}

export function buildApprovalPendingReplyPayload(params: {
  approvalId: string;
  approvalSlug: string;
  text: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  const allowedDecisions = params.allowedDecisions ?? DEFAULT_ALLOWED_DECISIONS;
  return {
    text: neutralizeApprovalText(params.text),
    interactive: buildApprovalInteractiveReply({
      approvalId: params.approvalId,
      allowedDecisions,
    }),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        allowedDecisions,
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
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  return params.channelData
    ? {
        text: neutralizeApprovalText(
          params.text ?? buildPluginApprovalResolvedMessage(params.resolved),
        ),
        channelData: params.channelData,
      }
    : {
        text: neutralizeApprovalText(
          params.text ?? buildPluginApprovalResolvedMessage(params.resolved),
        ),
      };
}
