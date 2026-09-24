import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isWellFormedApprovalId } from "../../packages/gateway-protocol/src/schema/approval-id.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type {
  MessagePresentation,
  MessagePresentationAction,
  MessagePresentationButton,
} from "../interactive/payload.js";
// Builds reply payloads for exec approval prompts and outcomes.
import { formatFencedCodeBlock } from "../shared/markdown-code.js";
import { formatApprovalDisplayPath } from "./approval-display-paths.js";
import { summarizeApprovalScope, type ApprovalScope } from "./approval-scope.js";
import {
  normalizeApprovalRequestDeliveryRoute,
  type ApprovalRequestDeliveryRoute,
  type ChannelApprovalKind,
} from "./approval-types.js";
import {
  resolveExecApprovalAllowedDecisions,
  type ExecApprovalDecision,
  type ExecHost,
} from "./exec-approvals.js";

export type ExecApprovalReplyDecision = ExecApprovalDecision;
export type ExecApprovalReplyMetadata = {
  approvalId: string;
  approvalSlug: string;
  approvalKind: ChannelApprovalKind;
  agentId?: string;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
  sessionKey?: string;
  deliveryRoute?: ApprovalRequestDeliveryRoute;
  expiresAtMs?: number;
};

export type ExecApprovalActionDescriptor = {
  decision: ExecApprovalReplyDecision;
  label: string;
  style: NonNullable<MessagePresentationButton["style"]>;
  /** Optional semantic action; omitted by the shipped command-backed builders. */
  action?: MessagePresentationAction;
  /** Copyable text fallback retained for non-interactive approval surfaces. */
  command: string;
};

/** Approval descriptor guaranteed to carry a canonical typed approval action. */
export type TypedApprovalActionDescriptor = ExecApprovalActionDescriptor & {
  action: Extract<MessagePresentationAction, { type: "approval" }>;
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
  scope?: ApprovalScope | null;
  sessionKey?: string | null;
  expiresAtMs?: number;
  deliveryRoute?: ApprovalRequestDeliveryRoute;
  nowMs?: number;
};

