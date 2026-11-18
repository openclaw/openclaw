import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

export const handleWhoamiCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/whoami",
    match: (body) => (body === "/whoami" ? true : null),
    silentUnauthorized: true,
  },
  (params) => {
    const senderId = params.ctx.SenderId ?? "";
    const senderUsername = params.ctx.SenderUsername ?? "";
    const allowFromSender = params.command.senderId ?? "";
    const lines = [
      "🧭 Identity",
      `Channel: ${params.command.channel}`,
      senderId ? `User id: ${senderId}` : undefined,
      senderUsername
        ? `Username: ${senderUsername.startsWith("@") ? senderUsername : `@${senderUsername}`}`
        : undefined,
      params.ctx.ChatType === "group" && params.ctx.From ? `Chat: ${params.ctx.From}` : undefined,
      params.ctx.MessageThreadId != null ? `Thread: ${params.ctx.MessageThreadId}` : undefined,
      allowFromSender ? `AllowFrom: ${allowFromSender}` : undefined,
    ];
    return commandReply(lines.filter(Boolean).join("\n"));
  },
);
