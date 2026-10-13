import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalAdapter,
} from "../channels/plugins/index.js";
import type { ExecApprovalForwardTarget } from "../config/types.approvals.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildApprovalResolvedReplyPayload,
  buildPluginApprovalResolvedReplyPayload,
  buildTypedApprovalPendingReplyPayload,
  buildTypedPluginApprovalPendingReplyPayload,
} from "../plugin-sdk/approval-renderers.js";
import {
  buildSystemAgentApprovalResolvedText,
  SYSTEM_AGENT_APPROVAL_EXPIRED_TEXT,
} from "../plugin-sdk/approval-terminal.js";
import { formatFencedCodeBlock } from "../shared/markdown-code.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import { formatExecApprovalExpiresIn } from "./exec-approval-reply.js";
import { sanitizeExecApprovalWarningText } from "./exec-approval-text-sanitize.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "./exec-approvals.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "./plugin-approval-canonical-decisions.js";
import {
  approvalDecisionLabel,
  buildPluginApprovalRequestMessage,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "./plugin-approvals.js";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  type SystemAgentApprovalRequest,
  type SystemAgentApprovalResolved,
} from "./system-agent-approvals.js";

function buildForwardedExecApprovalRequest(request: ExecApprovalRequest, nowMs: number) {
  const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(request.request);
  const decisionText = allowedDecisions.join("|");
  const lines: string[] = ["🔒 Exec approval required", `ID: ${request.id}`];
  const warningText = request.request.warningText?.trim();
  if (warningText) {
    lines.push("", warningText);
  }
  const analysisWarningLines = normalizeStringEntries(
    request.request.commandAnalysis?.warningLines.map(sanitizeExecApprovalWarningText),
  ).slice(0, 5);
  if (analysisWarningLines && analysisWarningLines.length > 0) {
    lines.push("", "Command analysis:");
    for (const line of analysisWarningLines) {
      lines.push(`- ${line}`);
    }
  }
  const command = resolveExecApprovalCommandDisplay(request.request).commandText;
  if (!command.includes("\n") && !command.includes("`")) {
    lines.push(`Command: \`${command}\``);
  } else {
    lines.push("Command:", formatFencedCodeBlock(command));
  }
  const appendField = (
    field: "cwd" | "nodeId" | "host" | "agentId" | "security" | "ask",
    label: string,
  ) => {
    if (request.request[field]) {
      lines.push(`${label}: ${request.request[field]}`);
    }
  };
  appendField("cwd", "CWD");
  appendField("nodeId", "Node");
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    lines.push(`Env overrides: ${request.request.envKeys.join(", ")}`);
  }
  appendField("host", "Host");
  appendField("agentId", "Agent");
  appendField("security", "Security");
  appendField("ask", "Ask");
  lines.push(`Expires in: ${formatExecApprovalExpiresIn(request.expiresAtMs, nowMs)}`);
  lines.push("Mode: foreground (interactive approvals available in this chat).");
  lines.push(
    allowedDecisions.includes("allow-always")
      ? "Background mode note: non-interactive runs cannot wait for chat approvals; use pre-approved policy (allow-always or ask=off)."
      : "Background mode note: non-interactive runs cannot wait for chat approvals; the effective policy still requires per-run approval unless ask=off.",
  );
  lines.push(`Reply with: /approve ${request.id} ${decisionText}`);
  if (!allowedDecisions.includes("allow-always")) {
    lines.push("Allow Always is unavailable for this command.");
  }
  return lines.join("\n");
}

