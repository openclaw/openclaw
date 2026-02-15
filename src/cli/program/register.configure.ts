import type { Command } from "commander";
import { CONFIGURE_WIZARD_SECTIONS } from "../../commands/configure-sections.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";

export function registerConfigureCommand(program: Command) {
  program
    .command("configure")
    .description("Interactive prompt to set up credentials, devices, and agent defaults")
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
      const { defaultRuntime } = await import("../../runtime.js");
      const { runCommandWithRuntime } = await import("../cli-utils.js");
      const { configureCommand, configureCommandWithSections, parseConfigureWizardSections } =
        await import("../../commands/configure.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { sections, invalid } = parseConfigureWizardSections(opts.section);
        if (sections.length === 0) {
          await configureCommand(defaultRuntime);
          return;
        }

        if (invalid.length > 0) {
          defaultRuntime.error(
            `Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}.`,
          );
          defaultRuntime.exit(1);
          return;
        }

        await configureCommandWithSections(sections as never, defaultRuntime);
      });
    });
}
