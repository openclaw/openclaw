import { intro as clackIntro, outro as clackOutro, log as clackLog } from "@clack/prompts";
import { loadAndMaybeMigrateDoctorConfig } from "../commands/doctor-config-flow.js";
import { noteSourceInstallIssues } from "../commands/doctor-install.js";
import { noteStartupOptimizationHints } from "../commands/doctor-platform-notes.js";
import { createDoctorPrompter, type DoctorOptions } from "../commands/doctor-prompter.js";
import { maybeRepairUiProtocolFreshness } from "../commands/doctor-ui.js";
import { maybeOfferUpdateBeforeDoctor } from "../commands/doctor-update.js";
import { printWizardHeader } from "../commands/onboard-helpers.js";
import { CONFIG_PATH } from "../config/config.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";
import { runDoctorHealthContributions } from "./doctor-health-contributions.js";

const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

export async function doctorCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DoctorOptions = {},
) {
  const isWatch = Boolean(options.watch);
  const intervalMs = options.watchIntervalMs ?? 60_000;

  // Watch mode forces nonInteractive and disables repairs
  const effectiveOptions: DoctorOptions = isWatch
    ? { ...options, nonInteractive: true, repair: false, force: false }
    : options;

  printWizardHeader(runtime);
  intro(isWatch ? "OpenClaw doctor (watch mode)" : "OpenClaw doctor");

  if (isWatch) {
    clackLog.step(`Watching every ${(intervalMs / 1000).toFixed(0)}s — press Ctrl+C to stop`);
  }

  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  // One-time: check for updates, repair UI, print notes
  const skipPrompter = {
    confirm: async () => false as boolean,
    confirmAutoFix: async () => false as boolean,
    confirmAggressiveAutoFix: async () => false as boolean,
    confirmRuntimeRepair: async () => false as boolean,
    select: async <T>(_: unknown, fb: T) => fb,
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      canPrompt: false,
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: true,
    } as import("../commands/doctor-repair-mode.js").DoctorRepairMode,
  };
  const updateResult = await maybeOfferUpdateBeforeDoctor({
    runtime,
    options: effectiveOptions,
    root,
    confirm: async () => false,
    outro: (msg: string) => clackOutro(stylePromptTitle(msg) ?? msg),
  });
  if (updateResult.handled && !isWatch) {
    return;
  }
  void maybeRepairUiProtocolFreshness(runtime, skipPrompter);
  noteSourceInstallIssues(root);
  noteStartupOptimizationHints();

  if (isWatch) {
    // Watch loop: rebuild prompter + ctx on every iteration
    while (true) {
      const prompter = createDoctorPrompter({ runtime, options: effectiveOptions });
      const configResult = await loadAndMaybeMigrateDoctorConfig({
        options: effectiveOptions,
        confirm: (p) => prompter.confirm(p),
      });
      const ctx = {
        runtime,
        options: effectiveOptions,
        prompter,
        configResult,
        cfg: configResult.cfg,
        cfgForPersistence: structuredClone(configResult.cfg),
        sourceConfigValid: configResult.sourceConfigValid ?? true,
        configPath: configResult.path ?? CONFIG_PATH,
      };

      await runDoctorHealthContributions(ctx);

      clackLog.info(`Next check in ${(intervalMs / 1000).toFixed(0)}s...`);
      await sleep(intervalMs);
    }
  } else {
    // Single run: interactive
    const prompter = createDoctorPrompter({ runtime, options: effectiveOptions });
    const configResult = await loadAndMaybeMigrateDoctorConfig({
      options: effectiveOptions,
      confirm: (p) => prompter.confirm(p),
    });
    const ctx = {
      runtime,
      options: effectiveOptions,
      prompter,
      configResult,
      cfg: configResult.cfg,
      cfgForPersistence: structuredClone(configResult.cfg),
      sourceConfigValid: configResult.sourceConfigValid ?? true,
      configPath: configResult.path ?? CONFIG_PATH,
    };
    await runDoctorHealthContributions(ctx);
  }

  outro("Doctor complete.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
