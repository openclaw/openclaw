// Entry points for the full configure wizard and section-limited runs.
import process from "node:process";
import { formatCliCommand } from "../cli/command-format.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import type { WizardSection } from "./configure.shared.js";
import { CONFIGURE_WIZARD_SECTIONS, parseConfigureWizardSections } from "./configure.shared.js";
import { runConfigureWizard } from "./configure.wizard.js";

const CONFIGURE_NON_TTY_HELP = [
  "Interactive configuration requires an interactive terminal.",
  "",
  "Use non-interactive commands instead:",
  `  ${formatCliCommand("openclaw config get <path>")}    Read a config value`,
  `  ${formatCliCommand("openclaw config set <path> <value>")}    Set a config value`,
  `  ${formatCliCommand("openclaw config unset <path>")}    Remove a config value`,
  `  ${formatCliCommand("openclaw config validate")}    Validate configuration`,
  `  ${formatCliCommand("openclaw config schema")}    Print config JSON schema`,
  `  ${formatCliCommand("openclaw config file")}    Show config file path`,
  `  ${formatCliCommand("openclaw doctor --fix")}    Auto-fix config issues with non-interactive flags`,
].join("\n");

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function configureCommand(runtime: RuntimeEnv = defaultRuntime) {
  if (!isInteractiveTerminal()) {
    runtime.error(CONFIGURE_NON_TTY_HELP);
    runtime.exit(1);
    return;
  }
  await runConfigureWizard({ command: "configure" }, runtime);
}

async function configureCommandWithSections(
  sections: WizardSection[],
  runtime: RuntimeEnv = defaultRuntime,
) {
  if (!isInteractiveTerminal()) {
    runtime.error(CONFIGURE_NON_TTY_HELP);
    runtime.exit(1);
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
