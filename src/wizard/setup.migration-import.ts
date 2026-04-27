import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MigrationProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

export type SetupMigrationDetection = {
  providerId: string;
  label: string;
  source?: string;
  message?: string;
};

export async function detectSetupMigrationSources(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
}): Promise<SetupMigrationDetection[]> {
  const [{ resolvePluginMigrationProviders }, { createMigrationLogger }, { resolveStateDir }] =
    await Promise.all([
      import("../plugins/migration-provider-runtime.js"),
      import("../commands/migrate/context.js"),
      import("../config/paths.js"),
    ]);
  const stateDir = resolveStateDir();
  const logger = createMigrationLogger(params.runtime);
  const detections: SetupMigrationDetection[] = [];
  for (const provider of resolvePluginMigrationProviders({ cfg: params.config })) {
    if (!provider.detect) {
      continue;
    }
    try {
      const detection = await provider.detect({
        config: params.config,
        stateDir,
        logger,
      });
      if (detection.found) {
        detections.push({
          providerId: provider.id,
          label: detection.label ?? provider.label,
          ...(detection.source ? { source: detection.source } : {}),
          ...(detection.message ? { message: detection.message } : {}),
        });
      }
    } catch (error) {
      logger.debug?.(
        `Migration provider ${provider.id} detection failed: ${formatErrorMessage(error)}`,
      );
    }
  }
  return detections;
}

function resolveImportSourceDefault(params: {
  providerId: string;
  detections: readonly SetupMigrationDetection[];
}): string {
  const detected = params.detections.find(
    (detection) => detection.providerId === params.providerId,
  );
  if (detected?.source) {
    return detected.source;
  }
  return params.providerId === "hermes" ? "~/.hermes" : "";
}

async function selectSetupMigrationProvider(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
  prompter: WizardPrompter;
}): Promise<{
  provider: MigrationProviderPlugin;
  providerId: string;
}> {
  const { resolvePluginMigrationProvider, resolvePluginMigrationProviders } =
    await import("../plugins/migration-provider-runtime.js");
  const providers = resolvePluginMigrationProviders({ cfg: params.baseConfig });
  if (providers.length === 0) {
    throw new Error("No migration providers found.");
  }
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const providerId =
    params.opts.importFrom?.trim() ||
    (await params.prompter.select({
      message: "Migration source",
      options: [
        ...params.detections.map((detection) => ({
          value: detection.providerId,
          label: detection.label,
          ...(detection.source || detection.message
            ? { hint: detection.source ?? detection.message }
            : {}),
        })),
        ...providers
          .filter(
            (provider) =>
              !params.detections.some((detection) => detection.providerId === provider.id),
          )
          .map((provider) => ({
            value: provider.id,
            label: provider.label,
            hint: provider.description ?? "Enter a source path next",
          })),
      ],
      initialValue: params.detections[0]?.providerId ?? providers[0]?.id,
    }));
  const provider =
    providerById.get(providerId) ??
    resolvePluginMigrationProvider({ providerId, cfg: params.baseConfig });
  if (!provider) {
    throw new Error(`Unknown migration provider "${providerId}".`);
  }
  return { provider, providerId };
}

export async function runSetupMigrationImport(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  writeConfigFile: (config: OpenClawConfig) => Promise<OpenClawConfig>;
}): Promise<void> {
  const [
    { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig },
    { createMigrationLogger, buildMigrationReportDir },
    { createPreMigrationBackup },
    { assertApplySucceeded, assertConflictFreePlan, formatMigrationPlan },
    { resolveStateDir },
    onboardHelpers,
  ] = await Promise.all([
    import("../commands/onboard-config.js"),
    import("../commands/migrate/context.js"),
    import("../commands/migrate/apply.js"),
    import("../commands/migrate/output.js"),
    import("../config/paths.js"),
    import("../commands/onboard-helpers.js"),
  ]);
  const { provider, providerId } = await selectSetupMigrationProvider({
    opts: params.opts,
    baseConfig: params.baseConfig,
    detections: params.detections,
    prompter: params.prompter,
  });
  const sourceDefault = resolveImportSourceDefault({ providerId, detections: params.detections });
  const sourceDir =
    params.opts.importSource?.trim() ||
    sourceDefault ||
    (params.opts.nonInteractive
      ? (() => {
          throw new Error("--import-source is required for non-interactive migration import.");
        })()
      : await params.prompter.text({
          message: "Source agent home",
          initialValue: providerId === "hermes" ? "~/.hermes" : undefined,
        }));
  const workspaceInput =
    params.opts.workspace ??
    (params.opts.nonInteractive
      ? (params.baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await params.prompter.text({
          message: "Target workspace directory",
          initialValue:
            params.baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));
  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);
  let targetConfig = applyLocalSetupWorkspaceConfig(params.baseConfig, workspaceDir);
  if (params.opts.skipBootstrap) {
    targetConfig = applySkipBootstrapConfig(targetConfig);
  }

  const stateDir = resolveStateDir();
  const ctx = {
    config: targetConfig,
    stateDir,
    source: sourceDir,
    includeSecrets: Boolean(params.opts.importSecrets),
    overwrite: false,
    logger: createMigrationLogger(params.runtime),
  };
  const plan = await provider.plan(ctx);
  await params.prompter.note(formatMigrationPlan(plan).join("\n"), "Migration preview");
  assertConflictFreePlan(plan, providerId);

  const confirmed =
    params.opts.nonInteractive === true
      ? true
      : await params.prompter.confirm({
          message: "Apply this migration now?",
          initialValue: false,
        });
  if (!confirmed) {
    throw new WizardCancelledError("migration cancelled");
  }

  const reportDir = buildMigrationReportDir(providerId, stateDir);
  const backupPath = await createPreMigrationBackup({});
  targetConfig = onboardHelpers.applyWizardMetadata(targetConfig, {
    command: "onboard",
    mode: "local",
  });
  targetConfig = await params.writeConfigFile(targetConfig);
  const applyCtx = {
    ...ctx,
    config: targetConfig,
    ...(backupPath ? { backupPath } : {}),
    reportDir,
  };
  const result = await provider.apply(applyCtx, plan);
  const withReport = {
    ...result,
    ...((result.backupPath ?? backupPath) ? { backupPath: result.backupPath ?? backupPath } : {}),
    reportDir: result.reportDir ?? reportDir,
  };
  assertApplySucceeded(withReport);
  await params.prompter.note(formatMigrationPlan(withReport).join("\n"), "Migration applied");
  await params.prompter.outro("Migration complete. Run `openclaw doctor` next.");
}
