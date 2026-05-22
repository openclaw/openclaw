import { intro as clackIntro, outro as clackOutro } from "@clack/prompts";
import type { DoctorOptions, DoctorPrompter } from "../commands/doctor-prompter.js";
import type { RuntimeEnv } from "../runtime.js";
import { stylePromptTitle } from "../terminal/prompt-style.js";

const intro = (message: string) => clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) => clackOutro(stylePromptTitle(message) ?? message);

export async function doctorCommand(runtime?: RuntimeEnv, options: DoctorOptions = {}) {
  const effectiveRuntime = runtime ?? (await import("../runtime.js")).defaultRuntime;
  const previewOnly = options.dryRun === true || options.diff === true;
  const effectiveOptions: DoctorOptions = previewOnly
    ? { ...options, dryRun: true, repair: true }
    : options;
  const jsonPreview = previewOnly && effectiveOptions.json === true;
  const configOptions: DoctorOptions = previewOnly
    ? { ...effectiveOptions, repair: false, yes: false, generateGatewayToken: false }
    : effectiveOptions;
  if (
    !previewOnly &&
    (effectiveOptions.repair === true ||
      effectiveOptions.yes === true ||
      effectiveOptions.generateGatewayToken === true)
  ) {
    const { assertConfigWriteAllowedInCurrentMode } = await import("../config/config.js");
    assertConfigWriteAllowedInCurrentMode();
  }

  const { createDoctorPrompter } = await import("../commands/doctor-prompter.js");
  const { printWizardHeader } = await import("../commands/onboard-helpers.js");
  const prompter = createDoctorPrompter({ runtime: effectiveRuntime, options: effectiveOptions });
  if (!jsonPreview) {
    printWizardHeader(effectiveRuntime);
    intro("OpenClaw doctor");
  }

  const previousSuppressNotes = process.env.OPENCLAW_SUPPRESS_NOTES;
  if (jsonPreview) {
    process.env.OPENCLAW_SUPPRESS_NOTES = "1";
  }
  try {
    await runDoctorCommandBody({
      effectiveRuntime,
      effectiveOptions,
      configOptions,
      prompter,
      previewOnly,
      jsonPreview,
    });
  } finally {
    if (jsonPreview) {
      if (previousSuppressNotes === undefined) {
        delete process.env.OPENCLAW_SUPPRESS_NOTES;
      } else {
        process.env.OPENCLAW_SUPPRESS_NOTES = previousSuppressNotes;
      }
    }
  }
}

async function runDoctorCommandBody(params: {
  effectiveRuntime: RuntimeEnv;
  effectiveOptions: DoctorOptions;
  configOptions: DoctorOptions;
  prompter: DoctorPrompter;
  previewOnly: boolean;
  jsonPreview: boolean;
}) {
  const { effectiveRuntime, effectiveOptions, configOptions, prompter, previewOnly, jsonPreview } =
    params;
  const { resolveOpenClawPackageRoot } = await import("../infra/openclaw-root.js");
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  const { maybeOfferUpdateBeforeDoctor } = await import("../commands/doctor-update.js");
  const updateResult = await maybeOfferUpdateBeforeDoctor({
    runtime: effectiveRuntime,
    options: effectiveOptions,
    root,
    confirm: (p) => prompter.confirm(p),
    outro,
  });
  if (updateResult.handled) {
    return;
  }

  const {
    createDoctorRepairPreviewReport,
    finalizeDoctorRepairPreviewReport,
    recordDoctorPreviewSkippedContribution,
  } = await import("./doctor-health-contributions.js");
  const previewReport = jsonPreview
    ? createDoctorRepairPreviewReport({ diff: effectiveOptions.diff === true })
    : undefined;
  const { maybeRepairUiProtocolFreshness } = await import("../commands/doctor-ui.js");
  const { noteSourceInstallIssues } = await import("../commands/doctor-install.js");
  const { noteStalePluginRuntimeSymlinks } =
    await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
  const { noteStartupOptimizationHints } = await import("../commands/doctor-platform-notes.js");
  if (previewOnly) {
    const { note } = await import("../terminal/note.js");
    note(
      [
        "Skipped UI freshness repair during doctor preview.",
        "Conversion target: core/doctor/ui-freshness.",
        "Run `openclaw doctor --fix` without preview flags to execute the legacy repair path.",
      ].join("\n"),
      "Doctor preview",
    );
    if (previewReport !== undefined) {
      recordDoctorPreviewSkippedContribution({
        report: previewReport,
        id: "doctor:ui-freshness",
        label: "UI freshness",
        healthCheckIds: ["core/doctor/ui-freshness"],
        targets: ["core/doctor/ui-freshness"],
        reason: "legacy-preflight-repair-not-converted-to-structured-dry-run-diff",
      });
    }
  } else {
    await maybeRepairUiProtocolFreshness(effectiveRuntime, prompter);
  }
  noteSourceInstallIssues(root);
  await noteStalePluginRuntimeSymlinks(root);
  noteStartupOptimizationHints();

  const { loadAndMaybeMigrateDoctorConfig } = await import("../commands/doctor-config-flow.js");
  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options: configOptions,
    confirm: previewOnly ? async () => false : (p) => prompter.confirm(p),
    runtime: effectiveRuntime,
    prompter,
    ...(previewOnly
      ? {
          preflight: {
            migrateState: false,
            migrateLegacyConfig: false,
          },
        }
      : {}),
  });
  if (previewReport !== undefined) {
    recordDoctorPreviewSkippedContribution({
      report: previewReport,
      id: "doctor:config-flow",
      label: "Config flow",
      targets: ["doctor-config-flow"],
      reason: "legacy-config-flow-preview-not-converted-to-structured-dry-run-diff",
    });
  }
  const { CONFIG_PATH } = await import("../config/config.js");
  const ctx = {
    runtime: effectiveRuntime,
    options: effectiveOptions,
    prompter,
    configResult,
    cfg: configResult.cfg,
    cfgForPersistence: structuredClone(configResult.cfg),
    sourceConfigValid: configResult.sourceConfigValid ?? true,
    configPath: configResult.path ?? CONFIG_PATH,
    ...(previewReport !== undefined ? { previewReport } : {}),
  };
  const { runDoctorHealthContributions } = await import("./doctor-health-contributions.js");
  await runDoctorHealthContributions(ctx);

  if (previewReport !== undefined) {
    process.stdout.write(JSON.stringify(finalizeDoctorRepairPreviewReport(previewReport)) + "\n");
  } else {
    outro("Doctor complete.");
  }
}
