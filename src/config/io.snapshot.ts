import { createHash } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { findStartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  withArtifactPreservingStateReads,
  withSynchronousArtifactPreservingStateSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  includeContributionOwnsAgentRoster,
  includeContributionOwnsBindings,
} from "./agent-roster-provenance.js";
import { cloneEnvWithPlatformSemantics } from "./config-env-vars.js";
import { resolveManagedUnsetPathsForWrite } from "./config-path-mutation.js";
import { ConfigIncludeError, ConfigIncludeReadError } from "./includes.js";
import { createConfigIoContext, type ConfigIoContext } from "./io.context.js";
import {
  maybeRecoverSuspiciousConfigRead,
  prepareSuspiciousConfigRead,
} from "./io.observe-recovery.js";
import {
  coerceConfig,
  containsConfigIncludeDirective,
  hashConfigRaw,
  parseConfigJson5,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  resolveConfigPathForDeps,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
} from "./io.read-helpers.js";
import { maybeLoadDotEnvForConfig } from "./io.runtime-env.js";
import {
  materializeConfigSnapshotDefaults,
  prepareConfigSnapshotValidation,
} from "./io.snapshot-preparation.js";
import type {
  CapturedConfigSnapshotPreparation,
  ValidationRequest,
} from "./io.snapshot-preparation.types.js";
import {
  collectInvalidConfigLegacyIssues,
  createConfigFileSnapshot,
  finalizeReadConfigSnapshotInternalResult,
} from "./io.snapshot-shared.js";
import type {
  BestEffortConfigSnapshot,
  ConfigSnapshotReadOptions,
  ConfigSnapshotMetadataReadOptions,
  PreparedConfigRecovery,
  ReadConfigFileSnapshotForWriteResult,
  ReadConfigFileSnapshotInternalResult,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "./io.types.js";
import { warnIfConfigFromFuture } from "./io.warnings.js";
import { captureConfigRootWriteTarget } from "./io.write-safety.js";
import {
  findLegacyConfigIssues,
  migrateLegacyContextBudgetConfig,
  migratePersistedImplicitMainRoster,
} from "./legacy.js";
import { materializeRuntimeConfig } from "./materialize.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { captureManagedConfigSnapshotPreparation } from "./runtime-snapshot.js";
import type { ConfigFileSnapshot, LegacyConfigIssue, OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";
import { composeConfigWriteAssertions } from "./write-authority.js";

type InternalReadOptions = {
  prepareValidation?: "runtime" | "strict";
  preparation?: CapturedConfigSnapshotPreparation | null;
  allowCurrentPluginMetadata?: boolean;
  recoverSuspicious?: boolean;
  skipSuspiciousRecovery?: boolean;
  allowSuspiciousRecovery?: (
    candidate: OpenClawConfig,
    current: OpenClawConfig,
  ) => boolean | Promise<boolean>;
};

function listResolvedIncludePaths(includeFilePathsForWatch: ReadonlySet<string>): string[] {
  return [...includeFilePathsForWatch].toSorted();
}

export function hashConfigRevision(
  raw: string,
  includeFileHashes: Record<string, string>,
  includeFileTargets: Record<string, string>,
): string {
  const revision = createHash("sha256").update(raw);
  for (const [includePath, includeHash] of Object.entries(includeFileHashes)) {
    revision.update(JSON.stringify([includePath, includeFileTargets[includePath], includeHash]));
  }
  return revision.digest("hex");
}

export async function readConfigFileSnapshotInternal(
  context: ConfigIoContext,
  options: InternalReadOptions = {},
  sourceRaw?: string,
): Promise<ReadConfigFileSnapshotInternalResult> {
  const preparation =
    options.preparation === undefined
      ? captureManagedConfigSnapshotPreparation(context.configPath)
      : options.preparation;
  preparation?.assertCurrent();
  const result = await readConfigSnapshotWithPreparation(
    context,
    { ...options, preparation },
    sourceRaw,
  );
  preparation?.assertCurrent();
  return result;
}

async function readConfigSnapshotWithPreparation(
  context: ConfigIoContext,
  options: InternalReadOptions,
  sourceRaw: string | undefined,
): Promise<ReadConfigFileSnapshotInternalResult> {
  const { deps, configPath, pathResolution } = context;
  const preparation = options.preparation;
  maybeLoadDotEnvForConfig(deps.env);
  const envBeforeRead = snapshotEnv(deps.env);
  if (sourceRaw === undefined && !deps.fs.existsSync(configPath)) {
    const migrated = migratePersistedImplicitMainRoster({});
    const config = coerceConfig(migrated.config);
    const metadata = context.createValidationPluginMetadataSnapshotLoader({
      env: deps.env,
      allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
    });
    const legacyIssues: LegacyConfigIssue[] = [];
    return await finalizeReadConfigSnapshotInternalResult(deps, {
      snapshot: createConfigFileSnapshot({
        path: configPath,
        exists: false,
        raw: null,
        parsed: {},
        sourceConfig: config,
        valid: true,
        // Missing config is the fresh-install default path: materialize the
        // same runtime defaults an existing empty {} config gets, so snapshot
        // consumers see identical out-of-box behavior either way.
        runtimeConfig: preparation
          ? await preparation((prepare) =>
              prepare({ kind: "materialize", context, metadata, config }),
            )
          : materializeConfigSnapshotDefaults(context, config, metadata),
        hash: hashConfigRaw(null),
        issues: [],
        warnings: [],
        legacyIssues,
      }),
      pluginMetadataSnapshot: metadata.getSnapshot(),
    });
  }

  let fallbackRaw: string | null = null;
  let fallbackParsed: unknown = {};
  let fallbackSourceConfig: OpenClawConfig = {};
  let fallbackHash = hashConfigRaw(null);
  let fallbackEnvSnapshotForRestore: Record<string, string | undefined> | undefined;
  const includeFileHashesForWrite: Record<string, string> = {};
  const includeFileTargetsForWrite: Record<string, string> = {};
  const includeFilePathsForWatch = new Set<string>();
  const includeProvenance: NonNullable<ConfigFileSnapshot["includeProvenance"]>[number][] = [];
  let agentRosterIncludeOwned = false;
  let bindingsIncludeOwned = false;

  try {
    const raw = await deps.measure(
      "config.snapshot.read.file",
      () => sourceRaw ?? deps.fs.readFileSync(configPath, "utf-8"),
    );
    const rawHash = await deps.measure("config.snapshot.read.hash", () => hashConfigRaw(raw));
    fallbackRaw = raw;
    fallbackHash = rawHash;
    const parsedRes = await deps.measure("config.snapshot.read.parse", () =>
      parseConfigJson5(raw, deps.json5),
    );
    if (!parsedRes.ok) {
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          includedPaths: listResolvedIncludePaths(includeFilePathsForWatch),
          exists: true,
          raw,
          parsed: {},
          sourceConfig: {},
          valid: false,
          runtimeConfig: {},
          hash: rawHash,
          issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
          warnings: [],
          legacyIssues: [],
        }),
      });
    }
    const effectiveParsed = parsedRes.parsed;
    fallbackParsed = effectiveParsed;
    fallbackSourceConfig = coerceConfig(effectiveParsed);

    let resolved: unknown;
    try {
      resolved = await deps.measure("config.snapshot.read.includes", () =>
        resolveConfigIncludesForRead(
          effectiveParsed,
          configPath,
          deps,
          includeFileHashesForWrite,
          includeFileTargetsForWrite,
          includeFilePathsForWatch,
          (event) => {
            const { value: _value, ...ownership } = event;
            includeProvenance.push(ownership);
            agentRosterIncludeOwned ||= includeContributionOwnsAgentRoster(event);
            bindingsIncludeOwned ||= includeContributionOwnsBindings(event);
          },
        ),
      );
    } catch (error) {
      if (findStartupMaintenanceRequiredError(error)) {
        throw error;
      }
      const message =
        error instanceof ConfigIncludeError
          ? error.message
          : `Include resolution failed: ${String(error)}`;
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          path: configPath,
          includedPaths: listResolvedIncludePaths(includeFilePathsForWatch),
          exists: true,
          raw,
          parsed: effectiveParsed,
          sourceConfig: coerceConfig(effectiveParsed),
          valid: false,
          runtimeConfig: coerceConfig(effectiveParsed),
          hash: rawHash,
          issues: [
            {
              path: "",
              ...(error instanceof ConfigIncludeReadError || !(error instanceof ConfigIncludeError)
                ? { errorCode: "CONFIG_READ_FAILED" }
                : {}),
              message,
            },
          ],
          warnings: [],
          legacyIssues: [],
        }),
        includeFileHashesForWrite,
        includeFileTargetsForWrite,
      });
    }

    const readResolution = await deps.measure("config.snapshot.read.env", () =>
      resolveConfigForRead(resolved, deps.env, deps.lowerPrecedenceEnv),
    );
    fallbackEnvSnapshotForRestore = readResolution.envSnapshotForRestore;
    const envVarWarnings = readResolution.envWarnings.map((warning) => ({
      path: warning.configPath,
      message: `Missing env var "${warning.varName}" - feature using this value will be unavailable`,
    }));
    const contextBudgetMigration = migrateLegacyContextBudgetConfig(
      readResolution.resolvedConfigRaw,
    );
    const rosterMigration = migratePersistedImplicitMainRoster(contextBudgetMigration.config, {
      env: deps.env,
      homedir: deps.homedir,
    });
    envVarWarnings.push(
      ...contextBudgetMigration.changes,
      ...contextBudgetMigration.warnings,
      ...rosterMigration.diagnostics.map((message) => ({ path: "agents.entries", message })),
    );
    const effectiveConfigRaw = rosterMigration.config;
    // The write revision covers every authored input, without hashing runtime defaults or env.
    const snapshotHash = hashConfigRevision(
      raw,
      includeFileHashesForWrite,
      includeFileTargetsForWrite,
    );
    fallbackHash = snapshotHash;
    fallbackSourceConfig = coerceConfig(effectiveConfigRaw);
    const pluginMetadata = context.createValidationPluginMetadataSnapshotLoader({
      env: deps.env,
      allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
    });
    const validationRequest: ValidationRequest = {
      kind: "validate",
      prepareValidation: options.prepareValidation,
      context,
      metadata: pluginMetadata,
      raw: effectiveConfigRaw,
      sourceRaw: effectiveParsed,
    };
    const { deferredPluginMigrations, validated } = await deps.measure(
      "config.snapshot.read.validate",
      () =>
        preparation
          ? preparation((prepare) => prepare(validationRequest))
          : options.prepareValidation
            ? prepareConfigSnapshotValidation(validationRequest)
            : withSynchronousArtifactPreservingStateSnapshot(() => {
                const pending = context.resolveDeferredPluginMigrations();
                return {
                  deferredPluginMigrations: pending,
                  validated: validateConfigObjectWithPlugins(effectiveConfigRaw, {
                    ...pathResolution,
                    pluginValidation: context.options.pluginValidation,
                    loadPluginMetadataSnapshot: pluginMetadata.load,
                    sourceRaw: effectiveParsed,
                    preservedLegacyRootKeys: context.options.preservedLegacyRootKeys,
                    deferredPluginMigrations: pending,
                  }),
                };
              }),
    );
    const snapshotSource = () => ({
      path: configPath,
      includedPaths: listResolvedIncludePaths(includeFilePathsForWatch),
      exists: true,
      raw,
      parsed: effectiveParsed,
      authoredConfig: coerceConfig(resolved),
      includeProvenance,
      agentRosterIncludeOwned,
      bindingsIncludeOwned,
      sourceConfigBeforeMigrations: coerceConfig(readResolution.resolvedConfigRaw),
      sourceConfig: coerceConfig(effectiveConfigRaw),
      hash: snapshotHash,
      deferredPluginMigrations,
      warnings: [...validated.warnings, ...envVarWarnings],
      resolutionFacts: readResolution.resolutionFacts,
    });
    if (!validated.ok) {
      const availableSnapshot = pluginMetadata.getSnapshot();
      const collect = () =>
        context.options.pluginValidation === "core-only"
          ? findLegacyConfigIssues(effectiveConfigRaw, effectiveParsed)
          : collectInvalidConfigLegacyIssues(effectiveConfigRaw, effectiveParsed);
      const legacyIssues = await deps.measure("config.snapshot.read.legacy-issues", () =>
        availableSnapshot
          ? withPluginMetadataSnapshotScope(availableSnapshot, collect, {
              config: coerceConfig(effectiveConfigRaw),
              env: deps.env,
            })
          : collect(),
      );
      // Invalid snapshots stay inspectable, but rejected env.vars must not become runtime state.
      restoreEnvChangesIfUnchanged({
        env: deps.env,
        before: envBeforeRead,
        after: snapshotEnv(deps.env),
      });
      return await finalizeReadConfigSnapshotInternalResult(deps, {
        snapshot: createConfigFileSnapshot({
          ...snapshotSource(),
          valid: false,
          runtimeConfig: coerceConfig(effectiveConfigRaw),
          issues: validated.issues,
          legacyIssues,
        }),
        envSnapshotForRestore: readResolution.envSnapshotForRestore,
        includeFileHashesForWrite,
        includeFileTargetsForWrite,
      });
    }
    if (!deps.suppressFutureVersionWarning) {
      warnIfConfigFromFuture(validated.config, deps.logger);
    }
    let callerRejectedSuspiciousRecovery = false;
    if (
      options.recoverSuspicious === true &&
      deps.observe &&
      !options.skipSuspiciousRecovery &&
      !containsConfigIncludeDirective(effectiveParsed)
    ) {
      const allowSuspiciousRecovery = options.allowSuspiciousRecovery;
      let recoveryCandidate: OpenClawConfig | null = null;
      const recovery = await deps.measure("config.snapshot.read.recover-suspicious", () =>
        maybeRecoverSuspiciousConfigRead({
          deps,
          configPath,
          raw,
          parsed: effectiveParsed,
          prepareBackup: (backup) => {
            const prepared = context.prepareRecoveryBackupCandidate(backup);
            recoveryCandidate = prepared.ok ? (prepared.candidate.config ?? null) : null;
            return prepared;
          },
          ...(allowSuspiciousRecovery
            ? {
                allowBackupRecovery: async () => {
                  const allowed =
                    recoveryCandidate !== null &&
                    (await allowSuspiciousRecovery(recoveryCandidate, validated.config));
                  callerRejectedSuspiciousRecovery = !allowed;
                  return allowed;
                },
              }
            : {}),
        }),
      );
      if (recovery.raw !== raw) {
        restoreEnvChangesIfUnchanged({
          env: deps.env,
          before: envBeforeRead,
          after: snapshotEnv(deps.env),
        });
        return await readConfigFileSnapshotInternal(context, {
          preparation,
          prepareValidation: options.prepareValidation,
          allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
          recoverSuspicious: options.recoverSuspicious,
          skipSuspiciousRecovery: true,
        });
      }
    }
    const snapshotConfig = await deps.measure("config.snapshot.read.materialize", () =>
      materializeRuntimeConfig(validated.config, {
        ...pathResolution,
        manifestRegistry:
          pluginMetadata.getSnapshot()?.manifestRegistry ??
          (context.options.pluginValidation === "core-only" ? { plugins: [] } : undefined),
      }),
    );
    return await deps.measure("config.snapshot.read.observe", () =>
      finalizeReadConfigSnapshotInternalResult(
        deps,
        {
          snapshot: createConfigFileSnapshot({
            ...snapshotSource(),
            valid: true,
            runtimeConfig: snapshotConfig,
            issues: [],
            legacyIssues: [],
          }),
          envSnapshotForRestore: readResolution.envSnapshotForRestore,
          includeFileHashesForWrite,
          includeFileTargetsForWrite,
          pluginMetadataSnapshot: pluginMetadata.getSnapshot(),
          ...(validated.strictIssues ? { strictIssues: validated.strictIssues } : {}),
        },
        { observe: !callerRejectedSuspiciousRecovery },
      ),
    );
  } catch (error) {
    preparation?.assertCurrent();
    if (findStartupMaintenanceRequiredError(error)) {
      throw error;
    }
    const nodeError = error as NodeJS.ErrnoException;
    let message: string;
    if (nodeError?.code === "EACCES") {
      const uid = process.getuid?.();
      const uidHint = typeof uid === "number" ? String(uid) : "$(id -u)";
      message = [
        `read failed: ${String(error)}`,
        "",
        "Config file is not readable by the current process. If running in a container",
        "or 1-click deployment, fix ownership with:",
        `  chown ${uidHint} "${configPath}"`,
        "Then restart the gateway.",
      ].join("\n");
      deps.logger.error(message);
    } else {
      message = `read failed: ${String(error)}`;
    }
    return await finalizeReadConfigSnapshotInternalResult(deps, {
      snapshot: createConfigFileSnapshot({
        path: configPath,
        includedPaths: listResolvedIncludePaths(includeFilePathsForWatch),
        exists: true,
        raw: fallbackRaw,
        parsed: fallbackParsed,
        sourceConfig: fallbackSourceConfig,
        valid: false,
        runtimeConfig: fallbackSourceConfig,
        hash: fallbackHash,
        ...(fallbackRaw === null ? { readError: { code: nodeError?.code ?? null } } : {}),
        // Diagnostic classification must not broaden readError's unavailable-source write guard.
        issues: [{ path: "", errorCode: "CONFIG_READ_FAILED", message }],
        warnings: [],
        legacyIssues: [],
      }),
      envSnapshotForRestore: fallbackEnvSnapshotForRestore,
      includeFileHashesForWrite,
      includeFileTargetsForWrite,
    });
  }
}

