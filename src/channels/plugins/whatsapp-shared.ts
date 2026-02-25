import type { OpenClawConfig } from "../../config/config.js";
import { escapeRegExp } from "../../utils.js";
import { resolveWhatsAppAccount } from "../../web/accounts.js";

export const WHATSAPP_GROUP_INTRO_HINT =
  "WhatsApp IDs: SenderId is the participant JID (group participant id).";

export type WhatsAppGroupSystemPromptParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
};

/**
 * Resolves and combines WhatsApp system prompts following the hierarchy:
 * account-level systemPrompt + group-level systemPrompt (concatenated with "\n\n")
 *
 * This follows the same pattern as Telegram's resolveTelegramGroupPromptSettings.
 */
export function resolveWhatsAppGroupSystemPrompt(
  params: WhatsAppGroupSystemPromptParams,
): string | undefined {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });

  // Get account-level (global) systemPrompt
  const accountSystemPrompt = account.systemPrompt?.trim() || undefined;

  // Get group-level systemPrompt if groupId is provided.
  // Resolve per-field: use the specific group's systemPrompt if set, otherwise
  // fall back to the wildcard "*" entry so default prompts still apply even when
  // the specific group entry only defines non-prompt settings (e.g. requireMention).
  let groupSystemPrompt: string | undefined;
  if (params.groupId) {
    groupSystemPrompt =
      account.groups?.[params.groupId]?.systemPrompt?.trim() ||
      account.groups?.["*"]?.systemPrompt?.trim() ||
      undefined;
  }

  // Combine prompts following Telegram's pattern
  const systemPrompts = [accountSystemPrompt, groupSystemPrompt].filter(Boolean);
  return systemPrompts.length > 0 ? systemPrompts.join("\n\n") : undefined;
}

export function resolveWhatsAppGroupIntroHint(): string {
  return WHATSAPP_GROUP_INTRO_HINT;
}

export function resolveWhatsAppMentionStripPatterns(ctx: { To?: string | null }): string[] {
  const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
  if (!selfE164) {
    return [];
  }
  const escaped = escapeRegExp(selfE164);
  return [escaped, `@${escaped}`];
}
