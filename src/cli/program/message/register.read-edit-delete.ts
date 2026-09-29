// Read, edit, and delete message command registration.
import { Option, type Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

/** Register message read, edit, and delete commands. */
export function registerMessageReadEditDeleteCommands(
  message: Command,
  helpers: MessageCliHelpers,
) {
  helpers
    .withMessageBase(message.command("read").description("Read recent messages"), "required")
    .option("--limit <n>", "Result limit")
    .option("--message-id <id>", "Read a specific message id")
    .option("--before <id>", "Read/search before id")
    .option("--after <id>", "Read/search after id")
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
}
