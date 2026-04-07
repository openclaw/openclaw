import {
  getChannelPlugin,
  resolveChannelApprovalCapability,
} from "../../channels/plugins/index.js";
import { callGateway } from "../../gateway/call.js";
import { timedApprovalStore } from "../../gateway/timed-approval-store.js";
import { logVerbose } from "../../globals.js";
import { isApprovalNotFoundError } from "../../infra/approval-errors.js";
import { resolveApprovalCommandAuthorization } from "../../infra/channel-approval-auth.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatDurationMs, parseDuration } from "../../infra/parse-duration.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { resolveChannelAccountId } from "./channel-context.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_REGEX = /^\/?approve(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/approve@([^\s]+)(?:\s|$)/i;

/** Duration suffixes recognised as timed approvals, e.g. "30m", "1h". */
const DURATION_REGEX = /^\d+(?:\.\d+)?[smhd]$/i;

const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

type ParsedApproveCommand =
  | { ok: true; id: string; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: true; id: string; decision: "timed"; durationMs: number }
  | { ok: false; error: string };

const APPROVE_USAGE_TEXT =
  "Usage: /approve <id> <decision> (see the pending approval message for available decisions)";

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (FOREIGN_COMMAND_MENTION_REGEX.test(trimmed)) {
    return { ok: false, error: "❌ This /approve command targets a different Telegram bot." };
  }
  const commandMatch = trimmed.match(COMMAND_REGEX);
  if (!commandMatch) {
    return null;
  }
  const rest = trimmed.slice(commandMatch[0].length).trim();
  if (!rest) {
    return { ok: false, error: APPROVE_USAGE_TEXT };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: APPROVE_USAGE_TEXT };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

  // Check for duration-style token (e.g. "30m", "1h") in either position
  const firstIsDuration = DURATION_REGEX.test(first);
  const secondIsDuration = DURATION_REGEX.test(second);

  if (firstIsDuration) {
    const durationMs = parseDuration(first);
    if (durationMs !== null) {
      return { ok: true, decision: "timed", durationMs, id: tokens.slice(1).join(" ").trim() };
    }
  }
  if (secondIsDuration) {
    const durationMs = parseDuration(second);
    if (durationMs !== null) {
      return { ok: true, decision: "timed", durationMs, id: tokens[0] };
    }
  }

  if (DECISION_ALIASES[first]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[first],
      id: tokens.slice(1).join(" ").trim(),
    };
  }
  if (DECISION_ALIASES[second]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[second],
      id: tokens[0],
    };
  }
  return { ok: false, error: APPROVE_USAGE_TEXT };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

function formatApprovalSubmitError(error: unknown): string {
  return formatErrorMessage(error);
}

type ApprovalMethod = "exec.approval.resolve" | "plugin.approval.resolve";

function resolveApprovalMethods(params: {
  approvalId: string;
  execAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
  pluginAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
}): ApprovalMethod[] {
  if (params.approvalId.startsWith("plugin:")) {
    return params.pluginAuthorization.authorized ? ["plugin.approval.resolve"] : [];
  }
  if (params.execAuthorization.authorized && params.pluginAuthorization.authorized) {
    return ["exec.approval.resolve", "plugin.approval.resolve"];
  }
  if (params.execAuthorization.authorized) {
    return ["exec.approval.resolve"];
  }
  if (params.pluginAuthorization.authorized) {
    return ["plugin.approval.resolve"];
  }
  return [];
}

