import { loadDotEnvAsync } from "../infra/dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withSynchronousArtifactPreservingStateSnapshot } from "../state/openclaw-state-db-readonly.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import type { ConfigIoContext } from "./io.context.js";
import { throwInvalidConfig } from "./io.invalid-config.js";
import {
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
} from "./io.observe-recovery.js";
import {
  coerceConfig,
  containsConfigIncludeDirective,
  hashConfigRaw,
  maybeLoadDotEnvForConfig,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
} from "./io.read-helpers.js";
import { createConfigFileSnapshot } from "./io.snapshot-shared.js";
import { loggedConfigWarningFingerprints, loggedInvalidConfigs } from "./io.state.js";
import {
  logConfigWarningsOnce,
  warnIfConfigFromFuture,
  warnOnConfigMiskeys,
} from "./io.warnings.js";
import { migrateLegacyContextBudgetConfig, migratePersistedImplicitMainRoster } from "./legacy.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { OpenClawConfig } from "./types.js";
import {
  validateConfigObjectWithPlugins,
  validateConfigObjectWithPluginsAsync,
} from "./validation.js";

type ConfigLoadEffect = {
  sync: () => void;
  async: () => Promise<void>;
};

type ConfigLoadOperation<T> = Generator<ConfigLoadEffect, T, void>;

function* resolveConfigLoadEffect<T>(effect: {
  sync: () => T;
  async: () => Promise<T>;
}): ConfigLoadOperation<T> {
  // Each driver completes the yielded effect before resuming this continuation.
  let result!: T;
  yield {
    sync: () => {
      result = effect.sync();
    },
    async: async () => {
      result = await effect.async();
    },
  };
  return result;
}

export function loadConfigFromContext(
  context: ConfigIoContext,
  options: { skipSuspiciousRecovery?: boolean } = {},
): OpenClawConfig {
  const operation = loadConfigWithEffects(context, options);
  let step = operation.next();
  while (!step.done) {
    try {
      step.value.sync();
      step = operation.next();
    } catch (error) {
      step = operation.throw(error);
    }
  }
  return step.value;
}

export async function loadConfigFromContextAsync(
  context: ConfigIoContext,
  options: { skipSuspiciousRecovery?: boolean; assertCurrent?: () => void } = {},
): Promise<OpenClawConfig> {
  const operation = loadConfigWithEffects(context, options);
  let step = operation.next();
  while (!step.done) {
    try {
      options.assertCurrent?.();
      await step.value.async();
      options.assertCurrent?.();
      step = operation.next();
    } catch (error) {
      step = operation.throw(error);
    }
  }
  return step.value;
}

