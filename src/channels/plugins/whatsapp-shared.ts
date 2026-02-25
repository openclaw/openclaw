import { resolveOutboundSendDep } from "../../infra/outbound/send-deps.js";
import { createAttachedChannelResultAdapter } from "../../plugin-sdk/channel-send-result.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import { escapeRegExp } from "../../utils.js";
import type { ChannelOutboundAdapter } from "./types.js";

export const WHATSAPP_GROUP_INTRO_HINT =
  "WhatsApp IDs: SenderId is the participant JID (group participant id).";

export type WhatsAppGroupSystemPromptParams = {
  /** Pre-resolved merged account config (systemPrompt + groups). Mirrors Telegram's groupConfig param style. */
  accountConfig?: {
    systemPrompt?: string;
    groups?: Record<string, { systemPrompt?: string }>;
  } | null;
  groupId?: string | null;
};

/**
 * Resolves and combines WhatsApp system prompts from a pre-resolved account config slice.
 * Follows the same pattern as Telegram's resolveTelegramGroupPromptSettings: the caller
 * resolves the account config first, then passes the relevant slice here.
 *
 * Resolution hierarchy for group messages:
 *
 * 1. Account system prompt (channels.whatsapp.systemPrompt or
 *    accounts.<id>.systemPrompt):
 *    - Root value applies to all accounts.
 *    - Account-level value overrides root for that account.
 *
 * 2. Group system prompt (groups["<groupId>"].systemPrompt or
 *    groups["*"].systemPrompt):
 *    - The specific group entry is used if it defines a systemPrompt.
 *    - Falls back to groups["*"].systemPrompt for groups with no specific entry.
 *    - resolveWhatsAppAccount uses the same override semantics as the shared
 *      resolveChannelGroups helper: account groups replace root groups entirely
 *      (no deep merge). The resolved account config therefore already contains
 *      root groups (including "*") whenever the account defines no groups of its
 *      own, mirroring Telegram's resolveTelegramGroupPromptSettings pattern.
 *
 * 3. Final prompt delivered to the agent for group messages:
 *    accountSystemPrompt + "\n\n" + groupSystemPrompt
 *    (either part is omitted if not configured)
 */
export function resolveWhatsAppGroupSystemPrompt(
  params: WhatsAppGroupSystemPromptParams,
): string | undefined {
  const accountSystemPrompt = params.accountConfig?.systemPrompt?.trim() || undefined;

  // Get group-level systemPrompt if groupId is provided.
  // Resolve per-field: use the specific group's systemPrompt if set, otherwise
  // fall back to the wildcard "*" entry so default prompts still apply even when
  // the specific group entry only defines non-prompt settings (e.g. requireMention).
  let groupSystemPrompt: string | undefined;
  if (params.groupId) {
    const groups = params.accountConfig?.groups;
    // Resolution order: specific group entry → wildcard "*" entry.
    // Root groups naturally reach here when the account defines no groups of its
    // own (resolveWhatsAppAccount uses override-not-merge semantics, same as
    // resolveChannelGroups: accountGroups ?? rootGroups).
    groupSystemPrompt =
      groups?.[params.groupId]?.systemPrompt?.trim() ||
      groups?.["*"]?.systemPrompt?.trim() ||
      undefined;
  }

  // Combine prompts following Telegram's pattern
  const systemPrompts = [accountSystemPrompt, groupSystemPrompt].filter(Boolean);
  return systemPrompts.length > 0 ? systemPrompts.join("\n\n") : undefined;
}

export function resolveWhatsAppGroupIntroHint(): string {
  return WHATSAPP_GROUP_INTRO_HINT;
}

export function resolveWhatsAppMentionStripRegexes(ctx: { To?: string | null }): RegExp[] {
  const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
  if (!selfE164) {
    return [];
  }
  const escaped = escapeRegExp(selfE164);
  return [new RegExp(escaped, "g"), new RegExp(`@${escaped}`, "g")];
}

type WhatsAppChunker = NonNullable<ChannelOutboundAdapter["chunker"]>;
type WhatsAppSendMessage = PluginRuntimeChannel["whatsapp"]["sendMessageWhatsApp"];
type WhatsAppSendPoll = PluginRuntimeChannel["whatsapp"]["sendPollWhatsApp"];

type CreateWhatsAppOutboundBaseParams = {
  chunker: WhatsAppChunker;
  sendMessageWhatsApp: WhatsAppSendMessage;
  sendPollWhatsApp: WhatsAppSendPoll;
  shouldLogVerbose: () => boolean;
  resolveTarget: ChannelOutboundAdapter["resolveTarget"];
  normalizeText?: (text: string | undefined) => string;
  skipEmptyText?: boolean;
};

export function createWhatsAppOutboundBase({
  chunker,
  sendMessageWhatsApp,
  sendPollWhatsApp,
  shouldLogVerbose,
  resolveTarget,
  normalizeText = (text) => text ?? "",
  skipEmptyText = false,
}: CreateWhatsAppOutboundBaseParams): Pick<
  ChannelOutboundAdapter,
  | "deliveryMode"
  | "chunker"
  | "chunkerMode"
  | "textChunkLimit"
  | "pollMaxOptions"
  | "resolveTarget"
  | "sendText"
  | "sendMedia"
  | "sendPoll"
> {
  return {
    deliveryMode: "gateway",
    chunker,
    chunkerMode: "text",
    textChunkLimit: 4000,
    pollMaxOptions: 12,
    resolveTarget,
    ...createAttachedChannelResultAdapter({
      channel: "whatsapp",
      sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) => {
        const normalizedText = normalizeText(text);
        if (skipEmptyText && !normalizedText) {
          return { messageId: "" };
        }
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp") ?? sendMessageWhatsApp;
        return await send(to, normalizedText, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
          gifPlayback,
        });
      },
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        gifPlayback,
      }) => {
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp") ?? sendMessageWhatsApp;
        return await send(to, normalizeText(text), {
          verbose: false,
          cfg,
          mediaUrl,
          mediaLocalRoots,
          accountId: accountId ?? undefined,
          gifPlayback,
        });
      },
      sendPoll: async ({ cfg, to, poll, accountId }) =>
        await sendPollWhatsApp(to, poll, {
          verbose: shouldLogVerbose(),
          accountId: accountId ?? undefined,
          cfg,
        }),
    }),
  };
}
