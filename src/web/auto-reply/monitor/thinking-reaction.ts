/**
 * Thinking Reaction — visible progress indicator for WhatsApp groups.
 *
 * WhatsApp linked devices (Baileys) cannot show typing indicators in groups
 * (see https://github.com/WhiskeySockets/Baileys/issues/866).
 * This module provides a workaround: react with 🤔 when processing starts,
 * and remove the reaction when the reply is delivered.
 *
 * FORK-ISOLATED: This file is unique to our fork. Upstream will never touch it,
 * so merges are conflict-free. The integration points in process-message.ts are
 * minimal (two function calls).
 */

import { sendReactionWhatsApp } from "../../outbound.js";

const THINKING_EMOJI = "🤔";

export type ThinkingReactionContext = {
  messageId?: string;
  chatId?: string;
  senderJid?: string;
  accountId?: string;
};

export type ThinkingReactionController = {
  /** Send the 🤔 reaction. Safe to call multiple times (idempotent). */
  start: () => void;
  /** Remove the 🤔 reaction. Safe to call multiple times (idempotent). */
  stop: () => void;
};

/**
 * Create a thinking reaction controller for a single inbound message.
 * Call `start()` when processing begins and `stop()` when the reply is delivered.
 */
export function createThinkingReaction(ctx: ThinkingReactionContext): ThinkingReactionController {
  let sent = false;

  const start = () => {
    if (sent || !ctx.messageId || !ctx.chatId) {
      return;
    }
    sent = true;
    sendReactionWhatsApp(ctx.chatId, ctx.messageId, THINKING_EMOJI, {
      verbose: false,
      fromMe: false,
      participant: ctx.senderJid,
      accountId: ctx.accountId,
    }).catch(() => {});
  };

  const stop = () => {
    if (!sent || !ctx.messageId || !ctx.chatId) {
      return;
    }
    sent = false;
    sendReactionWhatsApp(ctx.chatId, ctx.messageId, "", {
      verbose: false,
      fromMe: false,
      participant: ctx.senderJid,
      accountId: ctx.accountId,
    }).catch(() => {});
  };

  return { start, stop };
}