function resolveAllowedDecisions(params: {
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): readonly ExecApprovalReplyDecision[] {
  return params.allowedDecisions ?? resolveExecApprovalAllowedDecisions({ ask: params.ask });
}

export function buildExecApprovalCommandText(params: {
  approvalCommandId: string;
  decision: ExecApprovalReplyDecision;
}): string {
  return `/approve ${params.approvalCommandId} ${params.decision}`;
}

type BuildExecApprovalActionDescriptorsParams = {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
};

function buildApprovalActionDescriptors(
  approvalCommandId: string,
  allowedDecisions: readonly ExecApprovalReplyDecision[],
): ExecApprovalActionDescriptor[] {
  return APPROVAL_ACTIONS.filter(({ decision }) => allowedDecisions.includes(decision)).map(
    ({ decision, label, style }) => ({
      decision,
      label,
      style,
      command: buildExecApprovalCommandText({ approvalCommandId, decision }),
    }),
  );
}

const APPROVAL_ACTIONS = [
  { decision: "allow-once", label: "Allow Once", style: "success" },
  { decision: "allow-always", label: "Allow Always", style: "primary" },
  { decision: "deny", label: "Deny", style: "danger" },
] as const;

export function buildExecApprovalActionDescriptors(
  params: BuildExecApprovalActionDescriptorsParams,
): ExecApprovalActionDescriptor[] {
  const approvalCommandId = params.approvalCommandId.trim();
  return approvalCommandId
    ? buildApprovalActionDescriptors(approvalCommandId, resolveAllowedDecisions(params))
    : [];
}

/** Build approval descriptors with explicit owner-aware typed actions. */
export function buildTypedApprovalActionDescriptors(
  params: BuildExecApprovalActionDescriptorsParams & {
    approvalKind: ChannelApprovalKind;
  },
): TypedApprovalActionDescriptor[] {
  const approvalId = params.approvalCommandId;
  if (!isWellFormedApprovalId(approvalId)) {
    return [];
  }
  return buildApprovalActionDescriptors(approvalId, resolveAllowedDecisions(params)).map(
    (descriptor) =>
      Object.assign(descriptor, {
        action: {
          type: "approval" as const,
          approvalId,
          approvalKind: params.approvalKind,
          decision: descriptor.decision,
        },
      }),
  );
}

/** Build portable approval controls from decision descriptors. */
export function buildApprovalPresentationFromActionDescriptors(
  actions: readonly ExecApprovalActionDescriptor[],
): MessagePresentation | undefined {
  const buttons = actions.map<MessagePresentationButton>((descriptor) => ({
    label: descriptor.label,
    action: descriptor.action ?? { type: "command", command: descriptor.command },
    ...(descriptor.action ? {} : { value: descriptor.command }),
    style: descriptor.style,
  }));
  return buttons.length > 0 ? { blocks: [{ type: "buttons", buttons }] } : undefined;
}

type BuildApprovalPresentationParams = {
  approvalId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
};

/** Build the shipped command-backed portable approval controls. */
export function buildApprovalButtonPresentation(
  params: BuildApprovalPresentationParams,
): MessagePresentation | undefined {
  return buildExecApprovalPresentation({ ...params, approvalCommandId: params.approvalId });
}

/** Build portable approval controls with explicit owner-aware typed actions. */
export function buildTypedApprovalPresentation(
  params: BuildApprovalPresentationParams & { approvalKind: ChannelApprovalKind },
): MessagePresentation | undefined {
  return buildApprovalPresentationFromActionDescriptors(
    buildTypedApprovalActionDescriptors({ ...params, approvalCommandId: params.approvalId }),
  );
}

/** Build the shipped command-backed exec-approval presentation. */
export function buildExecApprovalPresentation(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): MessagePresentation | undefined {
  return buildApprovalPresentationFromActionDescriptors(buildExecApprovalActionDescriptors(params));
}

/** Build an exec-approval presentation with canonical typed decision actions. */
export function buildTypedExecApprovalPresentation(params: {
  approvalCommandId: string;
  ask?: string | null;
  allowedDecisions?: readonly ExecApprovalReplyDecision[];
}): MessagePresentation | undefined {
  return buildApprovalPresentationFromActionDescriptors(
    buildTypedApprovalActionDescriptors({ ...params, approvalKind: "exec" }),
  );
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
    approvalId: expectDefined(match[1], "exec approval reply regex capture 1"),
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

export function getExecApprovalReplyMetadata(
  payload: ReplyPayload,
): ExecApprovalReplyMetadata | null {
  const record = asOptionalRecord(asOptionalRecord(payload.channelData)?.execApproval);
  if (!record) {
    return null;
  }
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
  const agentId = normalizeOptionalString(record.agentId);
  const sessionKey = normalizeOptionalString(record.sessionKey);
  return {
    approvalId,
    approvalSlug,
    approvalKind,
    agentId,
    allowedDecisions,
    sessionKey,
    deliveryRoute: normalizeApprovalRequestDeliveryRoute(record.deliveryRoute),
    expiresAtMs:
      typeof record.expiresAtMs === "number" && Number.isFinite(record.expiresAtMs)
        ? record.expiresAtMs
        : undefined,
  };
}

export function buildExecApprovalPendingReplyPayload(
  params: ExecApprovalPendingReplyParams,
): ReplyPayload {
  const approvalCommandId = params.approvalCommandId?.trim() || params.approvalSlug;
  const allowedDecisions = resolveAllowedDecisions(params);
  const clientOnly = params.deliveryRoute === "approval-client";
  const descriptors = clientOnly
    ? []
    : buildExecApprovalActionDescriptors({
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
  lines.push(
    clientOnly
      ? "Approval is pending in an approval client. Respond to the approval card there."
      : "Approval required.",
  );
  if (primaryAction) {
    lines.push("Run:");
    lines.push(formatFencedCodeBlock(primaryAction.command, "txt"));
  }
  lines.push("Pending command:");
  lines.push(formatFencedCodeBlock(params.command, "sh"));
  if (secondaryActions.length > 0) {
    lines.push(
      "Other options:",
      formatFencedCodeBlock(secondaryActions.map((action) => action.command).join("\n"), "txt"),
    );
  }
  if (!allowedDecisions.includes("allow-always")) {
    lines.push("Allow Always is unavailable for this command.");
  }
  const info: string[] = [];
  info.push(`Host: ${params.host}`);
  if (params.nodeId) {
    info.push(`Node: ${params.nodeId}`);
  }
  if (params.cwd) {
    info.push(`CWD: ${formatApprovalDisplayPath(params.cwd)}`);
  }
  if (params.scope) {
    info.push(`Scope: ${summarizeApprovalScope(params.scope)}`);
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
    presentation: clientOnly
      ? undefined
      : buildApprovalButtonPresentation({
          approvalId: params.approvalId,
          allowedDecisions,
        }),
    channelData: {
      execApproval: {
        approvalId: params.approvalId,
        approvalSlug: params.approvalSlug,
        approvalKind: "exec",
        agentId: normalizeOptionalString(params.agentId),
        allowedDecisions,
        sessionKey: normalizeOptionalString(params.sessionKey),
        deliveryRoute: params.deliveryRoute,
        expiresAtMs: params.expiresAtMs,
      },
    },
  };
}

/** Build an exec approval prompt with canonical typed decision actions. */
export function buildTypedExecApprovalPendingReplyPayload(
  params: ExecApprovalPendingReplyParams,
): ReplyPayload {
  const payload = buildExecApprovalPendingReplyPayload(params);
  if (params.deliveryRoute === "approval-client") {
    return payload;
  }
  return {
    ...payload,
    presentation: buildTypedExecApprovalPresentation({
      approvalCommandId: params.approvalId,
      allowedDecisions: resolveAllowedDecisions(params),
    }),
  };
}
