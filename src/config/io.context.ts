import {
  readDeferredPluginMigrations,
  readDeferredPluginMigrationsAsync,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
} from "../infra/shell-env.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-record-reader.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withSynchronousArtifactPreservingStateSnapshot } from "../state/openclaw-state-db-readonly.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { applyConfigEnvVars, cloneEnvWithPlatformSemantics } from "./config-env-vars.js";
import { ConfigIncludeError, ConfigIncludeReadError } from "./includes.js";
import {
  resolveConfigIoEffect,
  runConfigIoAsync,
  runConfigIoSync,
  type ConfigIoOperation,
} from "./io.effects.js";
import { isInvalidConfigError } from "./io.invalid-config.js";
import { observeConfigSnapshot, observeConfigSnapshotSync } from "./io.observe.js";
import {
  resolveConfigWidePluginMetadataSnapshot,
  resolveConfigWidePluginMetadataSnapshotAsync,
} from "./io.plugin-metadata.js";
import {
  coerceConfig,
  normalizeConfigIoDeps,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  resolveConfigPathForDeps,
} from "./io.read-helpers.js";
import type {
  ConfigIoFactoryOptions,
  ConfigRecoveryCandidate,
  ConfigRecoveryCandidatePreparation,
} from "./io.types.js";
import { formatConfigIssueSummary } from "./issue-format.js";
import { migrateLegacyContextBudgetConfig } from "./legacy.context-budget.js";
import { inheritLegacyDefaultAgentId } from "./legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import { copyConfigResolutionFacts } from "./resolution-facts.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
import {
  validateConfigObjectWithPlugins,
  validateConfigObjectWithPluginsAsync,
} from "./validation.js";
import type { PreparedConfigValidationPluginMetadata } from "./validation.types.js";

export type ConfigRecoveryCandidateTransform = (params: {
  candidate: ConfigRecoveryCandidate;
  configPath: string;
  includeProvenance: NonNullable<ConfigFileSnapshot["includeProvenance"]>;
  resolvedConfig: unknown;
  deferredPluginMigrations: readonly DeferredPluginMigration[];
}) => unknown;

type ValidationPluginMetadataSnapshotLoader = {
  load: (config: OpenClawConfig) => Pick<PluginMetadataSnapshot, "manifestRegistry">;
  loadAsync: (config: OpenClawConfig) => Promise<PreparedConfigValidationPluginMetadata>;
  getSnapshot: () => PluginMetadataSnapshot | undefined;
};

export type ConfigIoContext = ReturnType<typeof createConfigIoContext>;

