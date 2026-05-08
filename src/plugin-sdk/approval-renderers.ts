import {
  buildExecApprovalActionDescriptors,
  buildApprovalInteractiveReplyFromActionDescriptors,
  type ExecApprovalReplyDecision,
  type ExecApprovalActionDescriptor,
} from "../infra/exec-approval-reply.js";
import {
  buildPluginApprovalRequestMessage,
  buildPluginApprovalResolvedMessage,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "../infra/plugin-approvals.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ReplyPayload } from "./reply-payload.js";

const DEFAULT_ALLOWED_DECISIONS = ["allow-once", "allow-always", "deny"] as const;

export function buildApprovalPendingReplyPayload(params: {
  approvalKind?: "exec" | "plugin";
  approvalId: string;
  approvalSlug: string;
  text: string;
  agentId?: string | null;
  actions?: readonly ExecApprovalActionDescriptor[];
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  sessionKey?: string | null;
  title?: string | null;
  description?: string | null;
  severity?: "info" | "warning" | "critical" | null;
  toolName?: string | null;
  pluginId?: string | null;
  channelData?: Record<string, unknown>;
}): ReplyPayload {
  const actionDecisions = Array.isArray(params.actions)
    ? params.actions
        .map((action) => action.decision)
        .filter((decision): decision is ExecApprovalReplyDecision => Boolean(decision))
    : null;
  const allowedDecisions = params.allowedDecisions ?? actionDecisions ?? DEFAULT_ALLOWED_DECISIONS;
  const actions = Array.isArray(params.actions)
    ? [...params.actions]
    : [
        ...buildExecApprovalActionDescriptors({
          approvalCommandId: params.approvalId,
          allowedDecisions,
        }),
      ];
  const interactive = buildApprovalInteractiveReplyFromActionDescriptors(actions);
  return {
    text: params.text,
    interactive,
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        approvalKind: params.approvalKind ?? "exec",
        agentId: normalizeOptionalString(params.agentId),
        ...(actions.length > 0 ? { actions } : {}),
        allowedDecisions,
        sessionKey: normalizeOptionalString(params.sessionKey),
        title: normalizeOptionalString(params.title),
        description: normalizeOptionalString(params.description),
        severity: params.severity ?? undefined,
        toolName: normalizeOptionalString(params.toolName),
        pluginId: normalizeOptionalString(params.pluginId),
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
    approvalKind: "plugin",
    approvalId: params.request.id,
    approvalSlug: params.approvalSlug ?? params.request.id.slice(0, 8),
    text: params.text ?? buildPluginApprovalRequestMessage(params.request, params.nowMs),
    actions: params.request.request.actions,
    allowedDecisions: params.allowedDecisions ?? params.request.request.allowedDecisions,
    title: params.request.request.title,
    description: params.request.request.description,
    severity: params.request.request.severity ?? undefined,
    toolName: params.request.request.toolName ?? undefined,
    pluginId: params.request.request.pluginId ?? undefined,
    agentId: params.request.request.agentId ?? undefined,
    sessionKey: params.request.request.sessionKey ?? undefined,
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
