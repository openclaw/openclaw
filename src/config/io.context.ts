import crypto from "node:crypto";
import { ensureOwnerDisplaySecret } from "../agents/owner-display.js";
import { classifyOtelGrpcMigrationOwnership } from "../commands/doctor/shared/include-migration-ownership.js";
import { applyLegacyDoctorMigrations } from "../commands/doctor/shared/legacy-config-compat.js";
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
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withSynchronousArtifactPreservingStateSnapshot } from "../state/openclaw-state-db-readonly.js";
import { DuplicateAgentDirError, findDuplicateAgentDirs } from "./agent-dirs.js";
import { applyConfigEnvVars, cloneEnvWithPlatformSemantics } from "./config-env-vars.js";
import { preserveDeferredPluginMigrationConfig } from "./deferred-plugin-migration-config.js";
import { observeConfigSnapshot, observeConfigSnapshotSync } from "./io.observe.js";
import { retainGeneratedOwnerDisplaySecret } from "./io.owner-display-secret.js";
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
import { autoOwnerDisplaySecretByPath } from "./io.state.js";
import type {
  ConfigIoFactoryOptions,
  ConfigRecoveryCandidate,
  ConfigRecoveryCandidatePreparation,
  NormalizedConfigIoDeps,
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
  type PreparedConfigValidationPluginMetadata,
} from "./validation.js";

type ValidateConfigWithPluginsResult = ReturnType<typeof validateConfigObjectWithPlugins>;

type RecoveryCandidateValidation = {
  migrated: ReturnType<typeof applyLegacyDoctorMigrations>;
  authoredCandidate: unknown;
  validated: ValidateConfigWithPluginsResult;
};

type ValidationPluginMetadataSnapshotLoader = {
  load: (config: OpenClawConfig) => Pick<PluginMetadataSnapshot, "manifestRegistry">;
  loadAsync: (config: OpenClawConfig) => Promise<PreparedConfigValidationPluginMetadata>;
  getManifestRegistry: () => PluginManifestRegistry | undefined;
  getSnapshot: () => PluginMetadataSnapshot | undefined;
};

export type ConfigIoContext = {
  deps: NormalizedConfigIoDeps;
  pathResolution: { env: NodeJS.ProcessEnv; homedir?: () => string };
  configPath: string;
  options: ConfigIoFactoryOptions;
  resolveDeferredPluginMigrations: () => readonly DeferredPluginMigration[];
  resolveDeferredPluginMigrationsAsync: () => Promise<readonly DeferredPluginMigration[]>;
  observeLoadConfigSnapshot: (snapshot: ConfigFileSnapshot) => ConfigFileSnapshot;
  observeLoadConfigSnapshotAsync: (
    snapshot: ConfigFileSnapshot,
    assertCurrent?: () => void,
  ) => Promise<ConfigFileSnapshot>;
  finalizeLoadedRuntimeConfig: (config: OpenClawConfig) => OpenClawConfig;
  finalizeLoadedRuntimeConfigAsync: (
    config: OpenClawConfig,
    metadata: ValidationPluginMetadataSnapshotLoader,
    assertCurrent?: () => void,
  ) => Promise<OpenClawConfig>;
  createValidationPluginMetadataSnapshotLoader: (params: {
    effectiveConfigRaw: unknown;
    env: NodeJS.ProcessEnv;
    allowCurrentPluginMetadata?: boolean;
  }) => ValidationPluginMetadataSnapshotLoader;
  resolveRuntimePreflightSourceConfig: (
    candidate: OpenClawConfig,
    includeFileHashes?: Record<string, string>,
    includeFileTargets?: Record<string, string>,
  ) => OpenClawConfig;
  prepareRecoveryBackupCandidateAsync: (
    candidate: ConfigRecoveryCandidate,
  ) => Promise<ConfigRecoveryCandidatePreparation>;
  prepareRecoveryBackupCandidate: (
    candidate: ConfigRecoveryCandidate,
  ) => ConfigRecoveryCandidatePreparation;
};

