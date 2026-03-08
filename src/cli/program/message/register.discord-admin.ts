import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessageDiscordAdminCommands(message: Command, helpers: MessageCliHelpers) {
  const role = message.command("role").description("Role actions");
  helpers
    .withMessageBase(
      role.command("info").description("List roles").requiredOption("--guild-id <id>", "Guild id"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("role-info", opts);
    });

  helpers
    .withMessageBase(
      role
        .command("add")
        .description("Add role to a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id")
        .requiredOption("--role-id <id>", "Role id"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("role-add", opts);
    });

  helpers
    .withMessageBase(
      role
        .command("remove")
        .description("Remove role from a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id")
        .requiredOption("--role-id <id>", "Role id"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("role-remove", opts);
    });

  const channel = message.command("channel").description("Channel actions");
  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(channel.command("info").description("Fetch channel info")),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("channel-info", opts);
    });

  helpers
    .withMessageBase(
      channel
        .command("list")
        .description("List channels")
        .requiredOption("--guild-id <id>", "Guild id"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("channel-list", opts);
    });

  helpers
    .withMessageBase(
      channel
        .command("create")
        .description("Create a channel")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--name <name>", "Channel name"),
    )
    .option("--type <n>", "Channel type (0=text, 2=voice, 4=category, 15=forum)")
    .option("--parent-id <id>", "Parent category id")
    .option("--topic <text>", "Channel topic")
    .option("--position <n>", "Sort position")
    .option("--nsfw", "Mark as NSFW")
    .action(async (opts) => {
      await helpers.runMessageAction("channel-create", opts);
    });

  helpers
    .withMessageBase(
      channel
        .command("edit")
        .description("Edit a channel")
        .requiredOption("--channel-id <id>", "Channel id"),
    )
    .option("--name <name>", "New channel name")
    .option("--topic <text>", "New channel topic")
    .option("--position <n>", "Sort position")
    .option("--parent-id <id>", "Parent category id")
    .option("--nsfw", "Mark as NSFW")
    .action(async (opts) => {
      await helpers.runMessageAction("channel-edit", opts);
    });

  helpers
    .withMessageBase(
      channel
        .command("delete")
        .description("Delete a channel")
        .requiredOption("--channel-id <id>", "Channel id"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("channel-delete", opts);
    });

  helpers
    .withMessageBase(
      channel
        .command("move")
        .description("Move a channel")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--channel-id <id>", "Channel id"),
    )
    .option("--parent-id <id>", "Target parent category id")
    .option("--position <n>", "Sort position")
    .action(async (opts) => {
      await helpers.runMessageAction("channel-move", opts);
    });

  const member = message.command("member").description("Member actions");
  helpers
    .withMessageBase(
      member
        .command("info")
        .description("Fetch member info")
        .requiredOption("--user-id <id>", "User id"),
    )
    .option("--guild-id <id>", "Guild id (Discord)")
    .action(async (opts) => {
      await helpers.runMessageAction("member-info", opts);
    });

  const voice = message.command("voice").description("Voice actions");
  helpers
    .withMessageBase(
      voice
        .command("status")
        .description("Fetch voice status")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("voice-status", opts);
    });

  const event = message.command("event").description("Event actions");
  helpers
    .withMessageBase(
      event
        .command("list")
        .description("List scheduled events")
        .requiredOption("--guild-id <id>", "Guild id"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("event-list", opts);
    });

  helpers
    .withMessageBase(
      event
        .command("create")
        .description("Create a scheduled event")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--event-name <name>", "Event name")
        .requiredOption("--start-time <iso>", "Event start time"),
    )
    .option("--end-time <iso>", "Event end time")
    .option("--desc <text>", "Event description")
    .option("--channel-id <id>", "Channel id")
    .option("--location <text>", "Event location")
    .option("--event-type <stage|external|voice>", "Event type")
    .action(async (opts) => {
      await helpers.runMessageAction("event-create", opts);
    });

  helpers
    .withMessageBase(
      message
        .command("timeout")
        .description("Timeout a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id"),
    )
    .option("--duration-min <n>", "Timeout duration minutes")
    .option("--until <iso>", "Timeout until")
    .option("--reason <text>", "Moderation reason")
    .action(async (opts) => {
      await helpers.runMessageAction("timeout", opts);
    });

  helpers
    .withMessageBase(
      message
        .command("kick")
        .description("Kick a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id"),
    )
    .option("--reason <text>", "Moderation reason")
    .action(async (opts) => {
      await helpers.runMessageAction("kick", opts);
    });

  helpers
    .withMessageBase(
      message
        .command("ban")
        .description("Ban a member")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--user-id <id>", "User id"),
    )
    .option("--reason <text>", "Moderation reason")
    .option("--delete-days <n>", "Ban delete message days")
    .action(async (opts) => {
      await helpers.runMessageAction("ban", opts);
    });
}
