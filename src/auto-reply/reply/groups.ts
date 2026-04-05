import type { OpenClawConfig } from "../../config/config.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import type { GroupKeyResolution, SessionEntry } from "../../config/sessions.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";
import { extractExplicitGroupId } from "./group-id.js";

let groupsRuntimePromise: Promise<typeof import("./groups.runtime.js")> | null = null;

function loadGroupsRuntime() {
  groupsRuntimePromise ??= import("./groups.runtime.js");
  return groupsRuntimePromise;
}

function resolveGroupId(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? "").trim();
  return extractExplicitGroupId(trimmed) ?? (trimmed || undefined);
}

function resolveLooseChannelId(raw?: string | null): string | null {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return normalized;
}

async function resolveRuntimeChannelId(raw?: string | null): Promise<string | null> {
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
  return `${providerKey.at(0)?.toUpperCase() ?? ""}${providerKey.slice(1)}`;
}

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
  const activationLine =
    activation === "always"
      ? "Activation: always-on (you receive every group message)."
      : "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included).";
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
    "Write like a human. Avoid Markdown tables. Minimize empty lines and use normal chat conventions, not document-style spacing. Don't type literal \\n sequences; use real line breaks sparingly.";
  return [activationLine, silenceLine, cautionLine, lurkLine, styleLine]
    .filter(Boolean)
    .join(" ")
    .concat(" Address the specific sender noted in the message context.");
}
