import {
  getChannelPlugin,
  normalizeChannelId as normalizePluginChannelId,
} from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { resolveWhatsAppGroupIntroHint } from "../../channels/plugins/whatsapp-shared.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import type { GroupKeyResolution, SessionEntry } from "../../config/sessions.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";

function extractGroupId(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return parts.slice(2).join(":") || undefined;
  }
  if (
    parts.length >= 2 &&
    parts[0]?.toLowerCase() === "whatsapp" &&
    trimmed.toLowerCase().includes("@g.us")
  ) {
    return parts.slice(1).join(":") || undefined;
  }
  if (parts.length >= 2 && (parts[0] === "group" || parts[0] === "channel")) {
    return parts.slice(1).join(":") || undefined;
  }
  return trimmed;
}

function resolveDockChannelId(raw?: string | null): ChannelId | null {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  try {
    if (getChannelPlugin(normalized as ChannelId)) {
      return normalized as ChannelId;
    }
  } catch {
    // Plugin registry may not be initialized in shared/test contexts.
  }
  try {
    return normalizePluginChannelId(raw) ?? (normalized as ChannelId);
  } catch {
    return normalized as ChannelId;
  }
}

export function resolveGroupRequireMention(params: {
  cfg: OpenClawConfig;
  ctx: TemplateContext;
  groupResolution?: GroupKeyResolution;
}): boolean {
  const { cfg, ctx, groupResolution } = params;
  const rawChannel = groupResolution?.channel ?? ctx.Provider?.trim();
  const channel = resolveDockChannelId(rawChannel);
  if (!channel) {
    return true;
  }
  const groupId = groupResolution?.id ?? extractGroupId(ctx.From);
  const groupChannel = ctx.GroupChannel?.trim() ?? ctx.GroupSubject?.trim();
  const groupSpace = ctx.GroupSpace?.trim();
  let requireMention: boolean | undefined;
  try {
    requireMention = getChannelPlugin(channel)?.groups?.resolveRequireMention?.({
      cfg,
      groupId,
      groupChannel,
      groupSpace,
      accountId: ctx.AccountId,
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
    accountId: ctx.AccountId,
  });
}

export function defaultGroupActivation(requireMention: boolean): "always" | "mention" {
  return !requireMention ? "always" : "mention";
}

/**
 * Resolve a human-readable provider label from the raw provider string.
 */
function resolveProviderLabel(rawProvider: string | undefined): string {
  const providerKey = rawProvider?.trim().toLowerCase() ?? "";
  if (!providerKey) {
    return "chat";
  }
  if (isInternalMessageChannel(providerKey)) {
    return "WebChat";
  }
  const providerId = resolveDockChannelId(rawProvider?.trim());
  if (providerId) {
    return getChannelPlugin(providerId)?.meta.label ?? providerId;
  }
  return `${providerKey.at(0)?.toUpperCase() ?? ""}${providerKey.slice(1)}`;
}

/**
 * Build a persistent group-chat context block that is always included in the
 * system prompt for group-chat sessions (every turn, not just the first).
 *
 * Contains: group name, participants, and an explicit instruction to reply
 * directly instead of using the message tool.
 */
export function buildGroupChatContext(params: { sessionCtx: TemplateContext }): string {
  const subject = params.sessionCtx.GroupSubject?.trim();
  const members = params.sessionCtx.GroupMembers?.trim();
  const providerLabel = resolveProviderLabel(params.sessionCtx.Provider);

  const lines: string[] = [];
  if (subject) {
    lines.push(`You are in the ${providerLabel} group chat "${subject}".`);
  } else {
    lines.push(`You are in a ${providerLabel} group chat.`);
  }
  if (members) {
    lines.push(`Participants: ${members}.`);
  }
  lines.push(
    "Your replies are automatically sent to this group chat. Do not use the message tool to send to this same group — just reply normally.",
  );
  return lines.join(" ");
}

export function buildGroupIntro(params: {
  cfg: OpenClawConfig;
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  defaultActivation: "always" | "mention";
  silentToken: string;
}): string {
  const activation =
    normalizeGroupActivation(params.sessionEntry?.groupActivation) ?? params.defaultActivation;
  const rawProvider = params.sessionCtx.Provider?.trim();
  const providerId = resolveDockChannelId(rawProvider);
  const activationLine =
    activation === "always"
      ? "Activation: always-on (you receive every group message)."
      : "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included).";
  const groupId = params.sessionEntry?.groupId ?? extractGroupId(params.sessionCtx.From);
  const groupChannel =
    params.sessionCtx.GroupChannel?.trim() ?? params.sessionCtx.GroupSubject?.trim();
  const groupSpace = params.sessionCtx.GroupSpace?.trim();
  const providerIdsLine = providerId
    ? (getChannelPlugin(providerId)?.groups?.resolveGroupIntroHint?.({
        cfg: params.cfg,
        groupId,
        groupChannel,
        groupSpace,
        accountId: params.sessionCtx.AccountId,
      }) ?? (providerId === "whatsapp" ? resolveWhatsAppGroupIntroHint() : undefined))
    : undefined;
  const silenceLine =
    activation === "always"
      ? `If no response is needed, reply with exactly "${params.silentToken}" (and nothing else) so OpenClaw stays silent. Do not add any other words, punctuation, tags, markdown/code blocks, or explanations.`
      : undefined;
  const cautionLine =
    activation === "always"
      ? "Be extremely selective: reply only when directly addressed or clearly helpful. Otherwise stay silent."
      : undefined;
  const lurkLine =
    "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.";
  const styleLine =
    "Write like a human. Avoid Markdown tables. Don't type literal \\n sequences; use real line breaks sparingly.";
  return [activationLine, providerIdsLine, silenceLine, cautionLine, lurkLine, styleLine]
    .filter(Boolean)
    .join(" ")
    .concat(" Address the specific sender noted in the message context.");
}
