import { formatCliCommand } from "../cli/command-format.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getLoadedRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import {
  listAvailableManifestContractPlugins,
  loadManifestContractSnapshot,
} from "../plugins/manifest-contract-eligibility.js";
import type {
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { t } from "./i18n/index.js";
import { runWizardWithPromptNavigationScope } from "./navigation-prompter.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";
import { offerLiveModelVerification } from "./setup.inference-verification.js";
import {
  assertDeferredMigrationApplyContract,
  finalizeSetupMigrationPromotion,
} from "./setup.migration-finalize.js";
import {
  assertFreshSetupMigrationTarget,
  buildSetupMigrationPlanSourceSnapshot,
  buildSetupMigrationTargetSnapshot,
  inspectSetupMigrationFreshness,
  preserveSetupMigrationOnboardingConsents,
  prepareSetupMigrationAttemptBoundary,
  SetupMigrationTargetChangedError,
  withSetupMigrationTargetLock,
} from "./setup.migration-snapshot.js";
import {
  buildSetupMigrationPhasePlan,
  createSetupMigrationStage,
  recoverSetupMigrationPromotion,
  type SetupMigrationPromotionOutcome,
} from "./setup.migration-stage.js";

type SetupMigrationDetection = {
  providerId: string;
  label: string;
  source?: string;
  message?: string;
};
type SetupMigrationOption = {
  providerId: string;
  label: string;
  hint?: string;
};
type SetupMigrationProviderDescriptor = {
  providerId: string;
  label: string;
  description?: string;
};

async function detectSetupMigrationSource(
  provider: MigrationProviderPlugin,
  ctx: MigrationProviderContext,
): Promise<SetupMigrationDetection | undefined> {
  if (!provider.detect) {
    return undefined;
  }
  try {
    const detection = await provider.detect(ctx);
    if (detection.found) {
      return {
        providerId: provider.id,
        label: detection.label ?? provider.label,
        ...(detection.source ? { source: detection.source } : {}),
        ...(detection.message ? { message: detection.message } : {}),
      };
    }
  } catch (error) {
    // Detection is advisory; one failing provider must not prevent onboarding
    // from offering other migration sources.
    ctx.logger.debug?.(
      `Migration provider ${provider.id} detection failed: ${formatErrorMessage(error)}`,
    );
  }
  return undefined;
}

export async function detectSetupMigrationSources(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
}): Promise<{
  detections: SetupMigrationDetection[];
  providerDescriptors: SetupMigrationProviderDescriptor[];
}> {
  const [{ withPluginMigrationProviders }, { createMigrationLogger }, { resolveStateDir }] =
    await Promise.all([
      import("../plugins/migration-provider-runtime.js"),
      import("../commands/migrate/context.js"),
      import("../config/paths.js"),
    ]);
  return await withPluginMigrationProviders(
    {
      cfg: params.config,
      onCleanupError: (error) => {
        params.runtime.error(
          `Migration discovery result retained, but plugin cleanup failed: ${formatErrorMessage(error)}`,
        );
      },
    },
    async (providers) => {
      const stateDir = resolveStateDir();
      const logger = createMigrationLogger(params.runtime);
      const detections: SetupMigrationDetection[] = [];
      for (const provider of providers) {
        const detection = await detectSetupMigrationSource(provider, {
          config: params.config,
          stateDir,
          logger,
        });
        if (detection) {
          detections.push(detection);
        }
      }
      return { detections, providerDescriptors: providers.map(describeSetupMigrationProvider) };
    },
  );
}

function describeSetupMigrationProvider(
  provider: MigrationProviderPlugin,
): SetupMigrationProviderDescriptor {
  return { providerId: provider.id, label: provider.label, description: provider.description };
}

