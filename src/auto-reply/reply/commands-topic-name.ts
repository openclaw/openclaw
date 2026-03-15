import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { isTelegramSurface } from "./channel-context.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_REGEX = /^\/set_topic_name(?:\s|$)/i;

function parseTopicNameCommand(
  raw: string,
): { ok: true; name: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(COMMAND_REGEX);
  if (!match) {
    return null;
  }
  const rest = trimmed.slice(match[0].length).trim();
  if (!rest) {
    return { ok: false, error: "Usage: /set_topic_name <name>" };
  }
  return { ok: true, name: rest };
}

function resolveConversationLabel(params: Parameters<CommandHandler>[0]): string {
  const base =
    (typeof params.ctx.GroupSubject === "string" ? params.ctx.GroupSubject.trim() : "") ||
    (typeof params.ctx.ConversationLabel === "string" ? params.ctx.ConversationLabel.trim() : "") ||
    "telegram";
  return base;
}

export const handleSetTopicNameCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseTopicNameCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /set_topic_name from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }
  if (!isTelegramSurface(params)) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ /set_topic_name only works for Telegram topics." },
    };
  }
  const threadId = params.ctx.MessageThreadId;
  if (threadId == null || `${threadId}`.trim() === "") {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ /set_topic_name only works inside a Telegram topic." },
    };
  }
  if (!params.sessionKey) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Could not resolve the current session key." },
    };
  }
  const baseLabel = resolveConversationLabel(params);
  const label = `telegram · ${baseLabel} · ${parsed.name}`;

  try {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: params.sessionKey,
        label,
      },
      timeoutMs: 10_000,
    });
  } catch (err) {
    logVerbose(`/set_topic_name gateway error: ${String(err)}`);
    return {
      shouldContinue: false,
      reply: { text: "❌ Failed to set topic name. Please try again later." },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Topic label set to ${label}.` },
  };
};
