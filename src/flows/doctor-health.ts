import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { loadAndMaybeMigrateDoctorConfig } from "../commands/doctor-config-flow.js";
import { noteSourceInstallIssues } from "../commands/doctor-install.js";
import { noteStartupOptimizationHints } from "../commands/doctor-platform-notes.js";
import { createDoctorPrompter, type DoctorOptions } from "../commands/doctor-prompter.js";
import { maybeRepairUiProtocolFreshness } from "../commands/doctor-ui.js";
import { maybeOfferUpdateBeforeDoctor } from "../commands/doctor-update.js";
import { printWizardHeader } from "../commands/wizard-core.js";
import { CONFIG_PATH } from "../config/config.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { runDoctorHealthContributions } from "./doctor-health-contributions.js";

const canRenderDoctorBoundary = () => Boolean(process.stdout.isTTY);
const intro = (runtime: RuntimeEnv, message: string) => {
  const styled = stylePromptTitle(message) ?? message;
  if (canRenderDoctorBoundary()) {
    clackIntro(styled);
    return;
  }
  runtime.log(styled);
};
const outro = (runtime: RuntimeEnv, message: string) => {
  const styled = stylePromptTitle(message) ?? message;
  if (canRenderDoctorBoundary()) {
    clackOutro(styled);
    return;
  }
  runtime.log(styled);
};
const doctorDebugEnabled = () => process.env.OPENCLAW_DEBUG_DOCTOR === "1";
const debugDoctor = (message: string) => {
  if (!doctorDebugEnabled()) {
    return;
  }
  process.stderr.write(`[doctor:debug] ${message}\n`);
};

export async function doctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DoctorOptions = {},
) {
  const prompter = createDoctorPrompter({ runtime, options });
  printWizardHeader(runtime);
  intro(runtime, "OpenClaw doctor");
  debugDoctor("intro");

  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  debugDoctor(`resolved root: ${root ?? "<none>"}`);

  const updateResult = await maybeOfferUpdateBeforeDoctor({
    runtime,
    options,
    root,
    confirm: (p) => prompter.confirm(p),
    outro: (message) => outro(runtime, message),
  });
  debugDoctor(`update handled=${Boolean(updateResult.handled)} updated=${Boolean(updateResult.updated)}`);
  if (updateResult.handled) {
    return;
  }

  debugDoctor("maybeRepairUiProtocolFreshness:start");
  await maybeRepairUiProtocolFreshness(runtime, prompter);
  debugDoctor("maybeRepairUiProtocolFreshness:done");
  noteSourceInstallIssues(root);
  debugDoctor("noteSourceInstallIssues:done");
  noteStartupOptimizationHints();
  debugDoctor("noteStartupOptimizationHints:done");

  debugDoctor("loadAndMaybeMigrateDoctorConfig:start");
  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: (p) => prompter.confirm(p),
  });
  debugDoctor("loadAndMaybeMigrateDoctorConfig:done");
  const ctx = {
    runtime,
    options,
    prompter,
    configResult,
    cfg: configResult.cfg,
    cfgForPersistence: structuredClone(configResult.cfg),
    sourceConfigValid: configResult.sourceConfigValid ?? true,
    configPath: configResult.path ?? CONFIG_PATH,
  };
  debugDoctor("runDoctorHealthContributions:start");
  await runDoctorHealthContributions(ctx);
  debugDoctor("runDoctorHealthContributions:done");

  outro(runtime, "Doctor complete.");
}