function resolveApprovalAuthorizationError(params: {
  approvalId: string;
  execAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
  pluginAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
}): string {
  if (params.approvalId.startsWith("plugin:")) {
    return (
      params.pluginAuthorization.reason ?? "❌ You are not authorized to approve this request."
    );
  }
  return (
    params.execAuthorization.reason ??
    params.pluginAuthorization.reason ??
    "❌ You are not authorized to approve this request."
  );
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  const isPluginId = parsed.id.startsWith("plugin:");
  const effectiveAccountId = resolveChannelAccountId({
    cfg: params.cfg,
    ctx: params.ctx,
    command: params.command,
  });
  const approvalCapability = resolveChannelApprovalCapability(
    getChannelPlugin(params.command.channel),
  );
  const approveCommandBehavior = approvalCapability?.resolveApproveCommandBehavior?.({
    cfg: params.cfg,
    accountId: effectiveAccountId,
    senderId: params.command.senderId,
    approvalKind: isPluginId ? "plugin" : "exec",
  });
  if (approveCommandBehavior?.kind === "ignore") {
    return { shouldContinue: false };
  }
  if (approveCommandBehavior?.kind === "reply") {
    return { shouldContinue: false, reply: { text: approveCommandBehavior.text } };
  }
  const execApprovalAuthorization = resolveApprovalCommandAuthorization({
    cfg: params.cfg,
    channel: params.command.channel,
    accountId: effectiveAccountId,
    senderId: params.command.senderId,
    kind: "exec",
  });
  const pluginApprovalAuthorization = resolveApprovalCommandAuthorization({
    cfg: params.cfg,
    channel: params.command.channel,
    accountId: effectiveAccountId,
    senderId: params.command.senderId,
    kind: "plugin",
  });
  const hasExplicitApprovalAuthorization =
    (execApprovalAuthorization.explicit && execApprovalAuthorization.authorized) ||
    (pluginApprovalAuthorization.explicit && pluginApprovalAuthorization.authorized);
  if (!params.command.isAuthorizedSender && !hasExplicitApprovalAuthorization) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const missingScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "/approve",
    allowedScopes: ["operator.approvals", "operator.admin"],
    missingText: "❌ /approve requires operator.approvals for gateway clients.",
  });
  if (missingScope) {
    return missingScope;
  }

  const resolvedBy = buildResolvedByLabel(params);
  // Timed approvals handled separately; for normal flow decision is a real ExecApprovalDecision.
  const resolvedDecision = parsed.decision === "timed" ? ("allow-once" as const) : parsed.decision;
  const callApprovalMethod = async (method: string): Promise<void> => {
    await callGateway({
      method,
      params: { id: parsed.id, decision: resolvedDecision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  };

  const methods = resolveApprovalMethods({
    approvalId: parsed.id,
    execAuthorization: execApprovalAuthorization,
    pluginAuthorization: pluginApprovalAuthorization,
  });
  if (methods.length === 0) {
    return {
      shouldContinue: false,
      reply: {
        text: resolveApprovalAuthorizationError({
          approvalId: parsed.id,
          execAuthorization: execApprovalAuthorization,
          pluginAuthorization: pluginApprovalAuthorization,
        }),
      },
    };
  }

  // Handle timed approvals separately: store in memory and auto-resolve the current request
  if (parsed.ok && parsed.decision === "timed") {
    const resolvedBy = buildResolvedByLabel(params);
    // Retrieve the pending approval to get the command pattern
    let commandText: string | undefined;
    try {
      const snapshot = await callGateway({
        method: "exec.approval.get",
        params: { id: parsed.id },
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: `Chat approval (${resolvedBy})`,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
      const result = snapshot as { commandText?: string; agentId?: string | null };
      commandText = result?.commandText;
      const agentId = result?.agentId ?? null;
      timedApprovalStore.add({
        commandPattern: commandText ?? parsed.id,
        agentId,
        grantedBy: resolvedBy,
        approvedUntil: Date.now() + parsed.durationMs,
      });
    } catch {
      // Fall through to normal allow-once if we can't look up the command
    }
    // Also submit allow-once for the immediate request so it runs right away
    try {
      await callGateway({
        method: "exec.approval.resolve",
        params: { id: parsed.id, decision: "allow-once" },
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: `Chat approval (${resolvedBy})`,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
    } catch (err) {
      return {
        shouldContinue: false,
        reply: { text: `❌ Failed to submit approval: ${formatErrorMessage(err)}` },
      };
    }
    const durationLabel = formatDurationMs(parsed.durationMs);
    return {
      shouldContinue: false,
      reply: {
        text: `✅ Timed approval granted for ${durationLabel}: \`${commandText ?? parsed.id}\`. Future matching commands will be auto-approved until the window expires.`,
      },
    };
  }

  let lastError: unknown = null;
  for (const [index, method] of methods.entries()) {
    try {
      await callApprovalMethod(method);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const isLastMethod = index === methods.length - 1;
      if (!isApprovalNotFoundError(error) || isLastMethod) {
        return {
          shouldContinue: false,
          reply: { text: `❌ Failed to submit approval: ${formatApprovalSubmitError(error)}` },
        };
      }
    }
  }

  if (lastError) {
    return {
      shouldContinue: false,
      reply: { text: `❌ Failed to submit approval: ${formatApprovalSubmitError(lastError)}` },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Approval ${resolvedDecision} submitted for ${parsed.id}.` },
  };
};