/** Preview recovery through the ordinary snapshot pipeline at the selected config path. */
export async function prepareConfigRecoveryFromContext(
  context: ConfigIoContext,
  current: ConfigFileSnapshot,
): Promise<PreparedConfigRecovery | null> {
  return await withArtifactPreservingStateReads(async () => {
    if (
      !current.exists ||
      !current.valid ||
      typeof current.raw !== "string" ||
      containsConfigIncludeDirective(current.parsed)
    ) {
      return null;
    }
    if (current.path !== context.configPath) {
      throw new ConfigMutationConflictError("config recovery path changed since last load", {
        retryable: false,
      });
    }
    const previewContext = createConfigIoContext(
      {
        ...context.options,
        configPath: context.configPath,
        env: cloneEnvWithPlatformSemantics(context.deps.env),
        observe: false,
      },
      context.transformRecoveryCandidate,
    );
    const plan = await prepareSuspiciousConfigRead({
      deps: previewContext.deps,
      configPath: context.configPath,
      raw: current.raw,
      parsed: current.parsed,
      prepareBackup: previewContext.prepareRecoveryBackupCandidate,
    });
    if (!plan) {
      return null;
    }
    const envBeforeRead = snapshotEnv(previewContext.deps.env);
    try {
      const { snapshot, pluginMetadataSnapshot } = await readConfigFileSnapshotInternal(
        previewContext,
        { allowCurrentPluginMetadata: false },
        plan.candidate.raw,
      );
      return snapshot.valid ? { snapshot, pluginMetadataSnapshot, apply: plan.apply } : null;
    } finally {
      // The prepared writer keeps the selected environment; candidate env.vars are preview-only.
      restoreEnvChangesIfUnchanged({
        env: previewContext.deps.env,
        before: envBeforeRead,
        after: snapshotEnv(previewContext.deps.env),
      });
    }
  });
}

