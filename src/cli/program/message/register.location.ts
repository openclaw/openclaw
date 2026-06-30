// Location, venue, and video-note message subcommand registration (Telegram).
import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

/** Register sendLocation, sendVenue, and sendVideoNote subcommands. */
export function registerMessageLocationCommands(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      helpers
        .withRequiredMessageTarget(
          message
            .command("sendLocation")
            .description("Send a location pin (Telegram). Requires --latitude and --longitude."),
        )
        .requiredOption("--latitude <number>", "Latitude (-90 to 90)")
        .requiredOption("--longitude <number>", "Longitude (-180 to 180)")
        .option("--horizontal-accuracy <metres>", "Radius of uncertainty in metres (0–1500)"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("sendLocation", opts);
    });

  helpers
    .withMessageBase(
      helpers
        .withRequiredMessageTarget(
          message
            .command("sendVenue")
            .description(
              "Send a venue card with map pin (Telegram). Requires --latitude, --longitude, --title, --address.",
            ),
        )
        .requiredOption("--latitude <number>", "Latitude (-90 to 90)")
        .requiredOption("--longitude <number>", "Longitude (-180 to 180)")
        .requiredOption("--title <name>", "Venue name shown as the title")
        .requiredOption("--address <address>", "Street address shown below the title")
        .option("--foursquare-id <id>", "Foursquare venue ID (optional)")
        .option("--google-place-id <id>", "Google Places ID (optional)"),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("sendVenue", opts);
    });

  helpers
    .withMessageBase(
      helpers
        .withRequiredMessageTarget(
          message
            .command("sendVideoNote")
            .description(
              "Send a round video note / видеокружок (Telegram). Requires --media with a square MP4 URL or path.",
            ),
        )
        .requiredOption(
          "--media <path-or-url>",
          "Square MP4 video path or URL (max 60 s, max 1 minute side length).",
        ),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("sendVideoNote", { ...opts, mediaUrl: opts.media });
    });
}
