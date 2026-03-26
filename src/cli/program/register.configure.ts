import type { Command } from "commander";
import { configureSurfaceCommand } from "../../commands/configure-surface.js";
import {
  CONFIGURE_WIZARD_SECTIONS,
  configureCommandFromSectionsArg,
} from "../../commands/configure.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

export function registerConfigureCommand(program: Command) {
  const configure = program
    .command("configure")
    .description("Interactive configuration for credentials, channels, gateway, and agent defaults")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/configure", "docs.openclaw.ai/cli/configure")}\n`,
    )
    .option(
      "--section <section>",
      `Configuration sections (repeatable). Options: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}`,
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await configureCommandFromSectionsArg(opts.section, defaultRuntime);
      });
    });

  configure
    .command("surface")
    .description("Export provider/channel setup surfaces for external configuration UIs")
    .requiredOption("--json-out <file>", "Write JSON output to this file")
    .option(
      "--section <section>",
      "Setup sections to export (repeatable): providers, channels",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--installed-only", "Only export installed setup surfaces", false)
    .action(async (opts, command) => {
      const parentSection = command.parent?.opts()?.section;
      const section =
        Array.isArray(opts.section) && opts.section.length > 0
          ? opts.section
          : Array.isArray(parentSection)
            ? parentSection
            : [];
      await runCommandWithRuntime(defaultRuntime, async () => {
        await configureSurfaceCommand({
          jsonOut: opts.jsonOut,
          section,
          installedOnly: opts.installedOnly,
          runtime: defaultRuntime,
        });
      });
    });
}
