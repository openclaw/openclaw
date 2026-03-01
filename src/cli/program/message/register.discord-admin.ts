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
        .requiredOption("--name <text>", "Channel name"),
    )
    .option("--type <n>", "Channel type (0: text, 2: voice, 5: announcement, 13: stage, 15: forum)")
    .option("--parentId <id>", "Category/parent id")
    .option("--topic <text>", "Channel topic")
    .option("--position <n>", "Channel position")
    .option("--nsfw", "Mark as NSFW")
    .option(
      "--default-auto-archive-duration <n>",
      "Default auto-archive duration (60, 1440, 4320, 10080)",
    )
    .action(async (opts) => {
      await helpers.runMessageAction("channel-create", opts);
    });

  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(channel.command("edit").description("Edit a channel")),
    )
    .option("--name <text>", "Channel name")
    .option("--topic <text>", "Channel topic")
    .option("--position <n>", "Channel position")
    .option("--parentId <id>", "Category/parent id")
    .option("--clearParent", "Clear parent/category")
    .option("--nsfw", "Mark as NSFW")
    .option("--no-nsfw", "Unmark as NSFW")
    .option("--rateLimitPerUser <n>", "Slowmode in seconds")
    .option("--archived", "Archive thread")
    .option("--no-archived", "Unarchive thread")
    .option("--locked", "Lock thread")
    .option("--no-locked", "Unlock thread")
    .option("--auto-archive-duration <n>", "Auto-archive duration (60, 1440, 4320, 10080)")
    .option(
      "--default-auto-archive-duration <n>",
      "Default auto-archive duration (60, 1440, 4320, 10080)",
    )
    .action(async (opts) => {
      await helpers.runMessageAction("channel-edit", opts);
    });

  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(channel.command("delete").description("Delete a channel")),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("channel-delete", opts);
    });

  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(
        channel
          .command("move")
          .description("Move a channel")
          .requiredOption("--guild-id <id>", "Guild id"),
      ),
    )
    .option("--parentId <id>", "Category/parent id")
    .option("--clearParent", "Clear parent/category")
    .option("--position <n>", "Channel position")
    .action(async (opts) => {
      await helpers.runMessageAction("channel-move", opts);
    });

  const category = message.command("category").description("Category actions");
  helpers
    .withMessageBase(
      category
        .command("create")
        .description("Create a category")
        .requiredOption("--guild-id <id>", "Guild id")
        .requiredOption("--name <text>", "Category name"),
    )
    .option("--position <n>", "Category position")
    .action(async (opts) => {
      await helpers.runMessageAction("category-create", opts);
    });

  helpers
    .withMessageBase(
      category
        .command("edit")
        .description("Edit a category")
        .requiredOption("--category-id <id>", "Category id"),
    )
    .option("--name <text>", "Category name")
    .option("--position <n>", "Category position")
    .action(async (opts) => {
      await helpers.runMessageAction("category-edit", opts);
    });

  helpers
    .withMessageBase(
      category
        .command("delete")
        .description("Delete a category")
        .requiredOption("--category-id <id>", "Category id"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("category-delete", opts);
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