function buildForwardedExecApprovalResolved(resolved: ExecApprovalResolved) {
  const base = `✅ Exec approval ${approvalDecisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

export function buildForwardedExecApprovalExpired(request: ExecApprovalRequest) {
  return `⏱️ Exec approval expired. ID: ${request.id}`;
}

function resolveApprovalRenderer(target: ExecApprovalForwardTarget) {
  const channel = normalizeMessageChannel(target.channel) ?? target.channel;
  return channel
    ? resolveChannelApprovalAdapter(getLoadedChannelPlugin(channel))?.render
    : undefined;
}

export function buildForwardedExecPendingPayload(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  target: ExecApprovalForwardTarget;
  nowMs: number;
}): ReplyPayload {
  const render = resolveApprovalRenderer(params.target)?.exec?.buildPendingPayload;
  return (
    render?.(params) ??
    buildTypedApprovalPendingReplyPayload({
      approvalKind: "exec",
      approvalId: params.request.id,
      approvalSlug: params.request.id.slice(0, 8),
      text: buildForwardedExecApprovalRequest(params.request, params.nowMs),
      agentId: params.request.request.agentId ?? null,
      allowedDecisions: resolveExecApprovalRequestAllowedDecisions(params.request.request),
      sessionKey: params.request.request.sessionKey ?? null,
    })
  );
}

export function buildForwardedExecResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: ExecApprovalResolved;
  target: ExecApprovalForwardTarget;
}): ReplyPayload {
  const render = resolveApprovalRenderer(params.target)?.exec?.buildResolvedPayload;
  return (
    render?.(params) ??
    buildApprovalResolvedReplyPayload({
      approvalId: params.resolved.id,
      approvalSlug: params.resolved.id.slice(0, 8),
      text: buildForwardedExecApprovalResolved(params.resolved),
    })
  );
}

export function buildForwardedPluginPendingPayload(params: {
  cfg: OpenClawConfig;
  request: PluginApprovalRequest;
  target: ExecApprovalForwardTarget;
  nowMs: number;
}): ReplyPayload {
  const render = resolveApprovalRenderer(params.target)?.plugin?.buildPendingPayload;
  return (
    render?.(params) ??
    buildTypedPluginApprovalPendingReplyPayload({
      request: params.request,
      nowMs: params.nowMs,
      text: buildPluginApprovalRequestMessage(params.request, params.nowMs),
      allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions(
        params.request.request,
      ),
    })
  );
}

export function buildForwardedPluginResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: PluginApprovalResolved;
  target: ExecApprovalForwardTarget;
}): ReplyPayload {
  const render = resolveApprovalRenderer(params.target)?.plugin?.buildResolvedPayload;
  return render?.(params) ?? buildPluginApprovalResolvedReplyPayload({ resolved: params.resolved });
}

export function buildForwardedSystemAgentPendingPayload(params: {
  cfg: OpenClawConfig;
  request: SystemAgentApprovalRequest;
  target: ExecApprovalForwardTarget;
  nowMs: number;
}): ReplyPayload {
  const { request, nowMs } = params;
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));
  return buildTypedApprovalPendingReplyPayload({
    approvalKind: "system-agent",
    approvalId: params.request.id,
    approvalSlug: params.request.id.slice(0, 8),
    text: [
      "🛠️ OpenClaw change requires approval",
      `Change: ${request.request.description}`,
      ...(request.request.agentId ? [`Agent: ${request.request.agentId}`] : []),
      `ID: ${request.id}`,
      `Expires in: ${expiresIn}s`,
      `Reply with: /approve ${request.id} ${SYSTEM_AGENT_APPROVAL_DECISIONS.join("|")}`,
    ].join("\n"),
    agentId: params.request.request.agentId ?? null,
    allowedDecisions: SYSTEM_AGENT_APPROVAL_DECISIONS,
    sessionKey: params.request.request.sessionKey ?? null,
  });
}

export function buildForwardedSystemAgentResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: SystemAgentApprovalResolved;
  target: ExecApprovalForwardTarget;
}): ReplyPayload {
  const { resolved } = params;
  return buildApprovalResolvedReplyPayload({
    approvalId: resolved.id,
    approvalSlug: resolved.id.slice(0, 8),
    text:
      resolved.terminalStatus === "expired"
        ? SYSTEM_AGENT_APPROVAL_EXPIRED_TEXT
        : buildSystemAgentApprovalResolvedText({
            approvalKind: "system-agent",
            approvalId: resolved.id,
            phase: "resolved",
            title: "OpenClaw change",
            description: resolved.request?.description ?? null,
            metadata: [],
            commandText: resolved.request?.description ?? "",
            operationSummary: resolved.request?.description ?? "the requested change",
            decision: resolved.decision,
            resolvedBy: resolved.resolvedBy,
            applicationStatus: resolved.applicationStatus,
            terminalStatus: resolved.terminalStatus,
          }),
  });
}
