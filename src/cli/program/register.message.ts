// Message command registration: core send/read/manage actions plus channel-specific admin helpers.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { CHANNEL_TARGETS_DESCRIPTION } from "../../infra/outbound/channel-target.js";
import { formatHelpExamples } from "../help-format.js";
import type { ProgramContext } from "./context.js";
import { collectOption } from "./helpers.js";
import { createMessageCliHelpers } from "./message/helpers.js";
import { registerMessageDiscordAdminCommands } from "./message/register.discord-admin.js";
import {
  registerMessagePermissionsCommand,
  registerMessageSearchCommand,
} from "./message/register.permissions-search.js";
import { registerMessageReadEditDeleteCommands } from "./message/register.read-edit-delete.js";
import { registerMessageSendCommand } from "./message/register.send.js";
import { registerMessageThreadCommands } from "./message/register.thread.js";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";

/** Register the `message` command group with shared channel option helpers. */
export function registerMessageCommands(program: Command, ctx: ProgramContext) {
  const message = program
    .command("message")
    .description("Send, read, and manage messages and channel actions")
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
    );

  const helpers = createMessageCliHelpers(ctx.messageChannelOptions);
  registerMessageSendCommand(message, helpers);
  helpers
    .withMessageBase(
      message.command("broadcast").description("Broadcast a message to multiple targets"),
    )
    .requiredOption("--targets <target...>", CHANNEL_TARGETS_DESCRIPTION)
    .option("--message <text>", "Message to send")
    .option("--media <url>", "Media URL")
    .action((options: Record<string, unknown>) => helpers.runMessageAction("broadcast", options));
  helpers
    .withMessageBase(message.command("poll").description("Send a poll"), "required")
    .requiredOption("--poll-question <text>", "Poll question")
    .option("--poll-option <choice>", "Poll option (repeat 2-12 times)", collectOption, [])
    .option("--poll-multi", "Allow multiple selections", false)
    .option("--poll-duration-hours <n>", "Poll duration in hours (Discord)")
    .option("--poll-duration-seconds <n>", "Poll duration in seconds (Telegram; 5-604800)")
    .option("--poll-anonymous", "Send an anonymous poll (Telegram)", false)
    .option("--poll-public", "Send a non-anonymous poll (Telegram)", false)
    .option("-m, --message <text>", "Optional message body")
    .option(
      "--silent",
      "Send poll silently without notification (Telegram + Discord where supported)",
      false,
    )
    .option("--thread-id <id>", "Thread id (Telegram forum topic / Slack thread ts)")
    .action((opts) => helpers.runMessageAction("poll", opts));
  helpers
    .withMessageBase(message.command("react").description("Add or remove a reaction"), "required")
    .requiredOption("--message-id <id>", "Message id")
    .option("--emoji <emoji>", "Emoji for reactions")
    .option("--remove", "Remove reaction", false)
    .option("--participant <id>", "WhatsApp reaction participant")
    .option("--from-me", "WhatsApp reaction fromMe", false)
    .option("--target-author <id>", "Signal reaction target author (uuid or phone)")
    .option("--target-author-uuid <uuid>", "Signal reaction target author uuid")
    .action((opts) => helpers.runMessageAction("react", opts));

  helpers
    .withMessageBase(
      message.command("reactions").description("List reactions on a message"),
      "required",
    )
    .requiredOption("--message-id <id>", "Message id")
    .option("--limit <n>", "Result limit")
    .action((opts) => helpers.runMessageAction("reactions", opts));
  registerMessageReadEditDeleteCommands(message, helpers);
  helpers
    .withMessageBase(message.command("pin").description("Pin a message"), "required")
    .requiredOption("--message-id <id>", "Message id")
    .action((opts) => helpers.runMessageAction("pin", opts));

  helpers
    .withMessageBase(message.command("unpin").description("Unpin a message"), "required")
    .requiredOption("--message-id <id>", "Message id (or pinned message resource id for MSTeams)")
    .option(
      "--pinned-message-id <id>",
      "Pinned message resource id (MSTeams: from pin or list-pins, not the chat message id)",
    )
    .action((opts) => helpers.runMessageAction("unpin", opts));

  helpers
    .withMessageBase(message.command("pins").description("List pinned messages"), "required")
    .option("--limit <n>", "Result limit")
    .action((opts) => helpers.runMessageAction("list-pins", opts));
  registerMessagePermissionsCommand(message, helpers);
  registerMessageSearchCommand(message, helpers);
  registerMessageThreadCommands(message, helpers);
  const emoji = message.command("emoji").description("Emoji actions");

  helpers
    .withMessageBase(emoji.command("list").description("List emojis"))
    .option("--guild-id <id>", "Guild id (Discord)")
    .action((opts) => helpers.runMessageAction("emoji-list", opts));

  helpers
    .withMessageBase(
      emoji
        .command("upload")
        .description("Upload an emoji")
        .requiredOption("--guild-id <id>", "Guild id"),
    )
    .requiredOption("--emoji-name <name>", "Emoji name")
    .requiredOption("--media <path-or-url>", "Emoji media (path or URL)")
    .option("--role-ids <id>", "Role id (repeat)", collectOption, [])
    .action((opts) => helpers.runMessageAction("emoji-upload", opts));
  const sticker = message.command("sticker").description("Sticker actions");

  helpers
    .withMessageBase(sticker.command("send").description("Send stickers"), "required")
    .requiredOption("--sticker-id <id>", "Sticker id (repeat)", collectOption)
    .option("-m, --message <text>", "Optional message body")
    .action((opts) => helpers.runMessageAction("sticker", opts));

  helpers
    .withMessageBase(
      sticker
        .command("upload")
        .description("Upload a sticker")
        .requiredOption("--guild-id <id>", "Guild id"),
    )
    .requiredOption("--sticker-name <name>", "Sticker name")
    .requiredOption("--sticker-desc <text>", "Sticker description")
    .requiredOption("--sticker-tags <tags>", "Sticker tags")
    .requiredOption("--media <path-or-url>", "Sticker media (path or URL)")
    .action((opts) => helpers.runMessageAction("sticker-upload", opts));
  registerMessageDiscordAdminCommands(message, helpers);

  for (const command of message.commands) {
    if (command.commands.length > 0) {
      applyParentDefaultHelpAction(command);
    }
  }
  applyParentDefaultHelpAction(message);
}
