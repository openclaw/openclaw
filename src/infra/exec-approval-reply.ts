import type { ReplyPayload } from "../auto-reply/types.js";
import type { InteractiveReply, InteractiveReplyButton } from "../interactive/payload.js";
import { formatHumanList } from "../shared/human-list.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { formatApprovalDisplayPath } from "./approval-display-paths.js";
import {
  describeNativeExecApprovalClientSetup,
  listNativeExecApprovalClientLabels,
  supportsNativeExecApprovalClient,
} from "./exec-approval-surface.js";
import {
  resolveExecApprovalAllowedDecisions,
  type ExecApprovalDecision,
  type ExecHost,
} from "./exec-approvals.js";

export type ExecApprovalReplyDecision = ExecApprovalDecision;
export type ExecApprovalUnavailableReason =
  | "initiating-platform-disabled"
  | "initiating-platform-unsupported"
  | "no-approval-route";

export type ExecApprovalReplyMetadata = {
  approvalId: string;
  approvalSlug: string;
  approvalKind: "exec" | "plugin";
  state?: "pending" | "resolved";
  agentId?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  sessionKey?: string;
  title?: string;
  description?: string;
  severity?: "info" | "warning" | "critical";
  toolName?: string;
  pluginId?: string;
  actions?: readonly ExecApprovalActionDescriptor[];
};

export type ExecApprovalActionDescriptor = {
  kind: "decision" | "command";
  label: string;
  style: NonNullable<InteractiveReplyButton["style"]>;
  command: string;
  decision?: ExecApprovalReplyDecision;
};

export type ExecApprovalPendingReplyParams = {
  warningText?: string;
  approvalId: string;
  approvalSlug: string;
  approvalCommandId?: string;
  ask?: string | null;
  agentId?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  command: string;
  cwd?: string;
  host: ExecHost;
  nodeId?: string;
  sessionKey?: string | null;
  expiresAtMs?: number;
  nowMs?: number;
};

export type ExecApprovalUnavailableReplyParams = {
  warningText?: string;
  channel?: string;
  channelLabel?: string;
  accountId?: string;
  reason: ExecApprovalUnavailableReason;
  sentApproverDms?: boolean;
};

function resolveNativeExecApprovalClientList(params?: { excludeChannel?: string }): string {
  return formatHumanList(
    listNativeExecApprovalClientLabels({
      excludeChannel: params?.excludeChannel,
    }),
  );
}

function buildGenericNativeExecApprovalFallbackText(params?: { excludeChannel?: string }): string {
  const clients = resolveNativeExecApprovalClientList({
    excludeChannel: params?.excludeChannel,
  });
  return clients
    ? `Approve it from the Web UI or terminal UI, or enable a native chat approval client such as ${clients}. If those accounts already know your owner ID via allowFrom or owner config, OpenClaw can often infer approvers automatically.`
    : "Approve it from the Web UI or terminal UI.";
}

