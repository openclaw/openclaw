import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessageStatusCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      message
        .command("status")
        .description("Check delivery status of an outbound message (WhatsApp)")
        .requiredOption("--message-id <id>", "Message id to check"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("message-status", opts);
    });
}
