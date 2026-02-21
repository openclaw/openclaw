import type { Command } from "commander";
import { t } from "../../shared/i18n.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { formatHelpExamples } from "../help-format.js";
import type { ProgramContext } from "./context.js";
import { createMessageCliHelpers } from "./message/helpers.js";
import { registerMessageBroadcastCommand } from "./message/register.broadcast.js";
import { registerMessageDiscordAdminCommands } from "./message/register.discord-admin.js";
import {
  registerMessageEmojiCommands,
  registerMessageStickerCommands,
} from "./message/register.emoji-sticker.js";
import {
  registerMessagePermissionsCommand,
  registerMessageSearchCommand,
} from "./message/register.permissions-search.js";
import { registerMessagePinCommands } from "./message/register.pins.js";
import { registerMessagePollCommand } from "./message/register.poll.js";
import { registerMessageReactionsCommands } from "./message/register.reactions.js";
import { registerMessageReadEditDeleteCommands } from "./message/register.read-edit-delete.js";
import { registerMessageSendCommand } from "./message/register.send.js";
import { registerMessageThreadCommands } from "./message/register.thread.js";

export function registerMessageCommands(program: Command, ctx: ProgramContext) {
  const message = program
    .command("message")
    .description(t("cli.message.description"))
    .addHelpText(
      "after",
      () =>
        `
${theme.heading(t("cli.common.examples"))}
${formatHelpExamples([
  ['openclaw message send --target +15555550123 --message "Hi"', t("cli.message.example_send")],
  [
    'openclaw message send --target +15555550123 --message "Hi" --media photo.jpg',
    t("cli.message.example_media"),
  ],
  [
    'openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi',
    t("cli.message.example_poll"),
  ],
  [
    'openclaw message react --channel discord --target 123 --message-id 456 --emoji "✅"',
    t("cli.message.example_react"),
  ],
])}

${theme.muted(t("cli.common.docs"))} ${formatDocsLink("/cli/message", "docs.openclaw.ai/cli/message")}`,
    )
    .action(() => {
      message.help({ error: true });
    });

  const helpers = createMessageCliHelpers(message, ctx.messageChannelOptions);
  registerMessageSendCommand(message, helpers);
  registerMessageBroadcastCommand(message, helpers);
  registerMessagePollCommand(message, helpers);
  registerMessageReactionsCommands(message, helpers);
  registerMessageReadEditDeleteCommands(message, helpers);
  registerMessagePinCommands(message, helpers);
  registerMessagePermissionsCommand(message, helpers);
  registerMessageSearchCommand(message, helpers);
  registerMessageThreadCommands(message, helpers);
  registerMessageEmojiCommands(message, helpers);
  registerMessageStickerCommands(message, helpers);
  registerMessageDiscordAdminCommands(message, helpers);
}
