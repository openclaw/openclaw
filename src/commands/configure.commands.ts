// Entry points for the full configure wizard and section-limited runs.
import { formatCliCommand } from "../cli/command-format.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import type { WizardSection } from "./configure.shared.js";
import { CONFIGURE_WIZARD_SECTIONS, parseConfigureWizardSections } from "./configure.shared.js";
import { runConfigureWizard } from "./configure.wizard.js";

function failClosedNonInteractive(runtime: RuntimeEnv): void {
  runtime.error(
    `Interactive configuration requires a terminal (TTY). ` +
      `Use non-interactive subcommands instead:\n` +
      `  ${formatCliCommand("openclaw config set <key> <value>")}  write a config entry\n` +
      `  ${formatCliCommand("openclaw config get <key>")}          read a config entry\n` +
      `  ${formatCliCommand("openclaw config validate")}           check config is valid\n` +
      `  ${formatCliCommand("openclaw config list")}               list all config keys`,
  );
  runtime.exit(1);
}

async function configureCommand(runtime: RuntimeEnv = defaultRuntime) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    failClosedNonInteractive(runtime);
    return;
  }
  await runConfigureWizard({ command: "configure" }, runtime);
}

async function configureCommandWithSections(
  sections: WizardSection[],
  runtime: RuntimeEnv = defaultRuntime,
) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    failClosedNonInteractive(runtime);
    return;
  }
  await runConfigureWizard({ command: "configure", sections }, runtime);
}

/** Parse `--section` input and run the requested configure wizard sections. */
export async function configureCommandFromSectionsArg(
  rawSections: unknown,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const { sections, invalid } = parseConfigureWizardSections(rawSections);
  if (sections.length === 0) {
    await configureCommand(runtime);
    return;
  }

  if (invalid.length > 0) {
    runtime.error(
      `Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}. Run ${formatCliCommand("openclaw configure")} without --section to use the full wizard.`,
    );
    runtime.exit(1);
    return;
  }

  await configureCommandWithSections(sections as never, runtime);
}
