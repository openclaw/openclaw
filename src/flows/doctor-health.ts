import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";

const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

async function runCoreHarnessJson(runtime: RuntimeEnv): Promise<void> {
  try {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const { buildCoreHarnessSummary } = await import("../commands/doctor-core-harness.js");
    const { writeRuntimeJson } = await import("../runtime.js");
    const snapshot = await readConfigFileSnapshot();
    const summary = buildCoreHarnessSummary({
      cfg: snapshot.runtimeConfig,
      configPath: snapshot.path,
      sourceConfigValid: snapshot.valid,
      configIssues: snapshot.issues,
      env: process.env,
    });
    writeRuntimeJson(runtime, summary);
    if (!snapshot.valid) {
      runtime.exit(2);
    }
  } catch (err) {
    runtime.error(`Core Harness Summary failed: ${(err as Error).message}`);
    runtime.exit(2);
  }
}

export async function doctorCommand(runtime?: RuntimeEnv, options: DoctorOptions = {}) {
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  if (options.json === true) {
    await runCoreHarnessJson(effectiveRuntime);
    return;
  }
  if (options.repair === true || options.yes === true || options.generateGatewayToken === true) {
    const { assertConfigWriteAllowedInCurrentMode } = await import("../config/config.js");
    assertConfigWriteAllowedInCurrentMode();
  }

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
  const { noteStalePluginRuntimeSymlinks } =
    await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
  const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
  await maybeRepairUiProtocolFreshness(effectiveRuntime, prompter);
  noteSourceInstallIssues(root);
  await noteStalePluginRuntimeSymlinks(root);
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
