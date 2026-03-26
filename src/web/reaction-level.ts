import type { OpenClawConfig } from "../config/config.js";
import {
  resolveReactionLevel,
  type ReactionLevel,
  type ResolvedReactionLevel,
} from "../utils/reaction-level.js";

export type WhatsAppReactionLevel = ReactionLevel;
export type ResolvedWhatsAppReactionLevel = ResolvedReactionLevel;

/**
 * Resolve the effective reaction level and its implications for WhatsApp.
 *
 * Checks account-level config first, then falls back to channel-level.
 *
 * Levels:
 * - "off": No reactions at all
 * - "ack": Only automatic ack reactions, no agent reactions
 * - "minimal": Agent can react, but sparingly (default)
 * - "extensive": Agent can react liberally
 */
export function resolveWhatsAppReactionLevel(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedWhatsAppReactionLevel {
  const wa = params.cfg.channels?.whatsapp as
    | (Record<string, unknown> & {
        reactionLevel?: ReactionLevel;
        accounts?: Record<string, { reactionLevel?: ReactionLevel }>;
      })
    | undefined;
  // Account-level override takes priority over channel-level
  const accountLevel = params.accountId
    ? wa?.accounts?.[params.accountId]?.reactionLevel
    : undefined;
  const channelLevel = wa?.reactionLevel;
  return resolveReactionLevel({
    value: accountLevel ?? channelLevel,
    defaultLevel: "minimal",
    invalidFallback: "minimal",
  });
}
