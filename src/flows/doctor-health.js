import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { stylePromptTitle } from "../terminal/prompt-style.js";
const intro = (message) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message) => clackOutro(stylePromptTitle(message) ?? message);
export async function doctorCommand(runtime, options = {}) {
    const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
    const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
    const { printWizardHeader } = await import("../commands/onboard-helpers.js");
    const prompter = createDoctorPrompter({ runtime: effectiveRuntime, options });
    printWizardHeader(effectiveRuntime);
    intro("OpenClaw doctor");
    const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
    const root = await resolveOpenClawPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
    });
    const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
    const updateResult = await maybeOfferUpdateBeforeDoctor({
        runtime: effectiveRuntime,
        options,
        root,
        confirm: (p) => prompter.confirm(p),
        outro,
    });
    if (updateResult.handled) {
        return;
    }
    const { maybeRepairUiProtocolFreshness } = await import("../commands/doctor-ui.js");
    const { noteSourceInstallIssues } = await import("../commands/doctor-install.js");
    const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
    await maybeRepairUiProtocolFreshness(effectiveRuntime, prompter);
    noteSourceInstallIssues(root);
    noteStartupOptimizationHints();
    const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
    const configResult = await loadAndMaybeMigrateDoctorConfig({
        options,
        confirm: (p) => prompter.confirm(p),
        runtime: effectiveRuntime,
        prompter,
    });
    const { CONFIG_PATH } = await import("../config/config.js");
    const ctx = {
        runtime: effectiveRuntime,
        options,
        prompter,
        configResult,
        cfg: configResult.cfg,
        cfgForPersistence: structuredClone(configResult.cfg),
        sourceConfigValid: configResult.sourceConfigValid ?? true,
        configPath: configResult.path ?? CONFIG_PATH,
    };
    const { runDoctorHealthContributions } = await import("./doctor-health-contributions.js");
    await runDoctorHealthContributions(ctx);
    outro("Doctor complete.");
}