function resolveAllowedDecisions(params: {
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): readonly ExecApprovalReplyDecision[] {
  return params.allowedDecisions ?? resolveExecApprovalAllowedDecisions({ ask: params.ask });
}

function buildApprovalCommandFence(
  descriptors: readonly ExecApprovalActionDescriptor[],
): string | null {
  if (descriptors.length === 0) {
    return null;
  }
  return buildFence(descriptors.map((descriptor) => descriptor.command).join("\n"), "txt");
}

function parseExecApprovalActions(value: unknown): ExecApprovalActionDescriptor[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const descriptors: ExecApprovalActionDescriptor[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const kind =
      record.kind === "decision" ? "decision" : record.kind === "command" ? "command" : "";
    const label = normalizeOptionalString(record.label) ?? "";
    const style =
      record.style === "primary" || record.style === "success" || record.style === "danger"
        ? record.style
        : "";
    const command = normalizeOptionalString(record.command) ?? "";
    if (!kind || !label || !style || !command) {
      continue;
    }
    const decision =
      record.decision === "allow-once" ||
      record.decision === "allow-always" ||
      record.decision === "deny"
        ? record.decision
        : undefined;
    descriptors.push({
      kind,
      label,
      style,
      ...(decision ? { decision } : {}),
      command,
    });
  }
  return descriptors.length > 0 ? descriptors : undefined;
}

export function buildExecApprovalCommandText(params: {
  approvalCommandId: string;
  decision: ExecApprovalReplyDecision;
}): string {
  return `/approve ${params.approvalCommandId} ${params.decision}`;
}

export function buildExecApprovalActionDescriptors(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): ExecApprovalActionDescriptor[] {
  const approvalCommandId = params.approvalCommandId.trim();
  if (!approvalCommandId) {
    return [];
  }
  const allowedDecisions = resolveAllowedDecisions(params);
  const descriptors: ExecApprovalActionDescriptor[] = [];
  if (allowedDecisions.includes("allow-once")) {
    descriptors.push({
      kind: "decision",
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
      kind: "decision",
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
      kind: "decision",
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
  descriptors: readonly ExecApprovalActionDescriptor[],
): InteractiveReplyButton[] {
  return descriptors.map((descriptor) => ({
    label: descriptor.label,
    value: descriptor.command,
    style: descriptor.style,
  }));
}

export function buildApprovalInteractiveReplyFromActionDescriptors(
  actions: readonly ExecApprovalActionDescriptor[],
): InteractiveReply | undefined {
  const buttons = buildApprovalInteractiveButtons(actions);
  return buttons.length > 0 ? { blocks: [{ type: "buttons", buttons }] } : undefined;
}

export function buildApprovalInteractiveReply(params: {
  approvalId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): InteractiveReply | undefined {
  return buildApprovalInteractiveReplyFromActionDescriptors(
    buildExecApprovalActionDescriptors({
      approvalCommandId: params.approvalId,
      ask: params.ask,
      allowedDecisions: params.allowedDecisions,
    }),
  );
}

export function buildExecApprovalInteractiveReply(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): InteractiveReply | undefined {
  return buildApprovalInteractiveReply({
    approvalId: params.approvalCommandId,
    ask: params.ask,
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
    /^\/?approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  const rawDecision = normalizeOptionalLowercaseString(match[2]) ?? "";
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
  const approvalId = normalizeOptionalString(record.approvalId) ?? "";
  const approvalSlug = normalizeOptionalString(record.approvalSlug) ?? "";
  if (!approvalId || !approvalSlug) {
    return null;
  }
  const approvalKind = record.approvalKind === "plugin" ? "plugin" : "exec";
  const allowedDecisions = Array.isArray(record.allowedDecisions)
    ? record.allowedDecisions.filter(
        (value): value is ExecApprovalReplyDecision =>
          value === "allow-once" || value === "allow-always" || value === "deny",
      )
    : undefined;
  const state =
    record.state === "pending" || record.state === "resolved" ? record.state : undefined;
  const agentId = normalizeOptionalString(record.agentId);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  const title = normalizeOptionalString(record.title);
  const description = normalizeOptionalString(record.description);
  const severity =
    record.severity === "info" || record.severity === "warning" || record.severity === "critical"
      ? record.severity
      : undefined;
  const toolName = normalizeOptionalString(record.toolName);
  const pluginId = normalizeOptionalString(record.pluginId);
  const actions = parseExecApprovalActions(record.actions);
  return {
    approvalId,
    approvalSlug,
    approvalKind,
    state,
    agentId,
    allowedDecisions,
    sessionKey,
    title,
    description,
    severity,
    toolName,
    pluginId,
    actions,
  };
}

export function buildExecApprovalPendingReplyPayload(
  params: ExecApprovalPendingReplyParams,
): ReplyPayload {
  const approvalCommandId = params.approvalCommandId?.trim() || params.approvalSlug;
  const allowedDecisions = resolveAllowedDecisions(params);
  const descriptors = buildExecApprovalActionDescriptors({
    approvalCommandId,
    allowedDecisions,
  });
  const primaryAction = descriptors[0] ?? null;
  const secondaryActions = descriptors.slice(1);
  const lines: string[] = [];
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText);
  }
  lines.push("Approval required.");
  if (primaryAction) {
    lines.push("Run:");
    lines.push(buildFence(primaryAction.command, "txt"));
  }
  lines.push("Pending command:");
  lines.push(buildFence(params.command, "sh"));
  const secondaryFence = buildApprovalCommandFence(secondaryActions);
  if (secondaryFence) {
    lines.push("Other options:");
    lines.push(secondaryFence);
  }
  if (!allowedDecisions.includes("allow-always")) {
    lines.push(
      "The effective approval policy requires approval every time, so Allow Always is unavailable.",
    );
  }
  const info: string[] = [];
  info.push(`Host: ${params.host}`);
  if (params.nodeId) {
    info.push(`Node: ${params.nodeId}`);
  }
  if (params.cwd) {
    info.push(`CWD: ${formatApprovalDisplayPath(params.cwd)}`);
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
    interactive: buildApprovalInteractiveReply({
      approvalId: params.approvalId,
      allowedDecisions,
    }),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        approvalKind: "exec",
        agentId: normalizeOptionalString(params.agentId),
        actions: descriptors,
        allowedDecisions,
        sessionKey: normalizeOptionalString(params.sessionKey),
        state: "pending",
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
      `Exec approval is required, but native chat exec approvals are not configured on ${params.channelLabel ?? "this platform"}.`,
    );
    const channel = normalizeOptionalLowercaseString(params.channel);
    const setupText =
      channel && params.channelLabel && supportsNativeExecApprovalClient(channel)
        ? describeNativeExecApprovalClientSetup({
            channel,
            channelLabel: params.channelLabel,
            accountId: params.accountId,
          })
        : null;
    if (setupText) {
      lines.push(setupText);
    } else {
      lines.push(buildGenericNativeExecApprovalFallbackText());
    }
  } else if (params.reason === "initiating-platform-unsupported") {
    lines.push(
      `Exec approval is required, but ${params.channelLabel ?? "this platform"} does not support chat exec approvals.`,
    );
    lines.push(
      buildGenericNativeExecApprovalFallbackText({
        excludeChannel: params.channel,
      }),
    );
  } else {
    lines.push(
      "Exec approval is required, but no interactive approval client is currently available.",
    );
    lines.push(
      `${buildGenericNativeExecApprovalFallbackText()} Then retry the command. You can usually leave execApprovals.approvers unset when owner config already identifies the approvers.`,
    );
  }

  return {
    text: lines.join("\n\n"),
  };
}
