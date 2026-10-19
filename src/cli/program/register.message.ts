import { Option, type Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  CHANNEL_TARGET_DESCRIPTION,
  CHANNEL_TARGETS_DESCRIPTION,
} from "../../infra/outbound/channel-target.js";
import { formatHelpExamples } from "../help-format.js";
import type { ProgramContext } from "./context.js";
import { collectOption } from "./helpers.js";
import { createMessageCliHelpers } from "./message/helpers.js";
import { registerMessageThreadCommands } from "./message/register.thread.js";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";

const requiredOptions = {
  guild: ["--guild-id <id>", "Guild id"],
  user: ["--user-id <id>", "User id"],
  role: ["--role-id <id>", "Role id"],
  eventName: ["--event-name <name>", "Event name"],
  startTime: ["--start-time <iso>", "Event start time"],
} as const;

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
  helpers
    .withMessageBase(
      message
        .command("send")
        .description("Send a message")
        .option(
          "-m, --message <text>",
          "Message body (required unless --media or --presentation is set)",
        )
        .requiredOption("-t, --target <dest>", CHANNEL_TARGET_DESCRIPTION)
        .option(
          "--media <path-or-url>",
          "Attach media (image/audio/video/document). Accepts local paths or URLs. Repeat to attach multiple files.",
          collectOption,
        )
        .option(
          "--presentation <json>",
          "Shared presentation payload as JSON (text, context, dividers, charts, tables, buttons, selects)",
        )
        .option("--delivery <json>", "Shared delivery preferences as JSON")
        .option("--pin", "Request that the delivered message be pinned when supported", false)
        .option("--reply-to <id>", "Reply-to message id")
        .option("--thread-id <id>", "Thread id (Telegram forum thread)")
        .option("--gif-playback", "Treat video media as GIF playback (WhatsApp only).", false)
        .option(
          "--force-document",
          "Preserve original image bytes on Slack, or send images, GIFs, and videos as documents on Telegram and WhatsApp, to avoid channel compression.",
          false,
        )
        .option(
          "--silent",
          "Send message silently without notification (Telegram + Discord)",
          false,
        ),
    )
    .action(({ media, ...opts }) =>
      helpers.runMessageAction("send", { ...opts, mediaUrls: media }),
    );
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
  helpers
    .withMessageBase(message.command("read").description("Read recent messages"), "required")
    .option("--limit <n>", "Result limit")
    .option("--message-id <id>", "Read a specific message id")
    .option(
      "--before <id>",
      "Read/search before id (Matrix: nextBatch/prevBatch token from a previous read)",
    )
    .option(
      "--after <id>",
      "Read/search after id (Matrix: nextBatch/prevBatch token from a previous read)",
    )
    .option("--around <id>", "Read around id")
    .option("--thread-id <id>", "Thread id (Slack thread timestamp)")
    .addOption(new Option("--include-thread").hideHelp())
    .action((opts) => helpers.runMessageAction("read", opts));

  helpers
    .withMessageBase(
      message
        .command("edit")
        .description("Edit a message")
        .requiredOption("--message-id <id>", "Message id")
        .requiredOption("-m, --message <text>", "Message body"),
      "required",
    )
    .option("--thread-id <id>", "Thread id (Telegram forum thread)")
    .action((opts) => helpers.runMessageAction("edit", opts));

  helpers
    .withMessageBase(
      message
        .command("delete")
        .description("Delete a message")
        .requiredOption("--message-id <id>", "Message id"),
      "required",
    )
    .action((opts) => helpers.runMessageAction("delete", opts));
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
  helpers
    .withMessageBase(
      message.command("permissions").description("Fetch channel permissions"),
      "required",
    )
    .action((opts) => helpers.runMessageAction("permissions", opts));
  helpers
    .withMessageBase(message.command("search").description("Search messages"))
    .requiredOption("--query <text>", "Search query")
    .option("--guild-id <id>", "Guild id (Discord)")
    .option(
      "--channel-id <id>",
      "Channel id (Discord) or Graph team-id/channel-id (Microsoft Teams)",
    )
    .option("--channel-ids <id>", "Channel id (repeat)", collectOption, [])
    .option("--author-id <id>", "Author id")
    .option("--author-ids <id>", "Author id (repeat)", collectOption, [])
    .option("--limit <n>", "Result limit")
    .action((opts) => helpers.runMessageAction("search", opts));
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
  function register(
    parent: Command,
    name: string,
    description: string,
    action: string,
    required: readonly (keyof typeof requiredOptions)[],
  ) {
    const command = parent.command(name).description(description);
    // Required identifiers precede shared flags; leaf-specific options follow them.
    for (const key of required) {
      const [flags, optionDescription] = requiredOptions[key];
      command.requiredOption(flags, optionDescription);
    }
    return helpers
      .withMessageBase(command)
      .action((opts) => helpers.runMessageAction(action, opts));
  }

  const role = message.command("role").description("Role actions");
  register(role, "info", "List roles", "role-info", ["guild"]);
  register(role, "add", "Add role to a member", "role-add", ["guild", "user", "role"]);
  register(role, "remove", "Remove role from a member", "role-remove", ["guild", "user", "role"]);

  const channel = message.command("channel").description("Channel actions");
  helpers
    .withMessageBase(channel.command("info").description("Fetch channel info"), "required")
    .action((opts) => helpers.runMessageAction("channel-info", opts));
  register(channel, "list", "List channels", "channel-list", ["guild"]);

  const member = message.command("member").description("Member actions");
  register(member, "info", "Fetch member info", "member-info", ["user"])
    .option("--guild-id <id>", "Guild id (Discord)")
    .option("--channel-id <id>", "Room id (Matrix) or Graph team-id/channel-id (Microsoft Teams)");

  const voice = message.command("voice").description("Voice actions");
  register(voice, "status", "Fetch voice status", "voice-status", ["guild", "user"]);

  const event = message.command("event").description("Event actions");
  register(event, "list", "List scheduled events", "event-list", ["guild"]);
  register(event, "create", "Create a scheduled event", "event-create", [
    "guild",
    "eventName",
    "startTime",
  ])
    .option("--end-time <iso>", "Event end time")
    .option("--desc <text>", "Event description")
    .option("--channel-id <id>", "Channel id")
    .option("--location <text>", "Event location")
    .option("--event-type <stage|external|voice>", "Event type")
    .option("--image <url>", "Cover image URL or local file path");

  register(message, "timeout", "Timeout a member", "timeout", ["guild", "user"])
    .option("--duration-min <n>", "Timeout duration minutes")
    .option("--until <iso>", "Timeout until")
    .option("--reason <text>", "Moderation reason");

  register(message, "kick", "Kick a member", "kick", ["guild", "user"]).option(
    "--reason <text>",
    "Moderation reason",
  );

  register(message, "ban", "Ban a member", "ban", ["guild", "user"])
    .option("--reason <text>", "Moderation reason")
    .option("--delete-days <n>", "Ban delete message days");

  for (const command of message.commands) {
    if (command.commands.length > 0) {
      applyParentDefaultHelpAction(command);
    }
  }
  applyParentDefaultHelpAction(message);
}