export function createConfigIoContext(
  options: ConfigIoFactoryOptions = {},
  transformRecoveryCandidate?: ConfigRecoveryCandidateTransform,
) {
  const deps = normalizeConfigIoDeps(options);
  const configPath = resolveConfigPathForDeps(deps);
  // The normalized default homedir already applies OPENCLAW_HOME. Path
  // resolvers need the original OS-home fallback or relative overrides expand twice.
  const pathResolution = { env: deps.env, homedir: options.homedir };

  function resolveDeferredPluginMigrations(): readonly DeferredPluginMigration[] {
    // Core-only admission cannot inspect plugin state before database readiness is known.
    return (
      options.deferredPluginMigrations ??
      (options.pluginValidation === "core-only"
        ? []
        : readDeferredPluginMigrations({
            env: deps.env,
            artifactPreservingReadOnly: !deps.observe,
          }))
    );
  }

  async function resolveDeferredPluginMigrationsAsync(): Promise<
    readonly DeferredPluginMigration[]
  > {
    return (
      options.deferredPluginMigrations ??
      (options.pluginValidation === "core-only"
        ? []
        : readDeferredPluginMigrationsAsync({
            env: deps.env,
            artifactPreservingReadOnly: !deps.observe,
          }))
    );
  }

  function observeLoadConfigSnapshot(snapshot: ConfigFileSnapshot): ConfigFileSnapshot {
    if (deps.observe) {
      observeConfigSnapshotSync(deps, snapshot);
    }
    return snapshot;
  }

  async function observeLoadConfigSnapshotAsync(
    snapshot: ConfigFileSnapshot,
    assertCurrent?: () => void,
  ): Promise<ConfigFileSnapshot> {
    if (deps.observe) {
      await observeConfigSnapshot(deps, snapshot, assertCurrent);
    }
    return snapshot;
  }

  function shouldLoadShellEnv(config: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
    return (
      (shouldEnableShellEnvFallback(env) || config.env?.shellEnv?.enabled === true) &&
      options.shellEnvFallback !== "defer" &&
      !shouldDeferShellEnvFallback(env)
    );
  }

  async function finalizeLoadedRuntimeConfigAsync(
    config: OpenClawConfig,
    metadata: ValidationPluginMetadataSnapshotLoader,
    assertCurrent?: () => void,
  ): Promise<OpenClawConfig> {
    if (!metadata.getSnapshot()) {
      const env = cloneEnvWithPlatformSemantics(deps.env);
      applyConfigEnvVars(config, env);
      if (shouldLoadShellEnv(config, env)) {
        await metadata.loadAsync(config);
      }
    }
    assertCurrent?.();
    const snapshot = metadata.getSnapshot();
    return snapshot
      ? withPluginMetadataSnapshotScope(snapshot, () => finalizeLoadedRuntimeConfig(config), {
          config,
          env: deps.env,
        })
      : finalizeLoadedRuntimeConfig(config);
  }

  function finalizeLoadedRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
    const duplicates = findDuplicateAgentDirs(cfg, pathResolution);
    if (duplicates.length > 0) {
      throw new DuplicateAgentDirError(duplicates);
    }
    applyConfigEnvVars(cfg, deps.env);
    if (shouldLoadShellEnv(cfg, deps.env)) {
      loadShellEnvFallback({
        enabled: true,
        env: deps.env,
        expectedKeys: resolveShellEnvExpectedKeys(deps.env, cfg),
        logger: deps.logger,
        timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(deps.env),
      });
    }
    const finalized = applyConfigOverrides(cfg);
    const inherited = inheritLegacyDefaultAgentId(cfg, finalized);
    copyConfigResolutionFacts(cfg, inherited);
    return inherited;
  }

  function createValidationPluginMetadataSnapshotLoader(params: {
    env: NodeJS.ProcessEnv;
    allowCurrentPluginMetadata?: boolean;
  }): ValidationPluginMetadataSnapshotLoader {
    let snapshot: PluginMetadataSnapshot | undefined;
    let pending: Promise<PreparedConfigValidationPluginMetadata> | undefined;
    return {
      load: (config) => {
        snapshot ??= resolveConfigWidePluginMetadataSnapshot({
          config,
          env: params.env,
          allowCurrent: params.allowCurrentPluginMetadata,
        });
        return { manifestRegistry: snapshot.manifestRegistry };
      },
      loadAsync: (config) =>
        (pending ??= (async () => {
          snapshot ??= await resolveConfigWidePluginMetadataSnapshotAsync({
            config,
            env: params.env,
            allowCurrent: params.allowCurrentPluginMetadata,
          });
          const records = await withPluginCache(getPluginMetadataSnapshotCache(snapshot), () =>
            loadInstalledPluginIndexInstallRecords({ env: params.env }),
          ).catch(() => ({}));
          return {
            manifestRegistry: snapshot.manifestRegistry,
            installedPluginRecordIds: new Set(Object.keys(records)),
          };
        })()),
      getSnapshot: () => snapshot,
    };
  }

  function resolveRuntimePreflightSourceConfig(
    candidate: OpenClawConfig,
    includeFileHashes?: Record<string, string>,
    includeFileTargets?: Record<string, string>,
    baseEnv: NodeJS.ProcessEnv = deps.env,
  ): OpenClawConfig {
    const env = cloneEnvWithPlatformSemantics(baseEnv);
    const resolvedIncludes = resolveConfigIncludesForRead(
      candidate,
      configPath,
      { ...deps, env },
      includeFileHashes,
      includeFileTargets,
    );
    const resolution = resolveConfigForRead(resolvedIncludes, env, deps.lowerPrecedenceEnv);
    const contextBudgetConfig = migrateLegacyContextBudgetConfig(
      resolution.resolvedConfigRaw,
    ).config;
    return coerceConfig(
      migratePersistedImplicitMainRoster(contextBudgetConfig, { env, homedir: deps.homedir })
        .config,
    );
  }

  function* prepareRecoveryBackupCandidateSteps(
    candidate: ConfigRecoveryCandidate,
  ): ConfigIoOperation<ConfigRecoveryCandidatePreparation> {
    try {
      const originalEnv = cloneEnvWithPlatformSemantics(deps.env);
      const includeProvenance: NonNullable<ConfigFileSnapshot["includeProvenance"]>[number][] = [];
      const originalResolvedIncludes = resolveConfigIncludesForRead(
        candidate.parsed,
        configPath,
        { ...deps, env: originalEnv },
        undefined,
        undefined,
        undefined,
        (event) => {
          const { value: _value, ...ownership } = event;
          includeProvenance.push(ownership);
        },
      );
      const originalResolution = resolveConfigForRead(
        originalResolvedIncludes,
        originalEnv,
        deps.lowerPrecedenceEnv,
      );
      const prepareValidation = (pending: readonly DeferredPluginMigration[]) => {
        const authoredCandidate = transformRecoveryCandidate
          ? transformRecoveryCandidate({
              candidate,
              configPath,
              includeProvenance,
              resolvedConfig: originalResolution.resolvedConfigRaw,
              deferredPluginMigrations: pending,
            })
          : candidate.parsed;
        const candidateEnv = cloneEnvWithPlatformSemantics(deps.env);
        const resolved = resolveConfigIncludesForRead(authoredCandidate, configPath, {
          ...deps,
          env: candidateEnv,
        });
        const resolution = resolveConfigForRead(resolved, candidateEnv, deps.lowerPrecedenceEnv);
        const effectiveConfigRaw = resolution.resolvedConfigRaw;
        return {
          authoredCandidate,
          effectiveConfigRaw,
          pluginMetadata: createValidationPluginMetadataSnapshotLoader({
            env: candidateEnv,
          }),
          validationOptions: {
            ...pathResolution,
            env: candidateEnv,
            pluginValidation: options.pluginValidation,
            sourceRaw: authoredCandidate,
            preservedLegacyRootKeys: options.preservedLegacyRootKeys,
            deferredPluginMigrations: pending,
          },
        };
      };
      const { authoredCandidate: preparedRawConfig, validated } = yield* resolveConfigIoEffect({
        sync: () =>
          withSynchronousArtifactPreservingStateSnapshot(() => {
            const prepared = prepareValidation(resolveDeferredPluginMigrations());
            return {
              authoredCandidate: prepared.authoredCandidate,
              validated: validateConfigObjectWithPlugins(prepared.effectiveConfigRaw, {
                ...prepared.validationOptions,
                loadPluginMetadataSnapshot: prepared.pluginMetadata.load,
              }),
            };
          }),
        async: async () => {
          const prepared = prepareValidation(await resolveDeferredPluginMigrationsAsync());
          return {
            authoredCandidate: prepared.authoredCandidate,
            validated: await validateConfigObjectWithPluginsAsync(prepared.effectiveConfigRaw, {
              ...prepared.validationOptions,
              loadPluginMetadataSnapshotAsync: prepared.pluginMetadata.loadAsync,
            }),
          };
        },
      });
      if (!validated.ok) {
        const issueSummary = formatConfigIssueSummary(validated.issues.slice(0, 3)) ?? "";
        const detail = issueSummary.length > 800 ? `${issueSummary.slice(0, 799)}…` : issueSummary;
        return {
          ok: false,
          reason: `candidate is not valid current config${detail ? `: ${detail}` : ""}`,
        };
      }
      return {
        ok: true,
        candidate: {
          config: validated.config,
          parsed: preparedRawConfig,
          raw:
            preparedRawConfig !== candidate.parsed
              ? JSON.stringify(preparedRawConfig, null, 2).trimEnd().concat("\n")
              : candidate.raw,
        },
      };
    } catch (error) {
      // Unavailable dependencies cannot establish that the backup is invalid.
      if (
        error instanceof ConfigIncludeReadError ||
        !(error instanceof ConfigIncludeError || isInvalidConfigError(error))
      ) {
        throw error;
      }
      return { ok: false, reason: `candidate preparation failed: ${error.message}` };
    }
  }

  function prepareRecoveryBackupCandidate(
    candidate: ConfigRecoveryCandidate,
  ): ConfigRecoveryCandidatePreparation {
    return runConfigIoSync(prepareRecoveryBackupCandidateSteps(candidate));
  }

  async function prepareRecoveryBackupCandidateAsync(
    candidate: ConfigRecoveryCandidate,
  ): Promise<ConfigRecoveryCandidatePreparation> {
    return await runConfigIoAsync(prepareRecoveryBackupCandidateSteps(candidate));
  }

  return {
    deps,
    pathResolution,
    configPath,
    options,
    ...(transformRecoveryCandidate ? { transformRecoveryCandidate } : {}),
    resolveDeferredPluginMigrations,
    resolveDeferredPluginMigrationsAsync,
    observeLoadConfigSnapshot,
    observeLoadConfigSnapshotAsync,
    finalizeLoadedRuntimeConfig,
    finalizeLoadedRuntimeConfigAsync,
    createValidationPluginMetadataSnapshotLoader,
    resolveRuntimePreflightSourceConfig,
    prepareRecoveryBackupCandidate,
    prepareRecoveryBackupCandidateAsync,
  };
}
