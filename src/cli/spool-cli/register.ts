import type { Command } from "commander";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { registerSpoolEnqueueCommand } from "./enqueue.js";
import { registerSpoolStatusCommand } from "./status.js";

export function registerSpoolCli(program: Command) {
  const spool = program
    .command("spool")
    .description("Manage spool events (event-driven dispatch)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/spool", "docs.openclaw.ai/cli/spool")}\n`,
    );

  registerSpoolStatusCommand(spool);
  registerSpoolEnqueueCommand(spool);
}
