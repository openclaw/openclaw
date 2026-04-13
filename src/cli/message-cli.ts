import { createChannelOutboundRuntimeSend } from "./send-runtime/channel-outbound-send.js";
import { loadConfig } from "../../config/config.js";
import { resolveOutboundMediaAccess } from "../../media/load-options.js";
import fs from "node:fs/promises";

export const command = "message";
export const describe = "Message commands";

export const builder = (yargs: any) => {
  return yargs.command(
    "send <target>",
    "Send a message to a target",
    (yargs: any) => {
      return yargs
        .positional("target", { describe: "Target recipient", type: "string" })
        .option("channel", { describe: "Channel ID", type: "string", demandOption: true })
        .option("message", { describe: "Message text", type: "string" })
        .option("media", { describe: "Media URL or file path", type: "string" })
        .option("accountId", { describe: "Account ID", type: "string" })
        .option("silent", { describe: "Send silently", type: "boolean", default: false });
    },
    async (argv: any) => {
      const { target, channel, message, media, accountId, silent } = argv;
      const cfg = loadConfig();

      const runtime = createChannelOutboundRuntimeSend({
        channelId: channel,
        unavailableMessage: `Channel '${channel}' is not available or not configured.`,
      });

      // Prepare media access options for the CLI context
      const mediaReadFile = fs.readFile;
      const mediaAccess = resolveOutboundMediaAccess({
        mediaReadFile,
      });

      await runtime.sendMessage(target, message ?? "", {
        cfg,
        mediaUrl: media, // Fix: Pass the media flag value to enable media sending
        mediaAccess,
        mediaReadFile,
        accountId,
        silent,
      });
    }
  );
};
