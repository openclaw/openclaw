import type { Command } from "commander";
import { runGatewayAuthRotateCommand } from "../commands/auth-rotate.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerAuthCli(program: Command) {
  const auth = program
    .command("auth")
    .description("Gateway authentication helpers")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/configuration", "docs.openclaw.ai/configuration")}\n`,
    );

  auth
    .command("rotate")
    .description("Generate a new gateway auth token and persist it to config")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await runGatewayAuthRotateCommand(defaultRuntime);
      });
    });
}
