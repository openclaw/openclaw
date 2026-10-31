import { isBangCommandInput } from "./bash-command-input.js";
import { handleBashChatCommand } from "./bash-command.js";
import { defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleBashCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/bash",
    match: (body, params) =>
      matchCommandPrefix(body, "/bash") !== null ||
      (isBangCommandInput(body) && params.command.isAuthorizedSender)
        ? true
        : null,
  },
  async (params) => {
    const reply = await handleBashChatCommand(params);
    return { shouldContinue: false, reply };
  },
);
