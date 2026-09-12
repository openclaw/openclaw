// Discord-style admin command registration for roles, channels, members, events, and moderation.
import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

const requiredOptions = {
  guild: ["--guild-id <id>", "Guild id"],
  user: ["--user-id <id>", "User id"],
  role: ["--role-id <id>", "Role id"],
  eventName: ["--event-name <name>", "Event name"],
  startTime: ["--start-time <iso>", "Event start time"],
} as const;

/** Register Discord admin and moderation message subcommands. */
export function registerMessageDiscordAdminCommands(message: Command, helpers: MessageCliHelpers) {
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
    .withMessageBase(
      helpers.withRequiredMessageTarget(channel.command("info").description("Fetch channel info")),
    )
    .action((opts) => helpers.runMessageAction("channel-info", opts));
  register(channel, "list", "List channels", "channel-list", ["guild"]);

  const member = message.command("member").description("Member actions");
  register(member, "info", "Fetch member info", "member-info", ["user"]).option(
    "--guild-id <id>",
    "Guild id (Discord)",
  );

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
}
