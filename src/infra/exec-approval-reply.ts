import type { ReplyPayload } from "../auto-reply/types.js";
import type { InteractiveReply, InteractiveReplyButton } from "../interactive/payload.js";
import type { ExecHost } from "./exec-approvals.js";

export type ExecApprovalReplyDecision = "allow-once" | "allow-always" | "deny";
export type ExecApprovalUnavailableReason =
  | "initiating-platform-disabled"
  | "initiating-platform-unsupported"
  | "no-approval-route";

export type ExecApprovalReplyMetadata = {
  approvalId: string;
  approvalSlug: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
};

export type ExecApprovalActionDescriptor = {
  decision: ExecApprovalReplyDecision;
  label: string;
  style: NonNullable<InteractiveReplyButton["style"]>;
  command: string;
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

export type ExecApprovalUnavailableReplyParams = {
  warningText?: string;
  channelLabel?: string;
  reason: ExecApprovalUnavailableReason;
  sentApproverDms?: boolean;
};

const DEFAULT_ALLOWED_DECISIONS = ["allow-once", "allow-always", "deny"] as const;

export function buildExecApprovalCommandText(params: {
  approvalCommandId: string;
  decision: ExecApprovalReplyDecision;
}): string {
  return `/approve ${params.approvalCommandId} ${params.decision === "allow-always" ? "always" : params.decision}`;
}

export function buildExecApprovalActionDescriptors(params: {
  approvalCommandId: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): ExecApprovalActionDescriptor[] {
  const approvalCommandId = params.approvalCommandId.trim();
  if (!approvalCommandId) {
    return [];
  }
  const allowedDecisions = params.allowedDecisions ?? DEFAULT_ALLOWED_DECISIONS;
  const descriptors: ExecApprovalActionDescriptor[] = [];
  if (allowedDecisions.includes("allow-once")) {
    descriptors.push({
      decision: "allow-once",
      label: "Allow Once",
      style: "success",
      command: buildExecApprovalCommandText({
        approvalCommandId,
        decision: "allow-once",
      }),
    });
  }
  if (allowedDecisions.includes("allow-always")) {
    descriptors.push({
      decision: "allow-always",
      label: "Allow Always",
      style: "primary",
      command: buildExecApprovalCommandText({
        approvalCommandId,
        decision: "allow-always",
      }),
    });
  }
  if (allowedDecisions.includes("deny")) {
    descriptors.push({
      decision: "deny",
      label: "Deny",
      style: "danger",
      command: buildExecApprovalCommandText({
        approvalCommandId,
        decision: "deny",
      }),
    });
  }
  return descriptors;
}

function buildApprovalInteractiveButtons(
  allowedDecisions: readonly ExecApprovalReplyDecision[],
  approvalId: string,
): InteractiveReplyButton[] {
  return buildExecApprovalActionDescriptors({
    approvalCommandId: approvalId,
    allowedDecisions,
  }).map((descriptor) => ({
    label: descriptor.label,
    value: descriptor.command,
    style: descriptor.style,
  }));
}

export function buildApprovalInteractiveReply(params: {
  approvalId: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): InteractiveReply | undefined {
  const buttons = buildApprovalInteractiveButtons(
    params.allowedDecisions ?? DEFAULT_ALLOWED_DECISIONS,
    params.approvalId,
  );
  return buttons.length > 0 ? { blocks: [{ type: "buttons", buttons }] } : undefined;
}

export function buildExecApprovalInteractiveReply(params: {
  approvalCommandId: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): InteractiveReply | undefined {
  return buildApprovalInteractiveReply({
    approvalId: params.approvalCommandId,
    allowedDecisions: params.allowedDecisions,
  });
}

export function getExecApprovalApproverDmNoticeText(): string {
  return "Approval required. I sent approval DMs to the approvers for this account.";
}

export function parseExecApprovalCommandText(
  raw: string,
): { approvalId: string; decision: ExecApprovalReplyDecision } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(
    /^\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  const rawDecision = match[2].toLowerCase();
  return {
    approvalId: match[1],
    decision:
      rawDecision === "always" ? "allow-always" : (rawDecision as ExecApprovalReplyDecision),
  };
}

export function formatExecApprovalExpiresIn(expiresAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.round((expiresAtMs - nowMs) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (hours === 0 && minutes < 5 && seconds > 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

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
    lines.push(warningText);
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
    info.push(
      `Expires in: ${formatExecApprovalExpiresIn(params.expiresAtMs, params.nowMs ?? Date.now())}`,
    );
  }
  info.push(`Full id: \`${params.approvalId}\``);
  lines.push(info.join("\n"));

  return {
    text: lines.join("\n\n"),
    interactive: buildApprovalInteractiveReply({ approvalId: params.approvalId }),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        allowedDecisions: DEFAULT_ALLOWED_DECISIONS,
      },
    },
  };
}

export function buildExecApprovalUnavailableReplyPayload(
  params: ExecApprovalUnavailableReplyParams,
): ReplyPayload {
  const lines: string[] = [];
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText);
  }

  if (params.sentApproverDms) {
    lines.push(getExecApprovalApproverDmNoticeText());
    return {
      text: lines.join("\n\n"),
    };
  }

  if (params.reason === "initiating-platform-disabled") {
    lines.push(
      `Exec approval is required, but chat exec approvals are not enabled on ${params.channelLabel ?? "this platform"}.`,
    );
    lines.push(
      "Approve it from the Web UI or terminal UI, or enable Discord, Slack, or Telegram exec approvals. If those accounts already know your owner ID via allowFrom, OpenClaw can infer approvers automatically.",
    );
  } else if (params.reason === "initiating-platform-unsupported") {
    lines.push(
      `Exec approval is required, but ${params.channelLabel ?? "this platform"} does not support chat exec approvals.`,
    );
    lines.push(
      "Approve it from the Web UI or terminal UI, or enable Discord, Slack, or Telegram exec approvals. If those accounts already know your owner ID via allowFrom, OpenClaw can infer approvers automatically.",
    );
  } else {
    lines.push(
      "Exec approval is required, but no interactive approval client is currently available.",
    );
    lines.push(
      "Open the Web UI or terminal UI, or enable Discord, Slack, or Telegram exec approvals, then retry the command. If those accounts already know your owner ID via allowFrom, you can usually leave execApprovals.approvers unset.",
    );
  }

  return {
    text: lines.join("\n\n"),
  };
}
