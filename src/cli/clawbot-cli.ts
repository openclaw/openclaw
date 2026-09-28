// Legacy clawbot command namespace kept for QR/linking aliases.
import type { Command } from "commander";
import { formatDocsHelp } from "./help-format.js";
import { registerQrCli } from "./qr-cli.js";

export function registerClawbotCli(program: Command) {
  const clawbot = program
    .command("clawbot")
    .description("Legacy clawbot command aliases")
    .addHelpText("after", () => formatDocsHelp("/cli/clawbot"));
  registerQrCli(clawbot);
}
