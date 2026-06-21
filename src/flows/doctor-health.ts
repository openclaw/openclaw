// Doctor health flow renders interactive health check output.
import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import { stylePromptTitle } from "../../packages/terminal-core/src/prompt-style.js";
import type { DoctorOptions } from "../commands/doctor-prompter.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import type {
  DoctorHealthFlowContext,
  DoctorRepairPreviewReport,
} from "./doctor-health-contributions.js";

// Interactive doctor entrypoint; lazy imports keep normal CLI startup light.
const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

type ConfigModule = typeof import("../config/config.js");

let configModulePromise: Promise<ConfigModule> | undefined;

function loadConfigModule(): Promise<ConfigModule> {
  return (configModulePromise ??= import("../config/config.js"));
}

/** Runs the full interactive doctor flow against the provided or default runtime. */
export async function doctorCommand(runtime?: RuntimeEnv, options: DoctorOptions = {}) {
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  const previewOnly = options.dryRun === true || options.diff === true;
  const effectiveOptions: DoctorOptions = previewOnly
    ? { ...options, repair: false, yes: false, generateGatewayToken: false, dryRun: true }
    : options;
  const jsonPreview = previewOnly && effectiveOptions.json === true;
  const flowRuntime: RuntimeEnv = jsonPreview
    ? { ...effectiveRuntime, log: () => {}, error: () => {} }
    : effectiveRuntime;
  if (
    !previewOnly &&
    (effectiveOptions.repair === true ||
      effectiveOptions.yes === true ||
      effectiveOptions.generateGatewayToken === true)
  ) {
    const { assertConfigWriteAllowedInCurrentMode } = await loadConfigModule();
    assertConfigWriteAllowedInCurrentMode();
  }

  const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
  const { printWizardHeader } = await import("../commands/onboard-helpers.js");
  const prompter = createDoctorPrompter({ runtime: flowRuntime, options: effectiveOptions });
  if (!jsonPreview) {
    printWizardHeader(flowRuntime);
    intro("OpenClaw doctor");
  }

  const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
  const updateResult = await maybeOfferUpdateBeforeDoctor({
    runtime: flowRuntime,
    options: effectiveOptions,
    root,
    confirm: (p) => prompter.confirm(p),
    outro,
  });
  if (updateResult.handled) {
    return;
  }

  // Keep side-effect-heavy legacy checks before structured contributions until fully migrated.
  const { maybeRepairUiProtocolFreshness } = await import("../commands/doctor-ui.js");
  const { noteSourceInstallIssues } = await import("../commands/doctor-install.js");
  const { noteStalePluginRuntimeSymlinks } =
    await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
  const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
  await withOptionalSuppressedNotes(jsonPreview, async () => {
    if (!previewOnly) {
      await maybeRepairUiProtocolFreshness(flowRuntime, prompter);
    }
    noteSourceInstallIssues(root);
    await noteStalePluginRuntimeSymlinks(root);
    noteStartupOptimizationHints();
  });

  const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
  const configOptions: DoctorOptions = effectiveOptions;
  const configResult = await withOptionalSuppressedNotes(jsonPreview, () =>
    loadAndMaybeMigrateDoctorConfig({
      options: configOptions,
      confirm: (p) => prompter.confirm(p),
      runtime: flowRuntime,
      prompter,
    }),
  );
  const { CONFIG_PATH } = await loadConfigModule();
  const previewReport: DoctorRepairPreviewReport | undefined = previewOnly
    ? (await import("./doctor-health-contributions.js")).createDoctorRepairPreviewReport({
        diff: effectiveOptions.diff === true,
      })
    : undefined;
  const ctx: DoctorHealthFlowContext = {
    runtime: flowRuntime,
    options: effectiveOptions,
    prompter,
    configResult,
    cfg: configResult.cfg,
    cfgForPersistence: structuredClone(configResult.cfg),
    sourceConfigValid: configResult.sourceConfigValid ?? true,
    configPath: configResult.path ?? CONFIG_PATH,
    previewReport,
  };
  const { finalizeDoctorRepairPreviewReport, runDoctorHealthContributions } =
    await import("./doctor-health-contributions.js");
  await withOptionalSuppressedNotes(jsonPreview, () => runDoctorHealthContributions(ctx));
  if (ctx.postInstallDoctorResult) {
    const {
      UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
      UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
      writeUpdatePostInstallDoctorResult,
    } = await import("../infra/update-doctor-result.js");
    const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
    if (resultPath) {
      await writeUpdatePostInstallDoctorResult({
        resultPath,
        result: ctx.postInstallDoctorResult,
      });
      effectiveRuntime.exit(UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE);
      return;
    }
  }

  if (previewReport) {
    const finalizedReport = finalizeDoctorRepairPreviewReport(previewReport);
    if (jsonPreview) {
      writeRuntimeJson(effectiveRuntime, finalizedReport);
    } else {
      effectiveRuntime.log(
        `Doctor dry-run complete: ${finalizedReport.findings.length} finding(s), ${finalizedReport.changes.length} preview change(s).`,
      );
    }
    return;
  }

  outro("Doctor complete.");
}

async function withOptionalSuppressedNotes<T>(
  suppress: boolean,
  callback: () => Promise<T>,
): Promise<T> {
  if (!suppress) {
    return callback();
  }
  const previous = process.env.OPENCLAW_SUPPRESS_NOTES;
  process.env.OPENCLAW_SUPPRESS_NOTES = "1";
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_SUPPRESS_NOTES;
    } else {
      process.env.OPENCLAW_SUPPRESS_NOTES = previous;
    }
  }
}
