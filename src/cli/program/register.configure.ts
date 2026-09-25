// Configure command registration: lazy-loads the interactive configuration wizard.
import type { Command } from "commander";
import { CONFIGURE_WIZARD_SECTIONS } from "../../commands/configure.shared.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatDocsHelp } from "../help-format.js";
import { collectOption } from "./helpers.js";

/** Register the interactive `configure` command and section filter flag. */
export function registerConfigureCommand(program: Command): void {
  program
    .command("configure")
    .description("Interactive configuration for credentials, channels, gateway, and agent defaults")
    .addHelpText("after", () => formatDocsHelp("/cli/configure"))
    .option(
      "--section <section>",
      `Configuration sections (repeatable). Options: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}`,
      collectOption,
      [] as string[],
    )
    .action(async (opts) => {
      const { defaultRuntime } = await import("../../runtime.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { configureCommandFromSectionsArg } =
          await import("../../commands/configure.commands.js");
        await configureCommandFromSectionsArg(opts.section, defaultRuntime);
      });
    });
}
