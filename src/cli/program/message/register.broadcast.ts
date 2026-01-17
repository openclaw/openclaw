import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessageBroadcastCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      message.command("broadcast").description("Broadcast a message to multiple targets"),
    )
    .requiredOption(
      "--targets <target...>",
      "Targets to broadcast to (repeatable, accepts names or ids)",
    )
    .option("--message <text>", "Message to send")
    .option("--media <url>", "Media URL")
    .action(async (options: Record<string, unknown>) => {
      await helpers.runMessageAction("broadcast", options);
    });
}
