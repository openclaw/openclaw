import { defaultRuntime } from "../runtime.js";
import { CONFIGURE_WIZARD_SECTIONS, parseConfigureWizardSections } from "./configure.shared.js";
import { runConfigureWizard } from "./configure.wizard.js";
export async function configureCommand(runtime = defaultRuntime) {
    await runConfigureWizard({ command: "configure" }, runtime);
}
export async function configureCommandWithSections(sections, runtime = defaultRuntime) {
    await runConfigureWizard({ command: "configure", sections }, runtime);
}
export async function configureCommandFromSectionsArg(rawSections, runtime = defaultRuntime) {
    const { sections, invalid } = parseConfigureWizardSections(rawSections);
    if (sections.length === 0) {
        await configureCommand(runtime);
        return;
    }
    if (invalid.length > 0) {
        runtime.error(`Invalid --section: ${invalid.join(", ")}. Expected one of: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}.`);
        runtime.exit(1);
        return;
    }
    await configureCommandWithSections(sections, runtime);
}
