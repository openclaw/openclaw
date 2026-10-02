import { isMainThread } from "node:worker_threads";
import { loadDotEnvAsync } from "../infra/dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withSynchronousArtifactPreservingStateSnapshot } from "../state/openclaw-state-db-readonly.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { applyImplicitAgentRosterDefaults } from "./implicit-agent-roster.js";
import type { ConfigIoContext } from "./io.context.js";
import {
  resolveConfigIoEffect,
  runConfigIoAsync,
  runConfigIoSync,
  type ConfigIoOperation,
} from "./io.effects.js";
import { throwInvalidConfig } from "./io.invalid-config.js";
import {
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
} from "./io.observe-recovery.js";
import {
  coerceConfig,
  containsConfigIncludeDirective,
  hashConfigRaw,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
} from "./io.read-helpers.js";
import { maybeLoadDotEnvForConfig } from "./io.runtime-env.js";
import { materializeConfigSnapshotDefaults } from "./io.snapshot-preparation.js";
import { createConfigFileSnapshot } from "./io.snapshot-shared.js";
import { loggedConfigWarningFingerprints, loggedInvalidConfigs } from "./io.state.js";
import {
  logConfigWarningsOnce,
  warnIfConfigFromFuture,
  warnOnConfigMiskeys,
} from "./io.warnings.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { OpenClawConfig } from "./types.js";
import {
  validateConfigObjectWithPlugins,
  validateConfigObjectWithPluginsAsync,
} from "./validation.js";

type ConfigLoadOptions = { skipSuspiciousRecovery?: boolean; assertCurrent?: () => void };

export function loadConfigFromContext(
  context: ConfigIoContext,
  options: ConfigLoadOptions = {},
): OpenClawConfig {
  return runConfigIoSync(loadConfigWithEffects(context, options), options.assertCurrent);
}

export async function loadConfigFromContextAsync(
  context: ConfigIoContext,
  options: ConfigLoadOptions = {},
): Promise<OpenClawConfig> {
  // SDK callers already inside a worker use the same effects without a host broker.
  if (!isMainThread) {
    return loadConfigFromContext(context, options);
  }
  return await runConfigIoAsync(loadConfigWithEffects(context, options), options.assertCurrent);
}

