import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import type { GroupKeyResolution, SessionEntry } from "../../config/sessions.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";
import { extractExplicitGroupId } from "./group-id.js";

const WHATSAPP_GROUP_INTRO_HINT =
  "WhatsApp IDs: SenderId is the participant JID (group participant id).";

const CHANNEL_LABELS: Partial<Record<ChannelId, string>> = {
  bluebubbles: "BlueBubbles",
  discord: "Discord",
  imessage: "iMessage",
  line: "LINE",
  signal: "Signal",
  slack: "Slack",
  telegram: "Telegram",
  webchat: "WebChat",
  whatsapp: "WhatsApp",
};

let groupsRuntimePromise: Promise<typeof import("./groups.runtime.js")> | null = null;

function loadGroupsRuntime() {
  groupsRuntimePromise ??= import("./groups.runtime.js");
  return groupsRuntimePromise;
}

function resolveGroupId(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? "").trim();
  return extractExplicitGroupId(trimmed) ?? (trimmed || undefined);
}

function resolveLooseChannelId(raw?: string | null): ChannelId | null {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized as ChannelId;
}

async function resolveRuntimeChannelId(raw?: string | null): Promise<ChannelId | null> {
  const normalized = resolveLooseChannelId(raw);
  if (!normalized) {
    return null;
  }
  const { getChannelPlugin, normalizeChannelId } = await loadGroupsRuntime();
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

async function resolveBuiltInRequireMentionFromConfig(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  groupChannel?: string;
  groupId?: string;
  groupSpace?: string;
  accountId?: string | null;
}): Promise<boolean | undefined> {
  const runtime = await loadGroupsRuntime();
  switch (params.channel) {
    case "discord":
      return runtime.resolveDiscordGroupRequireMention(params);
    case "slack":
      return runtime.resolveSlackGroupRequireMention(params);
    default:
      return undefined;
  }
}

export async function resolveGroupRequireMention(params: {
  cfg: OpenClawConfig;
  ctx: TemplateContext;
  groupResolution?: GroupKeyResolution;
}): Promise<boolean> {
  const { cfg, ctx, groupResolution } = params;
  const rawChannel = groupResolution?.channel ?? ctx.Provider?.trim();
  const channel = await resolveRuntimeChannelId(rawChannel);
  if (!channel) {
    return true;
  }
  const groupId = groupResolution?.id ?? resolveGroupId(ctx.From);
  const groupChannel = ctx.GroupChannel?.trim() ?? ctx.GroupSubject?.trim();
  const groupSpace = ctx.GroupSpace?.trim();
  let requireMention: boolean | undefined;
  const runtime = await loadGroupsRuntime();
  try {
    requireMention = runtime.getChannelPlugin(channel)?.groups?.resolveRequireMention?.({
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
  const builtInRequireMention = await resolveBuiltInRequireMentionFromConfig({
    cfg,
    channel,
    groupChannel,
    groupId,
    groupSpace,
    accountId: ctx.AccountId,
  });
  if (typeof builtInRequireMention === "boolean") {
    return builtInRequireMention;
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

function resolveProviderLabel(rawProvider: string | undefined): string {
  const providerKey = rawProvider?.trim().toLowerCase() ?? "";
  if (!providerKey) {
    return "chat";
  }
  if (isInternalMessageChannel(providerKey)) {
    return "WebChat";
  }
  const providerId = resolveLooseChannelId(rawProvider?.trim());
  if (providerId) {
    return CHANNEL_LABELS[providerId] ?? providerId;
  }
  return `${providerKey.at(0)?.toUpperCase() ?? ""}${providerKey.slice(1)}`;
}

export function buildGroupChatContext(params: { sessionCtx: TemplateContext }): string {
  const subject = params.sessionCtx.GroupSubject?.trim();
  const members = params.sessionCtx.GroupMembers?.trim();
  const providerLabel = resolveProviderLabel(params.sessionCtx.Provider);
  const botUsername = params.sessionCtx.BotUsername?.trim();
  const otherBots = params.sessionCtx.OtherBotUsernames?.map((b) => b.trim()).filter(Boolean) ?? [];

  const lines: string[] = [];
  if (subject) {
    lines.push(`You are in the ${providerLabel} group chat "${subject}".`);
  } else {
    lines.push(`You are in a ${providerLabel} group chat.`);
  }
  if (members) {
    lines.push(`Participants: ${members}.`);
  }
  if (botUsername) {
    if (otherBots.length > 0) {
      lines.push(
        `Your bot username is @${botUsername}. Other bots in this group: ${otherBots.map((b) => `@${b}`).join(", ")}. Only respond to messages addressed to you (via @${botUsername} mention or reply to your messages). Do not act on messages clearly addressed to other bots.`,
      );
    } else {
      lines.push(`Your bot username is @${botUsername}.`);
    }
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
  const providerId = resolveLooseChannelId(params.sessionCtx.Provider?.trim());
  const activationLine =
    activation === "always"
      ? "Activation: always-on (you receive every group message)."
      : "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included).";
  const providerIdsLine = providerId === "whatsapp" ? WHATSAPP_GROUP_INTRO_HINT : undefined;
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
  const otherBots = params.sessionCtx.OtherBotUsernames?.map((b) => b.trim()).filter(Boolean) ?? [];
  const multiAgentLine =
    otherBots.length > 0
      ? `This group contains multiple bots (${otherBots.map((b) => `@${b}`).join(", ")}). The chat history includes which bot each message mentioned or replied to — use that to ignore messages not addressed to you.`
      : undefined;
  return [
    activationLine,
    providerIdsLine,
    silenceLine,
    cautionLine,
    lurkLine,
    styleLine,
    multiAgentLine,
  ]
    .filter(Boolean)
    .join(" ")
    .concat(" Address the specific sender noted in the message context.");
}
