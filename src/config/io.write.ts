import type fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveCronJobsStorePathFromConfigAsync } from "../cron/store.js";
import { isVerbose } from "../global-state.js";
import {
  withDeferredPluginConfigRollback,
  withDeferredPluginMigrationsCurrent,
} from "../infra/deferred-plugin-migrations.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readExistingStateRootMode } from "../infra/private-dir-mode.js";
import {
  getUpdateDoctorConfigWriteAuthority,
  assertUpdateDoctorConfigInputHash,
  recordUpdateDoctorConfigWrite,
} from "../infra/update-doctor-result.js";
import { initializeNativeSessionCatalogPreferences } from "../plugins/native-session-catalog-config.js";
import { assertAgentDeletionTargetsUnchanged } from "./agent-workspace-roster-transition.js";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { collectChangedPaths, collectConfigWriteChangedPaths } from "./config-change-paths.js";
import { cloneEnvWithPlatformSemantics, createConfigRuntimeEnvBase } from "./config-env-vars.js";
import {
  configSnapshotAuditRecordMatchesPath,
  fingerprintConfigSnapshotAuthoredConfig,
  readLatestConfigSnapshotAuditRecordAsync,
  restoreConfigSnapshotAuditRecordAsync,
  upsertConfigSnapshotAuditRecordAsync,
} from "./config-journal-snapshot.js";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "./config-path-mutation.js";
import { assertConfigWriteAllowedInCurrentMode } from "./config-write-guard.js";
import {
  readConfigWriteMigrationFacts,
  preserveDeferredPluginMigrationConfig,
  setDeferredPluginMigrationConfigFacts,
} from "./deferred-plugin-migration-config.js";
import { resolveKeyedAgentEntryIncludePreservation } from "./include-write-boundary.js";
import {
  appendConfigAuditRecord,
  capConfigAuditIssues,
  capConfigAuditPaths,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  type ConfigWriteAuditResult,
} from "./io.audit.js";
import type { ConfigIoContext } from "./io.context.js";
import * as cronOwnerWrite from "./io.cron-owner-refusal.js";
import {
  projectWebhookMigrationIncludeWrite,
  recordConfigWriteMetadata,
  resolveConfigWriteStateSelection,
  stampConfigWriteMetadata,
  withConfigWriteState,
} from "./io.meta.js";
import {
  advanceConfigHealthBaselineForAcceptedWrite,
  captureConfigHealthBaselineForWrite,
  restoreConfigHealthBaselineForRolledBackWrite,
} from "./io.observe.js";
import {
  containsConfigIncludeDirective,
  hashConfigRaw,
  hashConfigRevision,
  hasConfigMeta,
  resolveConfigForRead,
  resolveGatewayMode,
  restoreAuthoredTildePathsForWrite,
} from "./io.read-helpers.js";
import {
  loggedConfigWarningFingerprints,
  restoreLoggedConfigWarningFingerprint,
} from "./io.state.js";
import {
  ConfigRuntimeRefreshError,
  configWriteCommittedSnapshot,
  configWritePostCommitRollback,
  type ConfigWriteInputBasis,
  type ConfigWriteOptions,
  type InternalConfigWriteResult,
  type ReadConfigFileSnapshotInternalResult,
} from "./io.types.js";
import { logConfigWarningsOnce } from "./io.warnings.js";
import {
  ConfigWritePostCommitError,
  createConfigValidationFailedError,
  type ConfigWriteRollbackStatus,
} from "./io.write-errors.js";
import { injectExplicitlySetPaths, resolvePersistCandidateForWrite } from "./io.write-prepare.js";
import { rejectConfigWriteForBlockingReasons } from "./io.write-rejected.js";
import {
  assertBaseSnapshotStillCurrent,
  createConfigFileWriteGuard,
  resolveConfigSizeBaselineBytes,
  resolveConfigStatMetadata,
  resolveConfigWriteBlockingReasons,
  resolveConfigWriteSuspiciousReasons,
  rollbackConfigFileWriteIfUnchanged,
} from "./io.write-safety.js";
import { prepareConfigWriteTopology } from "./io.write-topology.js";
import { formatConfigIssueLines } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { applyMergePatch, createMergePatch } from "./merge-patch.js";
import { resolveStateDir } from "./paths.js";
import { setConfigResolutionFacts } from "./resolution-facts.js";
import { preflightRuntimeSnapshotWrite } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";
import { rejectConfigNonFiniteNumbers } from "./value-tree.js";
import { bindConfigWriteLockGuard } from "./write-authority.js";
import { captureConfigWriteLockGuard } from "./write-lock.js";

