import { handleProviderSetupCommand } from "../../provider-setup/runtime.js";
import type { CommandHandler } from "./commands-types.js";

export const handleProvidersCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands && !params.command.commandBodyNormalized.startsWith("/providers c ")) {
    return null;
  }
  if (
    params.command.commandBodyNormalized !== "/providers" &&
    !params.command.commandBodyNormalized.startsWith("/providers ")
  ) {
    return null;
  }
  const reply = await handleProviderSetupCommand({
    cfg: params.cfg,
    commandBody: params.command.commandBodyNormalized,
    channel: params.command.channel,
    ...(params.ctx.AccountId ? { accountId: params.ctx.AccountId } : {}),
    ...((params.ctx.OriginatingTo ?? params.command.to ?? params.command.from)
      ? { conversationId: params.ctx.OriginatingTo ?? params.command.to ?? params.command.from }
      : {}),
    ...(params.command.senderId ? { senderId: params.command.senderId } : {}),
    senderIsOwner: params.command.senderIsOwner,
    isAuthorizedSender: params.command.isAuthorizedSender,
    isGroup: params.isGroup,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    workspaceDir: params.workspaceDir,
  });
  return reply ? { reply, shouldContinue: false } : null;
};