function* loadConfigWithEffects(
  context: ConfigIoContext,
  options: { skipSuspiciousRecovery?: boolean; assertCurrent?: () => void },
): ConfigLoadOperation<OpenClawConfig> {
  const { deps, configPath, pathResolution } = context;
  let envBeforeRead: Record<string, string | undefined> | undefined;
  try {
    yield* resolveConfigLoadEffect({
      sync: () => maybeLoadDotEnvForConfig(deps.env),
      async: async () => {
        if (deps.env === process.env) {
          await loadDotEnvAsync({ env: deps.env, quiet: true });
        }
      },
    });
    envBeforeRead = snapshotEnv(deps.env);
    const exists = yield* resolveConfigLoadEffect({
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
      const config = coerceConfig(migratePersistedImplicitMainRoster({}).config);
      const metadata = context.createValidationPluginMetadataSnapshotLoader({
        effectiveConfigRaw: config,
        env: deps.env,
      });
      const materialized = yield* resolveConfigLoadEffect({
        sync: () =>
          materializeRuntimeConfig(config, {
            ...pathResolution,
            ...(context.options.pluginValidation === "core-only"
              ? { manifestRegistry: { plugins: [] } }
              : { loadManifestRegistry: () => metadata.load(config).manifestRegistry }),
          }),
        async: async () =>
          materializeRuntimeConfig(config, {
            ...pathResolution,
            manifestRegistry:
              context.options.pluginValidation === "core-only"
                ? { plugins: [] }
                : (await metadata.loadAsync(config)).manifestRegistry,
          }),
      });
      return yield* resolveConfigLoadEffect({
        sync: () => context.finalizeLoadedRuntimeConfig(materialized),
        async: () =>
          context.finalizeLoadedRuntimeConfigAsync(materialized, metadata, options.assertCurrent),
      });
    }
    const raw = yield* resolveConfigLoadEffect({
      sync: () => deps.fs.readFileSync(configPath, "utf-8"),
      async: () => deps.fs.promises.readFile(configPath, "utf-8"),
    });
    const parsed = deps.json5.parse(raw);
    const readResolution = resolveConfigForRead(
      resolveConfigIncludesForRead(parsed, configPath, deps),
      deps.env,
      deps.lowerPrecedenceEnv,
    );
    const contextBudgetMigration = migrateLegacyContextBudgetConfig(
      readResolution.resolvedConfigRaw,
    );
    const rosterMigration = migratePersistedImplicitMainRoster(contextBudgetMigration.config, {
      env: deps.env,
      homedir: deps.homedir,
    });
    const effectiveConfigRaw = rosterMigration.config;
    const validationConfigRaw = effectiveConfigRaw;
    const snapshotRaw = raw;
    const snapshotParsed = parsed;
    const hash = hashConfigRaw(snapshotRaw);
    for (const warning of readResolution.envWarnings) {
      deps.logger.warn(
        `Config (${configPath}): missing env var "${warning.varName}" at ${warning.configPath} - feature using this value will be unavailable`,
      );
    }
    for (const diagnostic of [
      ...contextBudgetMigration.changes.map(({ message }) => message),
      ...contextBudgetMigration.warnings.map(({ message }) => message),
      ...rosterMigration.diagnostics,
    ]) {
      deps.logger.warn(`Config (${configPath}): ${diagnostic}`);
    }
    warnOnConfigMiskeys(validationConfigRaw, deps.logger);
    // A scalar/null root (truncated or clobbered file) must fail validation
    // below like any invalid config — never load as an empty config marked
    // valid, which would run with defaults and poison lastKnownGood.
    if (typeof validationConfigRaw === "object" && validationConfigRaw !== null) {
      const duplicates = findDuplicateAgentDirs(
        validationConfigRaw as OpenClawConfig,
        pathResolution,
      );
      if (duplicates.length > 0) {
        throw new DuplicateAgentDirError(duplicates);
      }
    }
    const pluginMetadata = context.createValidationPluginMetadataSnapshotLoader({
      effectiveConfigRaw,
      env: deps.env,
    });
    const validationParams = {
      ...pathResolution,
      pluginValidation: context.options.pluginValidation,
      sourceRaw: snapshotParsed,
      preservedLegacyRootKeys: context.options.preservedLegacyRootKeys,
    };
    const { deferredPluginMigrations, validated } = yield* resolveConfigLoadEffect({
      sync: () =>
        withSynchronousArtifactPreservingStateSnapshot(() => {
          const pending = context.resolveDeferredPluginMigrations();
          return {
            deferredPluginMigrations: pending,
            validated: validateConfigObjectWithPlugins(validationConfigRaw, {
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
          validated: await validateConfigObjectWithPluginsAsync(validationConfigRaw, {
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
        raw: snapshotRaw,
        parsed: snapshotParsed,
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
      yield* resolveConfigLoadEffect({
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
      const recovery = yield* resolveConfigLoadEffect({
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
          : pluginMetadata.getManifestRegistry(),
    });
    const snapshot = createConfigFileSnapshot({
      path: configPath,
      exists: true,
      raw: snapshotRaw,
      parsed: snapshotParsed,
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
    yield* resolveConfigLoadEffect({
      sync: () => context.observeLoadConfigSnapshot(snapshot),
      async: () => context.observeLoadConfigSnapshotAsync(snapshot, options.assertCurrent),
    });
    return yield* resolveConfigLoadEffect({
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
