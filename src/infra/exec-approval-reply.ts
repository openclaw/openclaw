import type { ReplyPayload } from "../auto-reply/types.js";
import type { ExecHost } from "./exec-approvals.js";

export type ExecApprovalReplyDecision = "allow-once" | "allow-always" | "deny";

export type ExecApprovalReplyMetadata = {
  approvalId: string;
  approvalSlug: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
};

export type ExecApprovalPendingReplyParams = {
  warningText?: string;
  approvalId: string;
  approvalSlug: string;
  approvalCommandId?: string;
  command: string;
  cwd?: string;
  host: ExecHost;
  nodeId?: string;
  expiresAtMs?: number;
  nowMs?: number;
};

function buildFence(text: string, language?: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  const languagePrefix = language ? language : "";
  return `${fence}${languagePrefix}\n${text}\n${fence}`;
}

export function getExecApprovalReplyMetadata(
  payload: ReplyPayload,
): ExecApprovalReplyMetadata | null {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return null;
  }
  const execApproval = channelData.execApproval;
  if (!execApproval || typeof execApproval !== "object" || Array.isArray(execApproval)) {
    return null;
  }
  const record = execApproval as Record<string, unknown>;
  const approvalId = typeof record.approvalId === "string" ? record.approvalId.trim() : "";
  const approvalSlug = typeof record.approvalSlug === "string" ? record.approvalSlug.trim() : "";
  if (!approvalId || !approvalSlug) {
    return null;
  }
  const allowedDecisions = Array.isArray(record.allowedDecisions)
    ? record.allowedDecisions.filter(
        (value): value is ExecApprovalReplyDecision =>
          value === "allow-once" || value === "allow-always" || value === "deny",
      )
    : undefined;
  return {
    approvalId,
    approvalSlug,
    allowedDecisions,
  };
}

export function buildExecApprovalPendingReplyPayload(
  params: ExecApprovalPendingReplyParams,
): ReplyPayload {
  const approvalCommandId = params.approvalCommandId?.trim() || params.approvalSlug;
  const lines: string[] = [];
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText, "");
  }
  lines.push("Approval required.");
  lines.push("Run:");
  lines.push(buildFence(`/approve ${approvalCommandId} allow-once`, "txt"));
  lines.push("Pending command:");
  lines.push(buildFence(params.command, "sh"));
  lines.push("Other options:");
  lines.push(
    buildFence(
      `/approve ${approvalCommandId} allow-always\n/approve ${approvalCommandId} deny`,
      "txt",
    ),
  );
  const info: string[] = [];
  info.push(`Host: ${params.host}`);
  if (params.nodeId) {
    info.push(`Node: ${params.nodeId}`);
  }
  if (params.cwd) {
    info.push(`CWD: ${params.cwd}`);
  }
  if (typeof params.expiresAtMs === "number" && Number.isFinite(params.expiresAtMs)) {
    const expiresInSec = Math.max(
      0,
      Math.round((params.expiresAtMs - (params.nowMs ?? Date.now())) / 1000),
    );
    info.push(`Expires in: ${expiresInSec}s`);
  }
  info.push(`Full id: \`${params.approvalId}\``);
  lines.push(info.join("\n"));

  return {
    text: lines.join("\n\n"),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    },
  };
}
