import type { RuntimeEnv } from "../runtime.js";
import type { WizardSection } from "./configure.shared.js";
import { defaultRuntime } from "../runtime.js";
import { runConfigureWizard } from "./configure.wizard.js";

export async function configureCommand(runtime: RuntimeEnv = defaultRuntime) {
  await runConfigureWizard({ command: "configure" }, runtime);
}

export async function configureCommandWithSections(
  sections: WizardSection[],
  runtime: RuntimeEnv = defaultRuntime,
) {
  await runConfigureWizard({ command: "configure", sections }, runtime);
}
