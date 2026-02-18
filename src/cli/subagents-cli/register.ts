import type { Command } from "commander";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { registerSubagentsRecoverCommand, registerSubagentsListFailedCommand } from "./recover.js";

export function registerSubagentsCli(program: Command) {
  const subagents = program
    .command("subagents")
    .description("Manage subagent operations")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/subagents", "docs.openclaw.ai/cli/subagents")}\n`,
    );

  registerSubagentsRecoverCommand(subagents);
  registerSubagentsListFailedCommand(subagents);
}
