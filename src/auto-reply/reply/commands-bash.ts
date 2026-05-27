import { handleBashChatCommand } from "./bash-command.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleBashCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const { command } = params;
  const bashSlashRequested =
    command.commandBodyNormalized === "/bash" || command.commandBodyNormalized.startsWith("/bash ");
  const bashBangRequested = command.commandBodyNormalized.startsWith("!");
  if (!bashSlashRequested && !(bashBangRequested && command.isAuthorizedSender)) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/bash");
  if (unauthorized) {
    return unauthorized;
  }
  const reply = await handleBashChatCommand({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    isGroup: params.isGroup,
    elevated: params.elevated,
  });
  return { shouldContinue: false, reply };
};
