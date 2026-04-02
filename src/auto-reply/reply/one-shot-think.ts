import type { OpenClawConfig } from "../../config/config.js";
import { isOneShotThinkMessage } from "../command-detection.js";
import type { MsgContext } from "../templating.js";
import type { ThinkLevel } from "../thinking.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

/** Strips residual mention punctuation (e.g. `, ` from `@bot, /think high ...`) before `/`. */
function stripLeadingMentionPunctuationBeforeCommand(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return trimmed.replace(/^[,.;:!?，。！？、:：]+\s*(?=\/)/u, "");
}

/** Shared context for one-shot think evaluation, pre-computed once at the call site. */
export interface OneShotThinkContext {
  commandText: string;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
  hasThinkDirective: boolean;
  thinkLevel?: ThinkLevel;
}

/**
 * Pre-compute mention-stripped text for one-shot think checks.
 * Called once at the call site; result passed to resolveOneShotThinkLevel.
 */
export function prepareOneShotThinkText(params: OneShotThinkContext): string {
  const stripped = stripStructuralPrefixes(params.commandText);
  const noMentions = params.isGroup
    ? stripMentions(stripped, params.ctx, params.cfg, params.agentId)
    : stripped;
  // When a mention was actually removed, clean up residual punctuation before the command.
  return noMentions !== stripped
    ? stripLeadingMentionPunctuationBeforeCommand(noMentions)
    : noMentions;
}

/**
 * If the message is a one-shot think (`/think <level> <body>`), return the think level
 * so it applies only to this message without persisting to session state.
 */
export function resolveOneShotThinkLevel(
  params: OneShotThinkContext,
  preparedText: string,
): ThinkLevel | undefined {
  if (!params.hasThinkDirective || params.thinkLevel === undefined) {
    return undefined;
  }
  return isOneShotThinkMessage(preparedText, params.cfg, {
    botUsername: params.ctx.BotUsername,
  })
    ? params.thinkLevel
    : undefined;
}
