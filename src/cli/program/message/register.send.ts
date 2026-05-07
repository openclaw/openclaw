import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessageSendCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      helpers
        .withRequiredMessageTarget(
          message
            .command("send")
            .description("Send a message")
            .option(
              "-m, --message <text>",
              "Message body (required unless --media or --latitude/--longitude is set)",
            ),
        )
        .option(
          "--media <path-or-url>",
          "Attach media (image/audio/video/document). Accepts local paths or URLs.",
        )
        .option(
          "--presentation <json>",
          "Shared presentation payload as JSON (text, context, dividers, buttons, selects)",
        )
        .option("--delivery <json>", "Shared delivery preferences as JSON")
        .option("--pin", "Request that the delivered message be pinned when supported", false)
        .option("--reply-to <id>", "Reply-to message id")
        .option("--thread-id <id>", "Thread id (Telegram forum thread)")
        .option("--gif-playback", "Treat video media as GIF playback (WhatsApp only).", false)
        .option("--latitude <number>", "Latitude for a native WhatsApp location pin (-90 to 90).")
        .option(
          "--longitude <number>",
          "Longitude for a native WhatsApp location pin (-180 to 180).",
        )
        .option("--location-name <text>", "Name shown on the native location pin.")
        .option("--location-address <text>", "Address shown under the native location pin.")
        .option(
          "--accuracy-in-meters <number>",
          "Optional accuracy radius in meters for supported location pins.",
        )
        .option(
          "--force-document",
          "Send media as document to avoid Telegram compression (Telegram only). Applies to images and GIFs.",
          false,
        )
        .option(
          "--silent",
          "Send message silently without notification (Telegram + Discord)",
          false,
        ),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("send", opts);
    });
}
