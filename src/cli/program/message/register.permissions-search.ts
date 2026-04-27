import type { Command } from "commander";
import { collectOption } from "../helpers.js";
import type { MessageCliHelpers } from "./helpers.js";

function searchChannel(opts: Record<string, unknown>): string | undefined {
  return typeof opts.channel === "string" ? opts.channel.trim().toLowerCase() : undefined;
}

function isDiscordSearch(opts: Record<string, unknown>): boolean {
  return searchChannel(opts) === "discord";
}

function isSlackSearch(opts: Record<string, unknown>): boolean {
  return searchChannel(opts) === "slack";
}

function hasNonEmptyOption(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === "string" && entry.trim().length > 0);
  }
  return typeof value === "string" && value.trim().length > 0;
}

function rejectUnsupportedSlackSearchFilters(opts: Record<string, unknown>) {
  const unsupported: string[] = [];
  if (hasNonEmptyOption(opts.channelIds)) {
    unsupported.push("--channel-ids");
  }
  if (hasNonEmptyOption(opts.authorId)) {
    unsupported.push("--author-id");
  }
  if (hasNonEmptyOption(opts.authorIds)) {
    unsupported.push("--author-ids");
  }
  if (unsupported.length > 0) {
    throw new Error(
      `Slack message search does not support ${unsupported.join(", ")}. Use --channel-id or --channel-name for Slack channel scoping.`,
    );
  }
}

export function registerMessagePermissionsCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(
        message.command("permissions").description("Fetch channel permissions"),
      ),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("permissions", opts);
    });
}

export function registerMessageSearchCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(message.command("search").description("Search messages"))
    .option("--guild-id <id>", "Guild id (required for Discord)")
    .requiredOption("--query <text>", "Search query")
    .option("--channel-id <id>", "Channel id")
    .option("--channel-name <name>", "Slack channel name for search scoping")
    .option("--channel-ids <id>", "Channel id (repeat)", collectOption, [] as string[])
    .option("--author-id <id>", "Author id")
    .option("--author-ids <id>", "Author id (repeat)", collectOption, [] as string[])
    .option("--limit <n>", "Result limit")
    .option("--sort <type>", "Sort by (score, timestamp)")
    .option("--sort-dir <dir>", "Sort direction (asc, desc)")
    .action(async (opts) => {
      if (isDiscordSearch(opts) && (typeof opts.guildId !== "string" || !opts.guildId.trim())) {
        throw new Error("--guild-id <id> is required for Discord message search.");
      }
      if (isSlackSearch(opts)) {
        rejectUnsupportedSlackSearchFilters(opts);
      }
      await helpers.runMessageAction("search", opts);
    });
}
