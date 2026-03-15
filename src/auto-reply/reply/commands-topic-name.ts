import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { isTelegramSurface } from "./channel-context.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_REGEX = /^\/set_topic_name(?:\s|$)/i;
const MAX_NAME_LEN = 64;
const MAX_LABEL_LEN = 64;

function parseTopicNameCommand(
  raw: string,
): { ok: true; name: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(COMMAND_REGEX);
  if (!match) {
    return null;
  }
  const rest = trimmed.slice(match[0].length).trim();
  const name = rest.replace(/·/g, " ").slice(0, MAX_NAME_LEN).trim();
  if (!name) {
    return { ok: false, error: "Usage: /set_topic_name <name>" };
  }
  return { ok: true, name };
}

function resolveConversationLabel(params: Parameters<CommandHandler>[0]): string {
  return (
    (typeof params.ctx.ConversationLabel === "string" ? params.ctx.ConversationLabel.trim() : "") ||
    (typeof params.ctx.GroupSubject === "string" ? params.ctx.GroupSubject.trim() : "")
  );
}

function normalizeBaseLabel(raw: string): string {
  return raw.replace(/^telegram\s*·\s*/i, "").trim();
}

function buildTopicLabel(baseLabel: string, name: string): string {
  const prefix = "telegram";
  const separator = " · ";
  let normalizedBase = baseLabel ? normalizeBaseLabel(baseLabel) : "";

  const maxNameWithoutBase = Math.max(1, MAX_LABEL_LEN - (prefix + separator).length);
  let nextName = name.slice(0, maxNameWithoutBase).trim();

  if (normalizedBase) {
    const maxBaseLen = MAX_LABEL_LEN - (prefix + separator + separator + nextName).length;
    if (maxBaseLen > 0) {
      normalizedBase = normalizedBase.slice(0, maxBaseLen).trim();
    } else {
      normalizedBase = "";
    }
  }

  const maxNameLen = Math.max(
    1,
    MAX_LABEL_LEN -
      (prefix + separator + (normalizedBase ? normalizedBase + separator : "")).length,
  );
  nextName = name.slice(0, maxNameLen).trim();

  return normalizedBase
    ? `${prefix}${separator}${normalizedBase}${separator}${nextName}`
    : `${prefix}${separator}${nextName}`;
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
  if (!isTelegramSurface(params)) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ /set_topic_name only works for Telegram topics." },
    };
  }
  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }
  const threadId = params.ctx.MessageThreadId;
  if (threadId == null || `${threadId}`.trim() === "") {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ /set_topic_name only works inside a Telegram topic." },
    };
  }
  // Telegram topics are thread-scoped; sessionKey already includes the thread context.
  // threadId is only used to enforce topic usage, not to disambiguate sessions.patch.
  if (!params.sessionKey) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Could not resolve the current session key." },
    };
  }
  const baseLabel = resolveConversationLabel(params);
  const label = buildTopicLabel(baseLabel, parsed.name);

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
