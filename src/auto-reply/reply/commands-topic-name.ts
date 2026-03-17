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

function extractIdentitySuffix(raw: string, threadId: string | number | null | undefined): string {
  const matches = raw.match(/\b(?:id:[^\s]+|topic:[^\s]+)/g) || [];
  const idToken = matches.find((token) => token.startsWith("id:"));
  const topicToken = matches.find((token) => token.startsWith("topic:"));
  const parts: string[] = [];
  if (idToken) {
    parts.push(idToken);
  }
  if (topicToken) {
    parts.push(topicToken);
  } else if (threadId != null) {
    parts.push(`topic:${threadId}`);
  }
  return parts.join(" ").trim();
}

function stripIdentityTokens(raw: string): string {
  return raw
    .replace(/\s*\b(?:id:[^\s]+|topic:[^\s]+)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fitBaseLabel(base: string, suffix: string, maxLen: number): string {
  if (!suffix) {
    return base.slice(0, maxLen).trim();
  }
  if (suffix.length >= maxLen) {
    return suffix.slice(0, maxLen).trim();
  }
  const available = Math.max(0, maxLen - suffix.length - 1);
  const trimmedBase = base.slice(0, available).trim();
  return trimmedBase ? `${trimmedBase} ${suffix}` : suffix;
}

function buildTopicLabel(baseLabel: string, identitySuffix: string, name: string): string {
  const prefix = "telegram";
  const separator = " · ";
  let normalizedBase = baseLabel ? normalizeBaseLabel(baseLabel) : "";

  const maxNameWithoutBase = Math.max(1, MAX_LABEL_LEN - (prefix + separator).length);
  let nextName = name.slice(0, maxNameWithoutBase).trim();

  if (normalizedBase || identitySuffix) {
    const maxBaseLen = MAX_LABEL_LEN - (prefix + separator + separator + nextName).length;
    if (maxBaseLen > 0) {
      normalizedBase = fitBaseLabel(normalizedBase, identitySuffix, maxBaseLen);
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
  // threadId is used for identity in labels, not as a sessions.patch selector.
  if (!params.sessionKey) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Could not resolve the current session key." },
    };
  }
  const rawLabel = resolveConversationLabel(params);
  const identitySuffix = extractIdentitySuffix(rawLabel, threadId);
  const baseLabel = stripIdentityTokens(rawLabel);
  const label = buildTopicLabel(baseLabel, identitySuffix, parsed.name);

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