function resolveManifestSetupMigrationProviders(
  baseConfig: OpenClawConfig,
): SetupMigrationProviderDescriptor[] {
  const snapshot = loadManifestContractSnapshot({ config: baseConfig });
  return listAvailableManifestContractPlugins({
    snapshot,
    contract: "migrationProviders",
    config: baseConfig,
  }).flatMap((plugin) =>
    (plugin.contracts?.migrationProviders ?? []).map((providerId) => {
      const provider: SetupMigrationProviderDescriptor = {
        providerId,
        label:
          plugin.name?.trim().replace(/\s+Migration$/i, "") ||
          providerId
            .split(/[-_]+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(" ") ||
          providerId,
      };
      if (plugin.description) {
        provider.description = plugin.description;
      }
      return provider;
    }),
  );
}

export async function listSetupMigrationOptions(params: {
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
  providerDescriptors?: readonly SetupMigrationProviderDescriptor[];
}): Promise<SetupMigrationOption[]> {
  const providers = [
    ...(getLoadedRuntimePluginRegistry()?.migrationProviders ?? []).map(({ provider }) =>
      describeSetupMigrationProvider(provider),
    ),
    ...(params.providerDescriptors ?? []),
  ].toSorted((left, right) => left.providerId.localeCompare(right.providerId));
  const options: SetupMigrationOption[] = [];
  const providerIds = new Set<string>();
  const addOption = (option: SetupMigrationOption) => {
    if (providerIds.has(option.providerId)) {
      return;
    }
    providerIds.add(option.providerId);
    options.push(option);
  };

  for (const detection of params.detections) {
    addOption({
      providerId: detection.providerId,
      label: t("wizard.migration.importFrom", { source: detection.label }),
      ...(detection.source || detection.message
        ? { hint: detection.source ?? detection.message }
        : {}),
    });
  }
  for (const provider of [
    ...providers,
    ...resolveManifestSetupMigrationProviders(params.baseConfig),
  ]) {
    addOption({
      providerId: provider.providerId,
      label: t("wizard.migration.importFrom", { source: provider.label }),
      hint: provider.description ?? t("wizard.migration.sourcePathHint"),
    });
  }

  return options;
}

async function selectSetupMigrationProvider(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
  providerDescriptors?: readonly SetupMigrationProviderDescriptor[];
  prompter: WizardPrompter;
  allowBack: boolean;
}): Promise<string | undefined> {
  const options = await listSetupMigrationOptions({
    baseConfig: params.baseConfig,
    detections: params.detections,
    providerDescriptors: params.providerDescriptors,
  });
  const requestedProviderId = params.opts.importFrom?.trim();
  if (requestedProviderId) {
    return assertListedMigrationProvider(requestedProviderId, options);
  }
  if (options.length === 0) {
    throw new Error("No migration providers found.");
  }
  const prompt = {
    message: t("wizard.migration.source"),
    options: options.map((option) => ({
      value: option.providerId,
      label: option.label,
      ...(option.hint ? { hint: option.hint } : {}),
    })),
    initialValue: params.detections[0]?.providerId ?? options[0]?.providerId,
  };
  if (!params.allowBack) {
    params.prompter.disableBackNavigation?.();
    return assertListedMigrationProvider(await params.prompter.select(prompt), options);
  }
  const selection = await runWizardWithPromptNavigationScope(
    params.prompter,
    async (prompter) => await prompter.select(prompt),
  );
  if (selection.status === "back") {
    return undefined;
  }
  return assertListedMigrationProvider(selection.value, options);
}

/** Undefined means cancellation; unknown ids receive the same guidance as `openclaw migrate`. */
function assertListedMigrationProvider(
  providerId: string | undefined,
  options: readonly SetupMigrationOption[],
): string | undefined {
  if (providerId === undefined || options.some((option) => option.providerId === providerId)) {
    return providerId;
  }
  const available = options.map((option) => option.providerId);
  const suffix =
    available.length > 0
      ? ` Available providers: ${available.join(", ")}.`
      : " No migration providers are installed.";
  const listCommand = formatCliCommand("openclaw migrate list");
  throw new Error(
    `Unknown migration provider "${providerId}".${suffix} Run ${listCommand} to see the current list.`,
  );
}

async function withSetupMigrationProvider<T>(
  providerId: string,
  config: OpenClawConfig,
  run: (provider: MigrationProviderPlugin) => Promise<T>,
): Promise<T> {
  const { withPluginMigrationProviders } = await import("../plugins/migration-provider-runtime.js");
  return await withPluginMigrationProviders({ cfg: config, providerId }, async (providers) => {
    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider) {
      throw new Error(`Migration provider "${providerId}" did not register after activation.`);
    }
    return await run(provider);
  });
}

async function createSetupMigrationPlan(params: {
  provider: MigrationProviderPlugin;
  ctx: MigrationProviderContext;
  importSecrets: boolean;
  nonInteractive: boolean;
  prompter: WizardPrompter;
}): Promise<{ ctx: MigrationProviderContext; plan: MigrationPlan }> {
  let ctx = { ...params.ctx, includeSecrets: params.importSecrets };
  let plan = await params.provider.plan(ctx);
  if (
    params.nonInteractive ||
    params.importSecrets ||
    !plan.items.some(
      (item) => item.kind === "auth" || item.kind === "secret" || item.sensitive === true,
    )
  ) {
    return { ctx, plan };
  }
  const includeSecrets = await params.prompter.confirm({
    message: t("wizard.migration.includeCredentials"),
    initialValue: true,
  });
  if (!includeSecrets) {
    return { ctx, plan };
  }
  ctx = { ...ctx, includeSecrets: true };
  plan = await params.provider.plan(ctx);
  return { ctx, plan };
}

