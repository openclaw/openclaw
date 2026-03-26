import {
  isSlackExecApprovalApprover,
  isSlackExecApprovalClientEnabled,
} from "../../../extensions/slack/exec-approvals-api.js";
import {
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalClientEnabled,
} from "../../../extensions/telegram/api.js";
import { callGateway } from "../../gateway/call.js";
import { ErrorCodes } from "../../gateway/protocol/index.js";
import { logVerbose } from "../../globals.js";
import {
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
} from "../../plugin-sdk/discord-surface.js";
import {
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalApprover,
} from "../../plugin-sdk/telegram-runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_REGEX = /^\/approve(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/approve@([^\s]+)(?:\s|$)/i;

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
  | { ok: false; error: string };

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
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

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
  return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

function readErrorCode(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readApprovalNotFoundDetailsReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason : null;
}

function isApprovalNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const gatewayCode = readErrorCode((err as { gatewayCode?: unknown }).gatewayCode);
  if (gatewayCode === ErrorCodes.APPROVAL_NOT_FOUND) {
    return true;
  }

  const detailsReason = readApprovalNotFoundDetailsReason((err as { details?: unknown }).details);
  if (
    gatewayCode === ErrorCodes.INVALID_REQUEST &&
    detailsReason === ErrorCodes.APPROVAL_NOT_FOUND
  ) {
    return true;
  }

  // Legacy server/client combinations may only include the message text.
  return /unknown or expired approval id/i.test(err.message);
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
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }
  const isPluginId = parsed.id.startsWith("plugin:");
  let discordExecApprovalDeniedReply: { shouldContinue: false; reply: { text: string } } | null =
    null;
  let isTelegramExplicitApprover = false;

  if (params.command.channel === "telegram") {
    const telegramApproverContext = {
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
      senderId: params.command.senderId,
    };
    isTelegramExplicitApprover = isTelegramExecApprovalApprover(telegramApproverContext);

    if (!isPluginId && !isTelegramExecApprovalAuthorizedSender(telegramApproverContext)) {
      return {
        shouldContinue: false,
        reply: { text: "❌ You are not authorized to approve exec requests on Telegram." },
      };
    }

    if (isPluginId && !isTelegramExplicitApprover) {
      return {
        shouldContinue: false,
        reply: { text: "❌ You are not authorized to approve plugin requests on Telegram." },
      };
    }
  }

  if (params.command.channel === "discord" && !isPluginId) {
    const discordApproverContext = {
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
      senderId: params.command.senderId,
    };
    if (!isDiscordExecApprovalClientEnabled(discordApproverContext)) {
      discordExecApprovalDeniedReply = {
        shouldContinue: false,
        reply: { text: "❌ Discord exec approvals are not enabled for this bot account." },
      };
    }
    if (!discordExecApprovalDeniedReply && !isDiscordExecApprovalApprover(discordApproverContext)) {
      discordExecApprovalDeniedReply = {
        shouldContinue: false,
        reply: { text: "❌ You are not authorized to approve exec requests on Discord." },
      };
    }
  }

  // Keep plugin-ID routing independent from exec approval client enablement so
  // forwarded plugin approvals remain resolvable, but still require explicit
  // Discord approver membership for security parity.
  if (
    params.command.channel === "discord" &&
    isPluginId &&
    !isDiscordExecApprovalApprover({
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
      senderId: params.command.senderId,
    })
  ) {
    return {
      shouldContinue: false,
      reply: { text: "❌ You are not authorized to approve plugin requests on Discord." },
    };
  }

  if (params.command.channel === "slack") {
    if (!isSlackExecApprovalClientEnabled({ cfg: params.cfg, accountId: params.ctx.AccountId })) {
      return {
        shouldContinue: false,
        reply: { text: "❌ Slack exec approvals are not enabled for this bot account." },
      };
    }
    if (
      !isSlackExecApprovalApprover({
        cfg: params.cfg,
        accountId: params.ctx.AccountId,
        senderId: params.command.senderId,
      })
    ) {
      return {
        shouldContinue: false,
        reply: { text: "❌ You are not authorized to approve exec requests on Slack." },
      };
    }
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
  const callApprovalMethod = async (method: string): Promise<void> => {
    await callGateway({
      method,
      params: { id: parsed.id, decision: parsed.decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  };

  // Plugin approval IDs are kind-prefixed (`plugin:<uuid>`); route directly when detected.
  // Unprefixed IDs try exec first, then fall back to plugin for backward compat.
  if (isPluginId) {
    try {
      await callApprovalMethod("plugin.approval.resolve");
    } catch (err) {
      return {
        shouldContinue: false,
        reply: { text: `❌ Failed to submit approval: ${String(err)}` },
      };
    }
  } else {
    if (discordExecApprovalDeniedReply) {
      // Preserve the legacy unprefixed plugin fallback on Discord even when
      // exec approvals are unavailable to this sender.
      try {
        await callApprovalMethod("plugin.approval.resolve");
      } catch (pluginErr) {
        if (isApprovalNotFoundError(pluginErr)) {
          return discordExecApprovalDeniedReply;
        }
        return {
          shouldContinue: false,
          reply: { text: `❌ Failed to submit approval: ${String(pluginErr)}` },
        };
      }
      return {
        shouldContinue: false,
        reply: { text: `✅ Approval ${parsed.decision} submitted for ${parsed.id}.` },
      };
    }
    try {
      await callApprovalMethod("exec.approval.resolve");
    } catch (err) {
      if (isApprovalNotFoundError(err)) {
        if (params.command.channel === "telegram" && !isTelegramExplicitApprover) {
          return {
            shouldContinue: false,
            reply: { text: `❌ Failed to submit approval: ${String(err)}` },
          };
        }
        try {
          await callApprovalMethod("plugin.approval.resolve");
        } catch (pluginErr) {
          return {
            shouldContinue: false,
            reply: { text: `❌ Failed to submit approval: ${String(pluginErr)}` },
          };
        }
      } else {
        return {
          shouldContinue: false,
          reply: { text: `❌ Failed to submit approval: ${String(err)}` },
        };
      }
    }
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Approval ${parsed.decision} submitted for ${parsed.id}.` },
  };
};
