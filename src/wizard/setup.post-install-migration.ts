import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  readMigrationConfigPatchDetails,
  writeMigrationConfigPath,
} from "../plugin-sdk/migration.js";
import type { MigrationPlan, MigrationProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

type PostInstallMigrationOptions = {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter?: WizardPrompter;
  // Only newly installed plugins may trigger migration offers.
  installedPluginIds: readonly string[];
  nonInteractive?: boolean;
};

type ResolvedProviderCandidate = {
  provider: MigrationProviderPlugin;
  source?: string;
};

async function resolveCandidates(params: {
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  installedPluginIds: readonly string[];
  providers: readonly MigrationProviderPlugin[];
}): Promise<ResolvedProviderCandidate[]> {
  const [
    { resolveManifestContractRuntimePluginResolution },
    { createMigrationLogger },
    { resolveStateDir },
  ] = await Promise.all([
    import("../plugins/manifest-contract-runtime.js"),
    import("../commands/migrate/context.js"),
    import("../config/paths.js"),
  ]);
  const installedIds = new Set(params.installedPluginIds);
  const stateDir = resolveStateDir();
  const logger = createMigrationLogger(params.runtime);
  const candidates: ResolvedProviderCandidate[] = [];
  for (const provider of params.providers) {
    if (!provider.detect) {
      continue;
    }
    const ownership = resolveManifestContractRuntimePluginResolution({
      cfg: params.config,
      contract: "migrationProviders",
      value: provider.id,
    });
    if (!ownership.pluginIds.some((pluginId) => installedIds.has(pluginId))) {
      continue;
    }
    try {
      const detection = await provider.detect({
        config: params.config,
        stateDir,
        logger,
      });
      if (!detection.found || detection.confidence === "low") {
        continue;
      }
      candidates.push({
        provider,
        ...(detection.source ? { source: detection.source } : {}),
      });
    } catch (error) {
      logger.debug?.(
        `Post-install migration detect for ${provider.id} failed: ${formatErrorMessage(error)}`,
      );
    }
  }
  return candidates;
}

function describeCandidate(candidate: ResolvedProviderCandidate): string {
  return `${candidate.provider.label}${candidate.source ? ` at ${candidate.source}` : ""}`;
}

function logMigrationHint(runtime: RuntimeEnv, candidate: ResolvedProviderCandidate): void {
  const command = formatCliCommand(`openclaw migrate ${candidate.provider.id} --dry-run`);
  runtime.log(`Detected ${describeCandidate(candidate)}. Preview migration with ${command}.`);
}

function applyMigrationConfigPatches(
  config: OpenClawConfig,
  result: MigrationPlan | undefined,
): OpenClawConfig {
  let nextConfig = config;
  for (const item of result?.items ?? []) {
    if (item?.kind !== "config" || item.action !== "merge" || item.status !== "migrated") {
      continue;
    }
    const patch = readMigrationConfigPatchDetails(item);
    if (!patch) {
      continue;
    }
    if (nextConfig === config) {
      nextConfig = structuredClone(config);
    }
    writeMigrationConfigPath(nextConfig as Record<string, unknown>, patch.path, patch.value);
  }
  return nextConfig;
}

/** Offers migration for newly installed plugins; the migrate command owns import consent. */
export async function offerPostInstallMigrations(
  params: PostInstallMigrationOptions,
): Promise<{ config: OpenClawConfig }> {
  if (params.installedPluginIds.length === 0) {
    return { config: params.config };
  }
  const { withPluginMigrationProviders } = await import("../plugins/migration-provider-runtime.js");
  return await withPluginMigrationProviders(
    {
      cfg: params.config,
      onCleanupError: (error) => {
        params.runtime.log(
          `Post-install migration result retained, but plugin cleanup failed: ${formatErrorMessage(error)}`,
        );
      },
    },
    async (providers) => await runPostInstallMigrationOffers(params, providers),
  );
}

async function runPostInstallMigrationOffers(
  params: PostInstallMigrationOptions,
  providers: readonly MigrationProviderPlugin[],
): Promise<{ config: OpenClawConfig }> {
  const candidates = await resolveCandidates({
    providers,
    config: params.config,
    runtime: params.runtime,
    installedPluginIds: params.installedPluginIds,
  });
  if (candidates.length === 0) {
    return { config: params.config };
  }
  let nextConfig = params.config;
  const prompter = params.prompter;
  const interactive =
    params.nonInteractive !== true && process.stdin.isTTY && prompter !== undefined;
  for (const candidate of candidates) {
    if (!interactive || !prompter) {
      logMigrationHint(params.runtime, candidate);
      continue;
    }
    const description = describeCandidate(candidate);
    let accepted;
    try {
      await prompter.note(
        [
          candidate.provider.description,
          "You will review import options and confirm before applying.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        `${candidate.provider.label} migration`,
      );
      accepted = await prompter.confirm({
        message: `Review migration from ${description}?`,
        initialValue: false,
      });
    } catch (error) {
      // Prompt cancellations / non-TTY refusals fall back to the hint path so
      // onboarding never aborts on an optional offer.
      params.runtime.log(
        `Skipping ${candidate.provider.label} migration prompt: ${formatErrorMessage(error)}`,
      );
      logMigrationHint(params.runtime, candidate);
      continue;
    }
    if (!accepted) {
      logMigrationHint(params.runtime, candidate);
      continue;
    }
    const logFailure = (error: unknown) => {
      params.runtime.log(
        `${candidate.provider.label} migration failed: ${formatErrorMessage(error)}. ` +
          `Re-run with ${formatCliCommand(`openclaw migrate ${candidate.provider.id} --dry-run`)} to inspect.`,
      );
    };
    let disposingPreparation = false;
    let resultRetained = false;
    try {
      const [{ migrateDefaultCommand }, { createMigrationLogger }, { resolveStateDir }] =
        await Promise.all([
          import("../commands/migrate.js"),
          import("../commands/migrate/context.js"),
          import("../config/paths.js"),
        ]);
      const runCommand = async (provider: MigrationProviderPlugin) => {
        let preparation: Awaited<ReturnType<NonNullable<MigrationProviderPlugin["prepareApply"]>>>;
        try {
          preparation = await provider.prepareApply?.({
            config: nextConfig,
            stateDir: resolveStateDir(),
            logger: createMigrationLogger(params.runtime),
            ...(candidate.source ? { source: candidate.source } : {}),
            providerOptions: { configPatchMode: "return" },
          });
          const result = await migrateDefaultCommand(
            params.runtime,
            {
              provider: provider.id,
              configOverride: nextConfig,
              configPatchMode: "return",
              suppressPlanLog: true,
            },
            provider,
          );
          nextConfig = applyMigrationConfigPatches(nextConfig, result);
          resultRetained = true;
        } catch (error) {
          logFailure(error);
        } finally {
          disposingPreparation = true;
          await preparation?.dispose?.();
          disposingPreparation = false;
        }
      };
      if (nextConfig === params.config) {
        await runCommand(candidate.provider);
      } else {
        const { withMigrationProvider } = await import("../commands/migrate/providers.js");
        await withMigrationProvider(candidate.provider.id, nextConfig, runCommand);
      }
    } catch (error) {
      // Preparation cleanup failures must still abort the caller, not become optional-offer hints.
      if (disposingPreparation) {
        throw error;
      }
      if (resultRetained) {
        params.runtime.log(
          `${candidate.provider.label} migration result retained, but plugin cleanup failed: ${formatErrorMessage(error)}`,
        );
      } else {
        logFailure(error);
      }
    }
  }
  return { config: nextConfig };
}