function* loadConfigWithEffects(
  context: ConfigIoContext,
  options: ConfigLoadOptions,
): ConfigIoOperation<OpenClawConfig> {
  const { deps, configPath, pathResolution } = context;
  let envBeforeRead: Record<string, string | undefined> | undefined;
  try {
    yield* resolveConfigIoEffect({
      sync: () => maybeLoadDotEnvForConfig(deps.env),
      async: async () => {
        if (deps.env === process.env) {
          await loadDotEnvAsync({ env: deps.env, quiet: true });
        }
      },
    });
    envBeforeRead = snapshotEnv(deps.env);
    const exists = yield* resolveConfigIoEffect({
      sync: () => deps.fs.existsSync(configPath),
      async: () =>
        deps.fs.promises.access(configPath).then(
          () => true,
          () => false,
        ),
    });
    if (!exists) {
      loggedConfigWarningFingerprints.delete(configPath);
      // A missing config is the fresh-install default path: materialize the
      // same runtime defaults an empty {} config gets, or out-of-box behavior
      // (compaction safeguard, session/cron defaults) silently diverges.
      const config = coerceConfig(applyImplicitAgentRosterDefaults({}));
      const metadata = context.createValidationPluginMetadataSnapshotLoader({
        env: deps.env,
      });
      const materialized = yield* resolveConfigIoEffect({
        sync: () => materializeConfigSnapshotDefaults(context, config, metadata),
        async: async () =>
          materializeRuntimeConfig(config, {
            ...pathResolution,
            manifestRegistry:
              context.options.pluginValidation === "core-only"
                ? { plugins: [] }
                : (await metadata.loadAsync(config)).manifestRegistry,
          }),
      });
      return yield* resolveConfigIoEffect({
        sync: () => context.finalizeLoadedRuntimeConfig(materialized),
        async: () =>
          context.finalizeLoadedRuntimeConfigAsync(materialized, metadata, options.assertCurrent),
      });
    }
    const raw = yield* resolveConfigIoEffect({
      sync: () => deps.fs.readFileSync(configPath, "utf-8"),
      async: () => deps.fs.promises.readFile(configPath, "utf-8"),
    });
    const parsed = deps.json5.parse(raw);
    const readResolution = resolveConfigForRead(
      resolveConfigIncludesForRead(parsed, configPath, deps),
      deps.env,
      deps.lowerPrecedenceEnv,
    );
    const effectiveConfigRaw = applyImplicitAgentRosterDefaults(readResolution.resolvedConfigRaw);
    const hash = hashConfigRaw(raw);
    for (const warning of readResolution.envWarnings) {
      deps.logger.warn(
        `Config (${configPath}): missing env var "${warning.varName}" at ${warning.configPath} - feature using this value will be unavailable`,
      );
    }
    warnOnConfigMiskeys(effectiveConfigRaw, deps.logger);
    // A scalar/null root (truncated or clobbered file) must fail validation
    // below like any invalid config — never load as an empty config marked
    // valid, which would run with defaults and poison lastKnownGood.
    if (typeof effectiveConfigRaw === "object" && effectiveConfigRaw !== null) {
      const duplicates = findDuplicateAgentDirs(
        effectiveConfigRaw as OpenClawConfig,
        pathResolution,
      );
      if (duplicates.length > 0) {
        throw new DuplicateAgentDirError(duplicates);
      }
    }
    const pluginMetadata = context.createValidationPluginMetadataSnapshotLoader({
      env: deps.env,
    });
    const validationParams = {
      ...pathResolution,
      pluginValidation: context.options.pluginValidation,
      sourceRaw: parsed,
      preservedLegacyRootKeys: context.options.preservedLegacyRootKeys,
    };
    const { deferredPluginMigrations, validated } = yield* resolveConfigIoEffect({
      sync: () =>
        withSynchronousArtifactPreservingStateSnapshot(() => {
          const pending = context.resolveDeferredPluginMigrations();
          return {
            deferredPluginMigrations: pending,
            validated: validateConfigObjectWithPlugins(effectiveConfigRaw, {
              ...validationParams,
              deferredPluginMigrations: pending,
              loadPluginMetadataSnapshot: pluginMetadata.load,
            }),
          };
        }),
      async: async () => {
        const pending = await context.resolveDeferredPluginMigrationsAsync();
        return {
          deferredPluginMigrations: pending,
          validated: await validateConfigObjectWithPluginsAsync(effectiveConfigRaw, {
            ...validationParams,
            deferredPluginMigrations: pending,
            loadPluginMetadataSnapshotAsync: pluginMetadata.loadAsync,
          }),
        };
      },
    });
    if (!validated.ok) {
      const invalidSnapshot = createConfigFileSnapshot({
        path: configPath,
        exists: true,
        raw,
        parsed,
        sourceConfig: coerceConfig(effectiveConfigRaw),
        valid: false,
        runtimeConfig: coerceConfig(effectiveConfigRaw),
        hash,
        issues: validated.issues,
        deferredPluginMigrations,
        warnings: validated.warnings,
        resolutionFacts: readResolution.resolutionFacts,
        legacyIssues: [],
      });
      yield* resolveConfigIoEffect({
        sync: () => context.observeLoadConfigSnapshot(invalidSnapshot),
        async: () => context.observeLoadConfigSnapshotAsync(invalidSnapshot, options.assertCurrent),
      });
      throwInvalidConfig({
        configPath,
        issues: validated.issues,
        logger: deps.logger,
        loggedConfigPaths: loggedInvalidConfigs,
      });
    }
    if (context.options.pluginValidation !== "skip") {
      logConfigWarningsOnce({ configPath, warnings: validated.warnings, logger: deps.logger });
    }
    if (!deps.suppressFutureVersionWarning) {
      warnIfConfigFromFuture(validated.config, deps.logger);
    }
    if (
      deps.observe &&
      !options.skipSuspiciousRecovery &&
      !containsConfigIncludeDirective(parsed)
    ) {
      const recoveryParams = {
        deps,
        configPath,
        raw,
        parsed,
        prepareBackup: context.prepareRecoveryBackupCandidate,
      };
      const recovery = yield* resolveConfigIoEffect({
        sync: () => maybeRecoverSuspiciousConfigReadSync(recoveryParams),
        async: () =>
          maybeRecoverSuspiciousConfigRead({
            ...recoveryParams,
            prepareBackupAsync: context.prepareRecoveryBackupCandidateAsync,
            assertCurrent: options.assertCurrent,
          }),
      });
      if (recovery.raw !== raw) {
        restoreEnvChangesIfUnchanged({
          env: deps.env,
          before: envBeforeRead,
          after: snapshotEnv(deps.env),
        });
        return yield* loadConfigWithEffects(context, { ...options, skipSuspiciousRecovery: true });
      }
    }
    const cfg = materializeRuntimeConfig(validated.config, {
      ...pathResolution,
      manifestRegistry:
        context.options.pluginValidation === "core-only"
          ? { plugins: [] }
          : pluginMetadata.getSnapshot()?.manifestRegistry,
    });
    const snapshot = createConfigFileSnapshot({
      path: configPath,
      exists: true,
      raw,
      parsed,
      sourceConfig: coerceConfig(effectiveConfigRaw),
      valid: true,
      runtimeConfig: cfg,
      deferredPluginMigrations,
      hash,
      issues: [],
      warnings: validated.warnings,
      resolutionFacts: readResolution.resolutionFacts,
      legacyIssues: [],
    });
    yield* resolveConfigIoEffect({
      sync: () => context.observeLoadConfigSnapshot(snapshot),
      async: () => context.observeLoadConfigSnapshotAsync(snapshot, options.assertCurrent),
    });
    return yield* resolveConfigIoEffect({
      sync: () => context.finalizeLoadedRuntimeConfig(cfg),
      async: () =>
        context.finalizeLoadedRuntimeConfigAsync(cfg, pluginMetadata, options.assertCurrent),
    });
  } catch (error) {
    // Failed reads must not publish env.vars. The snapshot stays undefined only
    // when dotenv loading fails before config-owned environment mutation begins.
    if (envBeforeRead) {
      restoreEnvChangesIfUnchanged({
        env: deps.env,
        before: envBeforeRead,
        after: snapshotEnv(deps.env),
      });
    }
    if (error instanceof DuplicateAgentDirError) {
      deps.logger.error(error.message);
      throw error;
    }
    if ((error as { code?: string })?.code === "INVALID_CONFIG") {
      throw error;
    }
    deps.logger.error(`Failed to read config at ${configPath}: ${formatErrorMessage(error)}`);
    throw error;
  }
}