export async function writeConfigFileFromContext(
  context: ConfigIoContext,
  cfg: OpenClawConfig,
  writeOptions: ConfigWriteOptions,
  readSnapshot: () => Promise<ReadConfigFileSnapshotInternalResult>,
): Promise<InternalConfigWriteResult> {
  const { deps, configPath, options: ioOptions } = context;
  const stateContext = { env: deps.env, homedir: deps.homedir };
  const sourceGuard = captureConfigWriteLockGuard(configPath);
  const doctorAuthority = getUpdateDoctorConfigWriteAuthority(configPath);
  let options = bindConfigWriteLockGuard(writeOptions, sourceGuard);
  const databaseAccessAllowed = options.databaseAccess !== "none";
  options.assertConfigPathForWrite?.();
  assertConfigWriteAllowedInCurrentMode({ configPath, env: deps.env });
  const unsetPaths = resolveManagedUnsetPathsForWrite(options.unsetPaths);
  const snapshotRead = options.baseSnapshot
    ? {
        snapshot: options.baseSnapshot,
        pluginMetadataSnapshot: options.basePluginMetadataSnapshot,
      }
    : await readSnapshot();
  const snapshot = snapshotRead.snapshot;
  const pendingMigrations = databaseAccessAllowed
    ? await readConfigWriteMigrationFacts(snapshot, deps.env, ioOptions)
    : undefined;
  const configForWrite = preserveDeferredPluginMigrationConfig({
    sourceConfig: snapshot.sourceConfig,
    nextConfig: cfg,
    pending: pendingMigrations ?? [],
    writeOptions: options,
  });
  if (doctorAuthority) {
    sourceGuard?.();
    assertUpdateDoctorConfigInputHash(configPath, hashConfigRaw(snapshot.raw));
    options = { ...options, baseSnapshot: snapshot };
  }
  if (options.baseSnapshot) {
    assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
  }

  const {
    nextConfig,
    clearedSessionStoreOwner,
    authoredConfig,
    authoredSourceConfig,
    authoredRuntimeConfig,
    explicitSetPaths,
    explicitSetValueSource,
    persistCanonicalAgentRoster,
    preserveLegacyAgentRoster,
    cronOwner,
  } = await prepareConfigWriteTopology({
    ...snapshotRead,
    nextConfig: configForWrite,
    options,
    unsetPaths,
    env: deps.env,
    lowerPrecedenceEnv: deps.lowerPrecedenceEnv,
    homedir: deps.homedir,
  });
  const inputBasis: ConfigWriteInputBasis = {
    kind: options.inputBase ?? "runtime",
    config: options.inputBase === "source" ? authoredSourceConfig : authoredRuntimeConfig,
  };
  const cronSourceConfig = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const cronOwnerRefusal =
    cronOwner &&
    !(await cronOwnerWrite.canDeferRehearsalCronMigration(cronSourceConfig, configPath, deps.env))
      ? await cronOwnerWrite.prepareCronOwnerWriteRefusal(snapshot.config, {
          storePath: await resolveCronJobsStorePathFromConfigAsync(nextConfig, deps.env),
          ...cronOwner,
          env: deps.env,
        })
      : undefined;

  let persistCandidate: unknown = authoredConfig;
  const changedPaths = collectConfigWriteChangedPaths(inputBasis.config, authoredConfig, [
    ...explicitSetPaths,
    ...(options.unsetPaths ?? []),
  ]);
  const hasAuthoredIncludes = containsConfigIncludeDirective(snapshot.parsed);
  // Preserve roster includes during Doctor repairs; bootstrap rosters use explicitSetPaths.
  if (snapshot.valid || (snapshot.exists && hasAuthoredIncludes)) {
    const webhookMigration = hasAuthoredIncludes
      ? projectWebhookMigrationIncludeWrite(authoredSourceConfig, authoredConfig)
      : undefined;
    const keyedAgentEntryIncludes = resolveKeyedAgentEntryIncludePreservation({
      configPath: snapshot.path,
      provenance: snapshot.includeProvenance,
    });
    persistCandidate = resolvePersistCandidateForWrite({
      inputBasis,
      runtimeConfig: authoredRuntimeConfig,
      sourceConfig: authoredSourceConfig,
      sourceConfigValid: snapshot.valid,
      sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
      nextConfig: webhookMigration?.config ?? authoredConfig,
      rootAuthoredConfig: snapshot.parsed,
      agentRosterIncludeOwned: snapshot.agentRosterIncludeOwned,
      keyedAgentEntryIncludePaths: keyedAgentEntryIncludes?.includePaths,
      unsetPaths,
      explicitSetPaths: explicitSetPaths.filter(
        (field) => !webhookMigration?.paths.some((pin) => isDeepStrictEqual(pin, field)),
      ),
      explicitSetValueSource,
      persistCanonicalAgentRoster,
      allowedAgentRosterRemovals: options.allowedAgentRosterRemovals,
      allowIncludeAncestorExplicitSetPaths: options.allowIncludeAncestorExplicitSetPaths,
      preserveLegacyAgentRoster,
    });
    if (webhookMigration) {
      persistCandidate = injectExplicitlySetPaths({
        valueSource: authoredConfig,
        persistedCandidate: persistCandidate,
        runtimeConfig: authoredRuntimeConfig,
        sourceConfig: authoredSourceConfig,
        rootAuthoredConfig: snapshot.parsed,
        explicitSetPaths: webhookMigration.paths,
        allowIncludeAncestorExplicitSetPaths: true,
      });
    }
  }
  const validationEnvBase = createConfigRuntimeEnvBase(
    snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
    deps.env,
  );
  const resolveValidationCandidate = (candidate: unknown) => {
    // Validate removals now; apply them once to the final authored output after materialization.
    const config = applyUnsetPathsForWrite(candidate, unsetPaths);
    if (containsConfigIncludeDirective(config)) {
      return context.resolveRuntimePreflightSourceConfig(
        config,
        undefined,
        undefined,
        validationEnvBase,
      );
    }
    // Plain writes resolve references without running the preflight's compatibility migrations.
    const resolution = resolveConfigForRead(
      config,
      cloneEnvWithPlatformSemantics(validationEnvBase),
      deps.lowerPrecedenceEnv,
    );
    setConfigResolutionFacts(resolution.resolvedConfigRaw, resolution.resolutionFacts);
    return resolution.resolvedConfigRaw;
  };
  const validationCandidate = resolveValidationCandidate(persistCandidate);
  const validateCandidate = (candidate: unknown) => {
    const result = validateConfigObjectRawWithPlugins(candidate, {
      ...context.pathResolution,
      pluginValidation: options.skipPluginValidation ? "skip" : "full",
      semanticValidation: "strict",
      preservedLegacyRootKeys: options.preservedLegacyRootKeys,
      deferredPluginMigrations: pendingMigrations,
    });
    if (!result.ok) {
      throw createConfigValidationFailedError(result.issues);
    }
    return result;
  };
  // Validate authored structure before stamping can replace malformed parents.
  validateCandidate(validationCandidate);
  // SAFETY: the original resolved input was just validated; retain raw values, not parser defaults.
  const validatedCandidate = validationCandidate as OpenClawConfig;
  const previousSource =
    snapshot.authoredConfig ?? snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const materialized = stampConfigWriteMetadata(
    snapshot.exists
      ? validatedCandidate
      : initializeNativeSessionCatalogPreferences(validatedCandidate),
    options.lastTouchedVersionOverride,
    snapshot.exists ? previousSource : null,
    deps.env,
  );
  // Resolve policy from included facts, but persist only its delta beside authored directives.
  persistCandidate = applyMergePatch(
    persistCandidate,
    createMergePatch(validationCandidate, materialized),
  );
  const validated = validateCandidate(resolveValidationCandidate(persistCandidate));
  const previousWarningFingerprint = loggedConfigWarningFingerprints.get(configPath);
  // Capture before commit so rollback cannot restore a watcher-updated slot.
  options.assertConfigPathForWrite?.();
  let stateSelection = databaseAccessAllowed
    ? await resolveConfigWriteStateSelection(snapshot.sourceConfig, deps.env)
    : undefined;
  const priorSnapshotAuditRecord = await withConfigWriteState(stateSelection, () =>
    readLatestConfigSnapshotAuditRecordAsync(stateContext, options.assertConfigPathForWrite),
  );

  options.assertConfigPathForWrite?.();
  await deps.fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const tildeRestoredOutputConfig = restoreAuthoredTildePathsForWrite(
    persistCandidate,
    snapshot.parsed,
    undefined,
    deps.homedir(),
  ) as OpenClawConfig;
  const stampedOutputConfig = stampConfigWriteMetadata(
    preserveDeferredPluginMigrationConfig({
      sourceConfig: snapshot.parsed,
      nextConfig: applyUnsetPathsForWrite(tildeRestoredOutputConfig, unsetPaths),
      pending: pendingMigrations ?? [],
      writeOptions: { unsetPaths: options.unsetPaths },
    }),
    options.lastTouchedVersionOverride,
    undefined,
    deps.env,
  );
  rejectConfigNonFiniteNumbers(stampedOutputConfig);
  const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
  const nextHash = hashConfigRaw(json);
  const previousHash = hashConfigRaw(snapshot.raw);
  const previousBytes =
    typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
  const sizeBaselineBytes = resolveConfigSizeBaselineBytes({
    raw: snapshot.raw,
    lastTouchedVersionOverride: options.lastTouchedVersionOverride,
    env: deps.env,
  });
  const nextBytes = Buffer.byteLength(json, "utf-8");
  const previousStat = snapshot.exists
    ? await deps.fs.promises.stat(configPath).catch(() => null)
    : null;
  const hasMetaBefore = hasConfigMeta(snapshot.parsed);
  const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
  const includeFileHashes: Record<string, string> = {};
  const includeFileTargets: Record<string, string> = {};
  const sourceConfigForPreflight = context.resolveRuntimePreflightSourceConfig(
    // Receipts must reflect JSON omissions, just like a later read of this file.
    JSON.parse(json),
    includeFileHashes,
    includeFileTargets,
    validationEnvBase,
  );
  const committedRevision = hashConfigRevision(json, includeFileHashes, includeFileTargets);
  // Compare resolved modes: an unchanged authored $include has no local mode literal.
  const gatewayModeAfter = resolveGatewayMode(sourceConfigForPreflight);
  const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
    existsBefore: snapshot.exists,
    unreadableBefore: snapshot.readError != null,
    sizeBaselineBytes,
    nextBytes,
    hasMetaBefore,
    gatewayModeBefore,
    gatewayModeAfter,
  });

  const readTestLogFlag = (name: string) => isVitestRuntimeEnv(deps.env) && deps.env[name] === "1";
  const logConfigOverwrite = () => {
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (!snapshot.exists || options.skipOutputLogs || (isVitestRuntimeEnv(deps.env) && !testLog)) {
      return;
    }
    if (!isVerbose() && deps.env.OPENCLAW_CONFIG_OVERWRITE_LOG !== "1" && !testLog) {
      return;
    }
    deps.logger.warn(
      formatConfigOverwriteLogMessage({
        configPath,
        previousHash: previousHash ?? null,
        nextHash,
        changedPathCount: changedPaths.size,
      }),
    );
  };
  const logConfigWriteAnomalies = () => {
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (
      suspiciousReasons.length === 0 ||
      options.skipOutputLogs ||
      (isVitestRuntimeEnv(deps.env) && !testLog)
    ) {
      return;
    }
    const showMissingMeta =
      isVerbose() || deps.env.OPENCLAW_CONFIG_WRITE_ANOMALY_LOG === "1" || testLog;
    const visibleReasons = showMissingMeta
      ? suspiciousReasons
      : suspiciousReasons.filter((reason) => reason !== "missing-meta-before-write");
    if (visibleReasons.length > 0) {
      deps.logger.warn(`Config write anomaly: ${configPath} (${visibleReasons.join(", ")})`);
    }
  };

  const auditRecordBase = createConfigWriteAuditRecordBase({
    configPath,
    env: deps.env,
    existsBefore: snapshot.exists,
    previousHash: previousHash ?? null,
    nextHash,
    previousBytes,
    nextBytes,
    previousMetadata: resolveConfigStatMetadata(previousStat),
    changedPathCount: changedPaths.size,
    changedPaths: [...changedPaths],
    origin: options.auditOrigin,
    hasMetaBefore,
    hasMetaAfter: hasConfigMeta(stampedOutputConfig),
    gatewayModeBefore,
    gatewayModeAfter,
    suspicious: suspiciousReasons,
  });
  const appendWriteAudit = async (
    result: ConfigWriteAuditResult,
    error?: unknown,
    nextStat?: fs.Stats | null,
  ) => {
    options.assertConfigPathForWrite?.();
    await withConfigWriteState(stateSelection, () =>
      appendConfigAuditRecord({
        ...stateContext,
        record: finalizeConfigWriteAuditRecord({
          base: auditRecordBase,
          result,
          err: error,
          nextMetadata: resolveConfigStatMetadata(nextStat ?? null),
        }),
      }),
    );
  };
  const blockingReasons = resolveConfigWriteBlockingReasons(suspiciousReasons, options);
  await rejectConfigWriteForBlockingReasons({
    deps,
    configPath,
    json,
    blockingReasons,
    allowDestructiveWrite: options.allowDestructiveWrite,
    assertConfigPathForWrite: options.assertConfigPathForWrite,
    appendWriteAudit,
  });

  const preCommitRuntimePreflight =
    options.preCommitRuntimePreflight ??
    (async (sourceConfig: OpenClawConfig) => {
      await preflightRuntimeSnapshotWrite({
        nextSourceConfig: sourceConfig,
        refreshOptions: options.runtimeRefresh,
        formatRefreshError: (error) => formatErrorMessage(error),
        createRefreshError: (detail, cause) =>
          new ConfigRuntimeRefreshError(
            `Config write blocked before committing ${configPath}: active SecretRef resolution failed: ${detail}`,
            { cause },
          ),
      });
    });
  await preCommitRuntimePreflight(sourceConfigForPreflight);

  const publication: { phase: "unpublished" | "removed" | "published" | "accepted" } = {
    phase: "unpublished",
  };
  let restoreFile: ((assertCurrent: () => void) => Promise<boolean>) | undefined;
  let rollbackStatus: ConfigWriteRollbackStatus = "not-restored";
  const stateDirectory = {
    path: resolveStateDir(deps.env, deps.homedir),
    warn: (message: string) => deps.logger.warn(message),
  };
  try {
    options.assertConfigPathForWrite?.();
    if (options.baseSnapshot) {
      assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
    }
    options.assertConfigPathForWrite?.();
    await cronOwnerRefusal?.recheck();
    options.assertConfigPathForWrite?.();
    warnIfJSON5CommentsWillBeStripped({
      raw: snapshot.raw,
      filePath: configPath,
      warn: (message) => deps.logger.warn(message),
      skipOutputLogs: options.skipOutputLogs,
    });
    const writeGuard = createConfigFileWriteGuard(
      configPath,
      deps.fs,
      options.assertConfigPathForWrite,
      {
        snapshot,
        stateDirectory,
        includeGraph: { hashes: includeFileHashes, targets: includeFileTargets },
        onRootRemoved: () => {
          publication.phase = "removed";
        },
        onRootPublished: () => {
          publication.phase = "published";
        },
      },
    );
    // The writer owns compensation identity; callers supply the still-live enclosing owner.
    restoreFile = (assertCurrent) =>
      rollbackConfigFileWriteIfUnchanged({
        configPath,
        previousSnapshot: snapshot,
        committedHash: publication.phase === "removed" ? hashConfigRaw(null) : nextHash,
        fsModule: deps.fs,
        stateDirectory,
        ...writeGuard.captureRollbackProof(assertCurrent),
        withPublication: (publish, didMutate) =>
          databaseAccessAllowed
            ? withDeferredPluginConfigRollback(
                { configPath, env: deps.env, assertCurrent },
                publish,
                didMutate,
              )
            : publish(),
      });
    await using preparedFile = await prepareConfigFileWrite({
      configPath,
      dirMode: readExistingStateRootMode(path.dirname(configPath), stateDirectory.path, deps.fs),
      content: json,
      previousRaw: snapshot.raw,
      fsModule: writeGuard.fileSystem,
      assertCurrent: writeGuard.assertCurrent,
      assertBeforeMutation: writeGuard.assertBeforeMutation,
      onDestinationState: writeGuard.onDestinationState,
    });
    await assertAgentDeletionTargetsUnchanged(snapshot.config, sourceConfigForPreflight, deps.env);
    await options.beforeCommit?.();
    const healthBaselineCapture = databaseAccessAllowed
      ? await captureConfigHealthBaselineForWrite(deps, configPath)
      : null;
    const publish = () => {
      options.assertBeforePublish?.();
      const published = preparedFile.publish();
      publication.phase = "published";
      return published;
    };
    const result = databaseAccessAllowed
      ? withDeferredPluginMigrationsCurrent(
          { env: deps.env, configPath, expectedPending: pendingMigrations },
          publish,
        )
      : publish();
    options.assertConfigPathForWrite?.();
    publication.phase = "accepted";
    recordUpdateDoctorConfigWrite(configPath, previousHash, nextHash, snapshot.parsed, json);
    const acceptedStateSelection = databaseAccessAllowed
      ? await resolveConfigWriteStateSelection(sourceConfigForPreflight, deps.env)
      : undefined;
    stateSelection = acceptedStateSelection;
    options.assertConfigPathForWrite?.();
    await recordConfigWriteMetadata(deps, acceptedStateSelection);
    logConfigOverwrite();
    logConfigWriteAnomalies();
    await appendWriteAudit(
      result.method,
      undefined,
      await deps.fs.promises.stat(configPath).catch(() => null),
    );
    const healthBaselineCompensation = await withConfigWriteState(acceptedStateSelection, () =>
      advanceConfigHealthBaselineForAcceptedWrite(deps, healthBaselineCapture, {
        sourceSnapshot: snapshot,
        raw: json,
        parsed: stampedOutputConfig,
        resolved: sourceConfigForPreflight,
      }),
    );
    options.assertConfigPathForWrite?.();
    if (
      acceptedStateSelection?.ok &&
      configSnapshotAuditRecordMatchesPath(priorSnapshotAuditRecord, configPath) &&
      priorSnapshotAuditRecord.rawHash !== previousHash
    ) {
      const offlineChangedPaths = new Set<string>();
      collectChangedPaths(
        priorSnapshotAuditRecord.fingerprintedAuthoredConfig,
        fingerprintConfigSnapshotAuthoredConfig(snapshot.parsed, stateContext),
        "",
        offlineChangedPaths,
      );
      await withConfigWriteState(acceptedStateSelection, () =>
        appendConfigAuditRecord({
          ...stateContext,
          record: {
            ts: new Date().toISOString(),
            source: "config-io",
            event: "config.external",
            detectedBy: "write",
            configPath,
            previousHash: priorSnapshotAuditRecord.rawHash,
            nextHash: previousHash ?? null,
            valid: snapshot.valid,
            ...(snapshot.valid
              ? offlineChangedPaths.size > 0
                ? { changedPaths: capConfigAuditPaths([...offlineChangedPaths]) }
                : { opaqueChange: true }
              : {
                  issues: capConfigAuditIssues(
                    formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }),
                  ),
                }),
          },
        }),
      );
    }
    options.assertConfigPathForWrite?.();
    const writtenSnapshotAuditRecord = await withConfigWriteState(acceptedStateSelection, () =>
      upsertConfigSnapshotAuditRecordAsync(
        {
          ...stateContext,
          configPath,
          rawHash: nextHash,
          authoredConfig: stampedOutputConfig,
          expectedSnapshot: priorSnapshotAuditRecord,
        },
        options.assertConfigPathForWrite,
      ),
    );
    options.assertConfigPathForWrite?.();
    if (!options.skipPluginValidation) {
      logConfigWarningsOnce({ configPath, warnings: validated.warnings, logger: deps.logger });
    }
    if (clearedSessionStoreOwner && !options.skipOutputLogs) {
      deps.logger.warn(
        "Cleared agents.defaults.sessionStore.agentId because session.store changed. Set that owner path explicitly to assign the destination store's owner.",
      );
    }
    setDeferredPluginMigrationConfigFacts(sourceConfigForPreflight, pendingMigrations);
    return {
      persistedHash: nextHash,
      persistedConfig: stampedOutputConfig,
      persistedSourceConfig: sourceConfigForPreflight,
      [configWriteCommittedSnapshot]: {
        hash: committedRevision,
        sourceConfig: sourceConfigForPreflight,
      },
      [configWritePostCommitRollback]: {
        restoreFile,
        restoreEffects: async (assertCurrent) => {
          assertCurrent();
          await withConfigWriteState(acceptedStateSelection, () =>
            restoreConfigSnapshotAuditRecordAsync(
              {
                ...stateContext,
                snapshot: priorSnapshotAuditRecord,
                expectedSnapshot: writtenSnapshotAuditRecord,
              },
              assertCurrent,
            ),
          );
          assertCurrent();
          restoreLoggedConfigWarningFingerprint(configPath, previousWarningFingerprint);
          await withConfigWriteState(acceptedStateSelection, () =>
            restoreConfigHealthBaselineForRolledBackWrite(deps, healthBaselineCompensation),
          );
        },
      },
    };
  } catch (error) {
    let failure = error;
    if (restoreFile && (publication.phase === "removed" || publication.phase === "published")) {
      try {
        rollbackStatus = (await restoreFile(() => sourceGuard?.())) ? "restored" : "not-restored";
      } catch (rollbackError) {
        rollbackStatus = "unknown";
        failure = new AggregateError(
          [error, rollbackError],
          `${formatErrorMessage(error)} Recovery failed: ${formatErrorMessage(rollbackError)}`,
        );
      }
    }
    try {
      try {
        sourceGuard?.();
      } catch (ownershipError) {
        if (ownershipError === error) {
          throw error;
        }
        throw new AggregateError(
          [error, ownershipError],
          `Config write failed after source ownership changed: ${formatErrorMessage(error)}`,
          { cause: ownershipError },
        );
      }
      try {
        writeOptions.assertConfigPathForWrite?.();
      } catch {
        // Lost path provenance forbids auditing, but does not replace the original failure.
        throw error;
      }
      try {
        await appendWriteAudit("failed", error);
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          `${formatErrorMessage(error)} Failure auditing failed: ${formatErrorMessage(auditError)}`,
          { cause: auditError },
        );
      }
    } catch (failureDuringAudit) {
      failure = failureDuringAudit;
    }
    if (publication.phase === "unpublished") {
      throw failure;
    }
    throw new ConfigWritePostCommitError({
      configPath,
      rollbackStatus,
      cause: failure,
      publication: publication.phase === "removed" ? "partial" : "complete",
    });
  }
}
