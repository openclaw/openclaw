import { createCommandTurnContext, resolveCommandTurnContext } from "../command-turn-context.js";
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleFollowupCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/followup",
    match: (body) => {
      const match = body.trim().match(/^\/followup(?:\s+([\s\S]*))?$/i);
      return match ? (match[1] ?? "").trim() : null;
    },
  },
  (params, message) => {
    if (!message) {
      return commandReply("Usage: /followup <message>");
    }
    const source = resolveCommandTurnContext(params.ctx).kind === "native" ? "native" : "text";
    const commandTurn = createCommandTurnContext(source, {
      authorized: true,
      commandName: "followup",
      body: params.command.commandBodyNormalized,
    });
    // The authenticated command intent survives rewriting the model/transcript payload.
    params.ctx.CommandTurn = commandTurn;
    if (params.rootCtx) {
      params.rootCtx.CommandTurn = commandTurn;
    }
    applyCommandTextToParams(params, message);
    return { shouldContinue: true, queueModeOverride: "followup" };
  },
);