export async function readConfigFileSnapshotFromContext(
  context: ConfigIoContext,
  options: ConfigSnapshotReadOptions = {},
): Promise<ConfigFileSnapshot> {
  return (
    await readConfigFileSnapshotInternal(context, {
      recoverSuspicious: options.recoverSuspicious === true,
      allowSuspiciousRecovery: options.allowSuspiciousRecovery,
    })
  ).snapshot;
}

export async function readConfigFileSnapshotWithPluginMetadataFromContext(
  context: ConfigIoContext,
  options: ConfigSnapshotMetadataReadOptions = {},
): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
  const read = () => readConfigSnapshotWithPluginMetadata(context, options);
  // Explicit CLI validation prepares async state facts before command admission.
  return options.prepareValidation && !context.deps.observe
    ? withArtifactPreservingStateReads(read)
    : read();
}

async function readConfigSnapshotWithPluginMetadata(
  context: ConfigIoContext,
  options: ConfigSnapshotMetadataReadOptions,
): Promise<ReadConfigFileSnapshotWithPluginMetadataResult> {
  const preparation = captureManagedConfigSnapshotPreparation(context.configPath);
  const result = await readConfigFileSnapshotInternal(context, {
    preparation,
    prepareValidation: options.prepareValidation,
    allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
    recoverSuspicious: options.recoverSuspicious === true,
    allowSuspiciousRecovery: options.allowSuspiciousRecovery,
  });
  let pluginMetadataSnapshot = result.pluginMetadataSnapshot;
  if (!pluginMetadataSnapshot && result.snapshot.valid) {
    const pluginMetadata = context.createValidationPluginMetadataSnapshotLoader({
      env: context.deps.env,
      allowCurrentPluginMetadata: options.allowCurrentPluginMetadata,
    });
    if (preparation) {
      await preparation((prepare) =>
        prepare({
          kind: "metadata",
          metadata: pluginMetadata,
          config: result.snapshot.sourceConfig,
        }),
      );
    } else if (options.prepareValidation) {
      await pluginMetadata.loadAsync(result.snapshot.sourceConfig);
    } else {
      pluginMetadata.load(result.snapshot.sourceConfig);
    }
    pluginMetadataSnapshot = pluginMetadata.getSnapshot();
  }
  preparation?.assertCurrent();
  return {
    snapshot: result.snapshot,
    ...(result.strictIssues ? { strictIssues: result.strictIssues } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
  };
}

export async function readConfigFileSnapshotForWriteFromContext(
  context: ConfigIoContext,
  options: Pick<ConfigSnapshotReadOptions, "observe"> = {},
): Promise<ReadConfigFileSnapshotForWriteResult> {
  const assertConfigSelection = () => {
    if (resolveConfigPathForDeps(context.deps) !== context.configPath) {
      throw new ConfigMutationConflictError("config path changed since last load", {
        retryable: false,
      });
    }
  };
  assertConfigSelection();
  const { pathProof } = captureConfigRootWriteTarget(context.configPath, context.deps.fs);
  const assertConfigPathForWrite = composeConfigWriteAssertions(
    assertConfigSelection,
    pathProof.assertCurrent,
  );
  assertConfigPathForWrite();
  // Per-call observation policy must not recapture the factory's path or environment.
  const readContext =
    options.observe === false ? { ...context, deps: { ...context.deps, observe: false } } : context;
  const read = () => readConfigFileSnapshotInternal(readContext);
  const result = await (readContext.deps.observe ? read() : withArtifactPreservingStateReads(read));
  assertConfigPathForWrite();
  return {
    snapshot: result.snapshot,
    writeOptions: {
      assertConfigPathForWrite,
      basePluginMetadataSnapshot: result.pluginMetadataSnapshot,
      envSnapshotForRestore: result.envSnapshotForRestore,
      expectedConfigPath: context.configPath,
      ownedConfigPathForWrite: context.configPath,
      includeFileHashesForWrite: result.includeFileHashesForWrite,
      includeFileTargetsForWrite: result.includeFileTargetsForWrite,
      unsetPaths: resolveManagedUnsetPathsForWrite(undefined),
    },
  };
}

export async function readBestEffortConfigSnapshotFromContext(
  context: ConfigIoContext,
): Promise<BestEffortConfigSnapshot> {
  const operation = async () => {
    const result = await readConfigFileSnapshotInternal(context);
    if (!result.snapshot.valid) {
      return {
        config: result.snapshot.config,
        sourceConfig: result.snapshot.sourceConfig,
        configDiagnostics: {
          path: result.snapshot.path,
          issues: result.snapshot.issues,
        },
      };
    }
    return {
      // The snapshot already materialized under the caller's plugin-validation policy.
      config: context.finalizeLoadedRuntimeConfig(result.snapshot.config),
      sourceConfig: result.snapshot.sourceConfig,
      configDiagnostics: null,
    };
  };
  // Unobserved CLI reads resolve plugin metadata before command-specific admission.
  return await (context.deps.observe ? operation() : withArtifactPreservingStateReads(operation));
}

export async function readSourceConfigBestEffortFromContext(
  context: ConfigIoContext,
): Promise<OpenClawConfig> {
  const { deps, configPath } = context;
  maybeLoadDotEnvForConfig(deps.env);
  if (!deps.fs.existsSync(configPath)) {
    return {};
  }
  // Best-effort legitimizes the fallback value, not the silence: consumers
  // (update-channel selection, doctor lint) act on the result, so each
  // degradation records why the real config was not used.
  try {
    const raw = deps.fs.readFileSync(configPath, "utf-8");
    const parsed = parseConfigJson5(raw, deps.json5);
    if (!parsed.ok) {
      deps.logger.warn(
        `Config (${configPath}): best-effort read ignored unparseable config: ${parsed.error}`,
      );
      return {};
    }
    let resolved: unknown;
    try {
      resolved = resolveConfigIncludesForRead(parsed.parsed, configPath, deps);
    } catch (err) {
      deps.logger.warn(
        `Config (${configPath}): best-effort read skipped $include resolution: ${formatErrorMessage(err)}`,
      );
      return coerceConfig(parsed.parsed);
    }
    const resolution = resolveConfigForRead(resolved, deps.env, deps.lowerPrecedenceEnv);
    return coerceConfig(resolution.resolvedConfigRaw);
  } catch (err) {
    deps.logger.warn(`Config (${configPath}): best-effort read failed: ${formatErrorMessage(err)}`);
    return {};
  }
}
