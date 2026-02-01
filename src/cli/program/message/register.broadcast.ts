import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";
import { CHANNEL_TARGETS_DESCRIPTION } from "../../../infra/outbound/channel-target.js";

export function registerMessageBroadcastCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      message.command("broadcast").description("Broadcast a message to multiple targets"),
    )
    .requiredOption("--targets <target...>", CHANNEL_TARGETS_DESCRIPTION)
    .option("--message <text>", "Message to send")
    .option("--media <url>", "Media URL")
    .action(async (options: Record<string, unknown>) => {
      await helpers.runMessageAction("broadcast", options);
    });
}
