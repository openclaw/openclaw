import type { Command } from "commander";
import type { ProgramContext } from "./context.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { formatHelpExamples } from "../help-format.js";

export async function registerMessageCommands(program: Command, ctx: ProgramContext) {
  const message = program
    .command("message")
    .description("Send messages and channel actions")
    .addHelpText(
      "after",
      () =>
        `
${theme.heading("Examples:")}
${formatHelpExamples([
  ['openclaw message send --target +15555550123 --message "Hi"', "Send a text message."],
  [
    'openclaw message send --target +15555550123 --message "Hi" --media photo.jpg',
    "Send a message with media.",
  ],
  [
    'openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi',
    "Create a Discord poll.",
  ],
  [
    'openclaw message react --channel discord --target 123 --message-id 456 --emoji "✅"',
    "React to a message.",
  ],
])}

${theme.muted("Docs:")} ${formatDocsLink("/cli/message", "docs.openclaw.ai/cli/message")}`,
    )
    .action(() => {
      message.help({ error: true });
    });

  const { createMessageCliHelpers } = await import("./message/helpers.js");
  const helpers = createMessageCliHelpers(message, ctx.messageChannelOptions);

  // Load all message sub-command registrations in parallel
  const [
    { registerMessageSendCommand },
    { registerMessageBroadcastCommand },
    { registerMessagePollCommand },
    { registerMessageReactionsCommands },
    { registerMessageReadEditDeleteCommands },
    { registerMessagePinCommands },
    { registerMessagePermissionsCommand, registerMessageSearchCommand },
    { registerMessageThreadCommands },
    { registerMessageEmojiCommands, registerMessageStickerCommands },
    { registerMessageDiscordAdminCommands },
  ] = await Promise.all([
    import("./message/register.send.js"),
    import("./message/register.broadcast.js"),
    import("./message/register.poll.js"),
    import("./message/register.reactions.js"),
    import("./message/register.read-edit-delete.js"),
    import("./message/register.pins.js"),
    import("./message/register.permissions-search.js"),
    import("./message/register.thread.js"),
    import("./message/register.emoji-sticker.js"),
    import("./message/register.discord-admin.js"),
  ]);

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