export function createConfigIoContext(options: ConfigIoFactoryOptions = {}): ConfigIoContext {
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
        : readDeferredPluginMigrations({ env: deps.env }))
    );
  }

  async function resolveDeferredPluginMigrationsAsync(): Promise<
    readonly DeferredPluginMigration[]
  > {
    return (
      options.deferredPluginMigrations ??
      (options.pluginValidation === "core-only"
        ? []
        : readDeferredPluginMigrationsAsync({ env: deps.env }))
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
    const pendingValue = autoOwnerDisplaySecretByPath.get(configPath);
    const { config: resolvedConfig, generatedSecret } = ensureOwnerDisplaySecret(
      cfg,
      () => pendingValue ?? crypto.randomBytes(32).toString("hex"),
    );
    const finalized = applyConfigOverrides(
      retainGeneratedOwnerDisplaySecret({
        config: resolvedConfig,
        configPath,
        generatedSecret,
        state: { pendingByPath: autoOwnerDisplaySecretByPath },
      }),
    );
    const inherited = inheritLegacyDefaultAgentId(cfg, finalized);
    copyConfigResolutionFacts(cfg, inherited);
    return inherited;
  }

  function createValidationPluginMetadataSnapshotLoader(params: {
    effectiveConfigRaw: unknown;
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
      getManifestRegistry: () => snapshot?.manifestRegistry,
      getSnapshot: () => snapshot,
    };
  }

  function resolveRuntimePreflightSourceConfig(
    candidate: OpenClawConfig,
    includeFileHashes?: Record<string, string>,
    includeFileTargets?: Record<string, string>,
  ): OpenClawConfig {
    const env = { ...deps.env } as NodeJS.ProcessEnv;
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

  function* prepareRecoveryBackupCandidateSteps(candidate: ConfigRecoveryCandidate): Generator<
    {
      sync: () => RecoveryCandidateValidation;
      async: () => Promise<RecoveryCandidateValidation>;
    },
    ConfigRecoveryCandidatePreparation,
    RecoveryCandidateValidation
  > {
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
      const otelOwnership = classifyOtelGrpcMigrationOwnership({
        snapshot: { path: configPath, includeProvenance },
        authoredConfig: candidate.parsed,
        resolvedConfig: originalResolution.resolvedConfigRaw,
      });
      if (otelOwnership && otelOwnership.kind !== "direct") {
        return {
          ok: false,
          reason:
            otelOwnership.kind === "resolved-only"
              ? "candidate migration cannot persist an env-resolved diagnostics.otel.protocol repair"
              : "candidate migration requires an include-owned diagnostics.otel.protocol repair",
        };
      }
      // Recovery is a migration boundary, not runtime compatibility: the canonical Doctor
      // registry owns historical shapes before current-schema validation and any disk write.
      const prepareValidation = (pending: readonly DeferredPluginMigration[]) => {
        const migration = applyLegacyDoctorMigrations(candidate.parsed, {
          sourceConfigBeforeMigrations: originalResolution.resolvedConfigRaw,
          context: {
            authoredRaw: candidate.parsed,
            resolvedRaw: originalResolution.resolvedConfigRaw,
          },
        });
        const authoredCandidate = migration.next
          ? preserveDeferredPluginMigrationConfig({
              sourceConfig: candidate.parsed,
              nextConfig: migration.next,
              pending,
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
          migrated: migration,
          authoredCandidate,
          effectiveConfigRaw,
          pluginMetadata: createValidationPluginMetadataSnapshotLoader({
            effectiveConfigRaw,
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
      const {
        migrated: legacyMigration,
        authoredCandidate: preparedRawConfig,
        validated,
      } = yield {
        sync: () =>
          withSynchronousArtifactPreservingStateSnapshot(() => {
            const prepared = prepareValidation(resolveDeferredPluginMigrations());
            return {
              migrated: prepared.migrated,
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
            migrated: prepared.migrated,
            authoredCandidate: prepared.authoredCandidate,
            validated: await validateConfigObjectWithPluginsAsync(prepared.effectiveConfigRaw, {
              ...prepared.validationOptions,
              loadPluginMetadataSnapshotAsync: prepared.pluginMetadata.loadAsync,
            }),
          };
        },
      };
      if (!validated.ok) {
        const issueSummary = formatConfigIssueSummary(validated.issues.slice(0, 3)) ?? "";
        const detail = issueSummary.length > 800 ? `${issueSummary.slice(0, 799)}…` : issueSummary;
        return {
          ok: false,
          reason: `candidate remains invalid after legacy migration${detail ? `: ${detail}` : ""}`,
        };
      }
      return {
        ok: true,
        candidate: {
          config: validated.config,
          parsed: preparedRawConfig,
          raw: legacyMigration.next
            ? JSON.stringify(preparedRawConfig, null, 2).trimEnd().concat("\n")
            : candidate.raw,
        },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `candidate preparation failed: ${detail}` };
    }
  }

  function prepareRecoveryBackupCandidate(
    candidate: ConfigRecoveryCandidate,
  ): ConfigRecoveryCandidatePreparation {
    const steps = prepareRecoveryBackupCandidateSteps(candidate);
    let next = steps.next();
    while (!next.done) {
      try {
        next = steps.next(next.value.sync());
      } catch (error) {
        next = steps.throw(error);
      }
    }
    return next.value;
  }

  async function prepareRecoveryBackupCandidateAsync(
    candidate: ConfigRecoveryCandidate,
  ): Promise<ConfigRecoveryCandidatePreparation> {
    const steps = prepareRecoveryBackupCandidateSteps(candidate);
    let next = steps.next();
    while (!next.done) {
      try {
        next = steps.next(await next.value.async());
      } catch (error) {
        next = steps.throw(error);
      }
    }
    return next.value;
  }

  return {
    deps,
    pathResolution,
    configPath,
    options,
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