export async function runSetupMigrationImport(params: {
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  detections: readonly SetupMigrationDetection[];
  providerDescriptors?: readonly SetupMigrationProviderDescriptor[];
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  readConfigFile: () => Promise<OpenClawConfig>;
  commitConfigFile: (
    config: OpenClawConfig,
    expectedConfig: OpenClawConfig,
  ) => Promise<OpenClawConfig>;
  allowProviderBack?: boolean;
  continueOnboarding?: boolean;
}): Promise<{ kind: "back" } | Awaited<ReturnType<typeof finalizeSetupMigrationPromotion>>> {
  const [
    { applyLocalSetupWorkspaceConfig, applySkipBootstrapConfig },
    { createMigrationLogger, buildMigrationReportDir },
    { assertApplySucceeded, assertConflictFreePlan, formatMigrationPreview, formatMigrationResult },
    { resolveStateDir },
    onboardHelpers,
  ] = await Promise.all([
    import("../commands/onboard-config.js"),
    import("../commands/migrate/context.js"),
    import("../commands/migrate/output.js"),
    import("../config/paths.js"),
    import("../commands/onboard-helpers.js"),
  ]);
  const providerId = await selectSetupMigrationProvider({
    opts: params.opts,
    baseConfig: params.baseConfig,
    detections: params.detections,
    providerDescriptors: params.providerDescriptors,
    prompter: params.prompter,
    allowBack: params.allowProviderBack === true,
  });
  if (!providerId) {
    return { kind: "back" };
  }
  params.prompter.disableBackNavigation?.();
  const workspaceInput =
    params.opts.workspace ??
    (params.opts.nonInteractive
      ? (params.baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE)
      : await params.prompter.text({
          message: t("wizard.migration.targetWorkspace"),
          initialValue:
            params.baseConfig.agents?.defaults?.workspace ?? onboardHelpers.DEFAULT_WORKSPACE,
        }));
  const workspaceDir = resolveUserPath(workspaceInput.trim() || onboardHelpers.DEFAULT_WORKSPACE);
  const stateDir = resolveStateDir();
  return await withSetupMigrationTargetLock(stateDir, async () => {
    const promotionResume = await recoverSetupMigrationPromotion({
      stateDir,
      providerId,
      readConfigFile: params.readConfigFile,
    });
    if (promotionResume) {
      const committedConfig = await params.readConfigFile();
      return await withSetupMigrationProvider(providerId, committedConfig, async (provider) => {
        assertDeferredMigrationApplyContract(provider, promotionResume.continuation.plan);
        return await finalizeSetupMigrationPromotion({
          provider,
          resume: promotionResume,
          config: committedConfig,
          stateDir,
          logger: createMigrationLogger(params.runtime),
          prompter: params.prompter,
          formatMigrationResult,
        });
      });
    }
    const lockedBaseConfig = preserveSetupMigrationOnboardingConsents(
      await params.readConfigFile(),
      params.baseConfig,
    );
    const freshness = await inspectSetupMigrationFreshness({
      baseConfig: lockedBaseConfig,
      stateDir,
      workspaceDir,
    });
    assertFreshSetupMigrationTarget(freshness);
    return await withSetupMigrationProvider(providerId, lockedBaseConfig, async (provider) => {
      const planningBaseConfig = await params.readConfigFile();
      const planningTargetSnapshotHash = await buildSetupMigrationTargetSnapshot({
        config: planningBaseConfig,
        stateDir,
        workspaceDir,
      });
      const migrationLogger = createMigrationLogger(params.runtime);
      let detection = params.detections.find((entry) => entry.providerId === providerId);
      if (!detection) {
        detection = await detectSetupMigrationSource(provider, {
          config: lockedBaseConfig,
          stateDir,
          logger: migrationLogger,
        });
      }
      let sourceDir =
        params.opts.importSource?.trim() ||
        detection?.source ||
        (providerId === "hermes" ? "~/.hermes" : "");
      if (!sourceDir) {
        if (params.opts.nonInteractive) {
          throw new Error("--import-source is required for non-interactive migration import.");
        }
        sourceDir = await params.prompter.text({
          message: t("wizard.migration.sourceAgentHome"),
          initialValue: providerId === "hermes" ? "~/.hermes" : undefined,
        });
      }
      let targetConfig = applyLocalSetupWorkspaceConfig(lockedBaseConfig, workspaceDir);
      if (params.opts.skipBootstrap) {
        targetConfig = applySkipBootstrapConfig(targetConfig);
      }
      const { ctx, plan } = await createSetupMigrationPlan({
        provider,
        ctx: {
          config: targetConfig,
          stateDir,
          source: sourceDir,
          overwrite: false,
          logger: migrationLogger,
        },
        importSecrets: Boolean(params.opts.importSecrets),
        nonInteractive: Boolean(params.opts.nonInteractive),
        prompter: params.prompter,
      });
      const plannedSourceSnapshotHash = await buildSetupMigrationPlanSourceSnapshot(plan);
      assertDeferredMigrationApplyContract(provider, plan);
      await params.prompter.note(
        formatMigrationPreview(plan).join("\n"),
        t("wizard.migration.previewTitle"),
      );
      assertConflictFreePlan(plan, providerId);

      const confirmed =
        params.opts.nonInteractive === true
          ? true
          : await params.prompter.confirm({
              message: t("wizard.migration.apply"),
              initialValue: true,
            });
      if (!confirmed) {
        throw new WizardCancelledError(t("wizard.migration.cancelled"));
      }

      targetConfig = onboardHelpers.applyWizardMetadata(targetConfig, {
        command: "onboard",
        mode: "local",
      });
      await prepareSetupMigrationAttemptBoundary({
        currentConfig: await params.readConfigFile(),
        stateDir,
        workspaceDir,
        plan,
        expectedTargetSnapshotHash: planningTargetSnapshotHash,
        expectedSourceSnapshotHash: plannedSourceSnapshotHash,
      });
      const reportDir = buildMigrationReportDir(providerId, stateDir);
      const stage = await createSetupMigrationStage({
        providerId,
        stateDir,
        workspaceDir,
        reportDir,
        targetConfig,
      });
      try {
        const stagedPlan = stage.projectPlanToStage(
          buildSetupMigrationPhasePlan(plan, "before-promotion"),
        );
        const stagedRuntime = ctx.runtime
          ? {
              ...ctx.runtime,
              config: {
                ...ctx.runtime.config,
                current: stage.configRuntime.current,
                mutateConfigFile: stage.configRuntime.mutateConfigFile,
                replaceConfigFile: async () => {
                  throw new Error(
                    "Full config replacement is unavailable during staged migration.",
                  );
                },
              },
            }
          : undefined;
        const stagedResult = await provider.apply(
          {
            ...ctx,
            ...(stagedRuntime ? { runtime: stagedRuntime } : {}),
            config: stage.getStagedConfig(),
            configRuntime: stage.configRuntime,
            stateDir: stage.staged.stateDir,
            reportDir: stage.staged.reportDir,
          },
          stagedPlan,
        );
        assertApplySucceeded(stagedResult);
        const projectedStagedResult = stage.projectResultToFinal(stagedResult);

        let outcome: SetupMigrationPromotionOutcome = { kind: "no-imported-inference" };
        if (resolveAgentModelPrimaryValue(stage.getStagedConfig().agents?.defaults?.model)) {
          const verification = await offerLiveModelVerification({
            config: stage.getStagedConfig(),
            opts: params.opts,
            prompter: params.prompter,
            runtime: params.runtime,
            agentDir: stage.staged.agentDir,
            stateDir: stage.staged.stateDir,
            configTarget: stage.inferenceConfigTarget,
            required: true,
          });
          if (!verification.verified || !verification.modelRef) {
            throw new Error("Imported inference was not verified.");
          }
          stage.replaceStagedConfig(verification.config);
          outcome = { kind: "verified-inference", modelRef: verification.modelRef };
        }

        const [currentTargetSnapshotHash, currentSourceSnapshotHash] = await Promise.all([
          buildSetupMigrationTargetSnapshot({
            config: await params.readConfigFile(),
            stateDir,
            workspaceDir,
          }),
          buildSetupMigrationPlanSourceSnapshot(plan),
        ]);
        if (currentTargetSnapshotHash !== planningTargetSnapshotHash) {
          throw new SetupMigrationTargetChangedError(
            "Migration target changed before promotion. Review it and retry.",
          );
        }
        if (currentSourceSnapshotHash !== plannedSourceSnapshotHash) {
          throw new Error("Migration source changed before promotion. Review it and retry.");
        }

        const promoted = await stage.promote({
          expectedConfig: planningBaseConfig,
          continuation: {
            providerLabel: provider.label,
            ...(ctx.source ? { source: ctx.source } : {}),
            ...(ctx.includeSecrets !== undefined ? { includeSecrets: ctx.includeSecrets } : {}),
            ...(ctx.providerOptions ? { providerOptions: ctx.providerOptions } : {}),
            plan,
            stagedResult: projectedStagedResult,
            outcome,
            continueOnboarding: params.continueOnboarding === true,
          },
          readConfigFile: params.readConfigFile,
          commitConfigFile: params.commitConfigFile,
        });
        return await finalizeSetupMigrationPromotion({
          provider,
          resume: promoted.resume,
          config: promoted.config,
          stateDir,
          logger: migrationLogger,
          prompter: params.prompter,
          formatMigrationResult,
        });
      } finally {
        await stage.cleanup();
      }
    });
  });
}
