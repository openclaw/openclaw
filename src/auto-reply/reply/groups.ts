import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import { findChatChannelMeta, normalizeChatChannelId } from "../../channels/registry.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { PreparedReplyConversation } from "./prompt-session-context.js";

const groupsRuntimeLoader = createLazyImportLoader(() => import("./groups.runtime.js"));

async function resolveRuntimeChannelId(raw?: string | null): Promise<string | null> {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return null;
  }
  const { getChannelPlugin, normalizeChannelId } = await groupsRuntimeLoader.load();
  try {
    if (getChannelPlugin(normalized)) {
      return normalized;
    }
  } catch {
    // Plugin registry may not be initialized in shared/test contexts.
  }
  try {
    return normalizeChannelId(raw) ?? normalized;
  } catch {
    return normalized;
  }
}

/** Resolves whether a group/channel turn requires an explicit mention. */
export async function resolveGroupRequireMention(params: {
  cfg: OpenClawConfig;
  group: PreparedReplyConversation["group"];
}): Promise<boolean> {
  const { cfg, group } = params;
  const channel = await resolveRuntimeChannelId(group.channel);
  if (!channel) {
    return true;
  }
  const { groupId, groupChannel, groupSpace, accountId } = group;
  let requireMention: boolean | undefined;
  const runtime = await groupsRuntimeLoader.load();
  try {
    requireMention = runtime.getChannelPlugin(channel)?.groups?.resolveRequireMention?.({
      cfg,
      groupId,
      groupChannel,
      groupSpace,
      accountId,
    });
  } catch {
    requireMention = undefined;
  }
  if (typeof requireMention === "boolean") {
    return requireMention;
  }
  return resolveChannelGroupRequireMention({
    cfg,
    channel,
    groupId,
    accountId,
  });
}

/** Converts requireMention into the default prompt activation label. */
export function defaultGroupActivation(requireMention: boolean): "always" | "mention" {
  return !requireMention ? "always" : "mention";
}

function resolveProviderLabel(rawProvider: string | undefined): string {
  const providerKey = normalizeOptionalLowercaseString(rawProvider) ?? "";
  if (!providerKey) {
    return "chat";
  }
  if (isInternalMessageChannel(providerKey)) {
    return "WebChat";
  }
  const channelId = normalizeChatChannelId(providerKey);
  const label = channelId ? findChatChannelMeta(channelId)?.label : undefined;
  if (label) {
    return label;
  }
  return `${providerKey.at(0)?.toUpperCase() ?? ""}${providerKey.slice(1)}`;
}

const SOURCE_DELIVERY_DEFAULTS_GUIDANCE =
  "Current-turn delivery instructions override these defaults. Set `final=false` on sends made while work remains, and do not repeat content already delivered.";

/**
 * Builds trusted group/channel delivery guidance.
 *
 * Room names, members, and history are rendered separately as untrusted inbound
 * context. Keep delivery defaults for harnesses that supply only turn overrides.
 */
function buildGroupChatContext(params: {
  sessionCtx: TemplateContext;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): string {
  const providerLabel = resolveProviderLabel(params.sessionCtx.Provider);
  const provider = normalizeOptionalLowercaseString(params.sessionCtx.Provider);
  const messageToolOnly = params.sourceReplyDeliveryMode === "message_tool_only";
  const sharedChatNoun =
    normalizeOptionalLowercaseString(params.sessionCtx.ChatType) === "channel"
      ? "channel"
      : "group chat";
  const destinationLabel = `this ${sharedChatNoun}`;

  const lines = [`You are in a ${providerLabel} ${sharedChatNoun}.`];
  if (messageToolOnly) {
    lines.push(
      `By default, final text stays private and is not automatically sent to ${destinationLabel}. Use the message tool with action=send for visible replies here; its target defaults to ${destinationLabel}.`,
    );
  } else {
    lines.push(
      `By default, final text is automatically sent to ${destinationLabel}. Use the message tool for attachments when available.`,
    );
  }
  lines.push(
    SOURCE_DELIVERY_DEFAULTS_GUIDANCE,
    "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.",
  );
  const channelId = normalizeChatChannelId(provider) ?? provider ?? "";
  const tableMode = getLoadedChannelPluginForRead(channelId)?.messaging?.defaultMarkdownTableMode;
  const tableGuidance =
    tableMode === "block" || tableMode === "off" ? "" : " Avoid Markdown tables.";
  lines.push(
    `Write like a human.${tableGuidance} Minimize empty lines and use normal chat conventions, not document-style spacing. Don't type literal \\n sequences; use real line breaks sparingly.`,
  );
  lines.push("If addressed to someone else, stay silent unless invited or correcting key facts.");
  if (provider === "discord") {
    lines.push("Discord: wrap bare URLs like <https://example.com> to suppress embeds.");
  }
  lines.push(
    "When subagent or session-spawn tools are available and a directly requested group-chat task will require several tool calls, prefer delegating bounded side investigations early so the channel gets a responsive path forward. Keep the critical path local, avoid subagents for simple one-step work, and only surface concise group-visible updates when they add value.",
  );
  if (messageToolOnly) {
    lines.push(
      `If no visible ${sharedChatNoun === "channel" ? "channel" : "group"} response is needed, do not call message(action=send).`,
    );
  }
  lines.push(
    `If no text reply is needed, including after a reaction or other action, reply with exactly "${SILENT_REPLY_TOKEN}" as the entire final answer, without commentary, punctuation, or formatting. ${SILENT_REPLY_TOKEN} discards anything written this turn that was not sent, so send confirmations before ending silently.`,
  );
  return lines.join(" ");
}

/** Builds system prompt context for direct conversations. */
function buildDirectChatContext(params: {
  sessionCtx: TemplateContext;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): string {
  const providerLabel = resolveProviderLabel(params.sessionCtx.Provider);
  return [
    `You are in a ${providerLabel} direct conversation.`,
    ...(params.sourceReplyDeliveryMode === "message_tool_only"
      ? [
          "By default, final text stays private and is not automatically sent to this conversation. Use the message tool with action=send for visible replies here; its target defaults to this conversation.",
          "If no visible direct response is needed, do not call message(action=send).",
        ]
      : ["By default, final text is automatically sent to this conversation."]),
    SOURCE_DELIVERY_DEFAULTS_GUIDANCE,
  ].join(" ");
}

/** Selects the conversation guidance shared by incoming and continuation turns. */
export function buildSourceConversationContext(
  params: Parameters<typeof buildGroupChatContext>[0],
): string {
  const chatType = normalizeOptionalLowercaseString(params.sessionCtx.ChatType);
  return chatType === "direct" || chatType === "dm"
    ? buildDirectChatContext(params)
    : chatType === "group" || chatType === "channel"
      ? buildGroupChatContext(params)
      : "";
}

/** Builds the channel-specific group intro injected into the system prompt. */
export function buildGroupIntro(params: {
  activation?: PreparedReplyConversation["activation"];
  defaultActivation: "always" | "mention";
}): string {
  const activation = normalizeGroupActivation(params.activation) ?? params.defaultActivation;
  if (activation === "always") {
    return "Activation: always-on (you receive every group message). You see every message; most need no response. When you do reply, address the specific sender noted in the message context.";
  }
  return "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included). Address the specific sender noted in the message context.";
}
