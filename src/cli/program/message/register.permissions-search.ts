import type { Command } from "commander";
import { collectOption } from "../helpers.js";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessagePermissionsCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      message.command("permissions").description("Fetch channel permissions"),
      "required",
    )
    .action((opts) => helpers.runMessageAction("permissions", opts));
}

export function registerMessageSearchCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(message.command("search").description("Search messages"))
    .requiredOption("--query <text>", "Search query")
    .option("--guild-id <id>", "Guild id (Discord)")
    .option(
      "--channel-id <id>",
      "Channel id (Discord) or Graph team-id/channel-id (Microsoft Teams)",
    )
    .option("--channel-ids <id>", "Channel id (repeat)", collectOption, [] as string[])
    .option("--author-id <id>", "Author id")
    .option("--author-ids <id>", "Author id (repeat)", collectOption, [] as string[])
    .option("--limit <n>", "Result limit")
    .action((opts) => helpers.runMessageAction("search", opts));
}
