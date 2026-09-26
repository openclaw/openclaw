import type fs from "node:fs";
import path from "node:path";
import { err, ok } from "@openclaw/normalization-core/result";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { isVerbose } from "../global-state.js";
import {
  readDeferredPluginMigrations,
  withDeferredPluginMigrationsCurrent,
} from "../infra/deferred-plugin-migrations.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getUpdateDoctorConfigWriteAuthority,
  assertUpdateDoctorConfigInputHash,
  recordUpdateDoctorConfigWrite,
} from "../infra/update-doctor-result.js";
import { initializeNativeSessionCatalogPreferences } from "../plugins/native-session-catalog-config.js";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { collectChangedPaths } from "./config-change-paths.js";
import { cloneEnvWithPlatformSemantics, createConfigRuntimeEnvBase } from "./config-env-vars.js";
import {
  configSnapshotAuditRecordMatchesPath,
  fingerprintConfigSnapshotAuthoredConfig,
  readLatestConfigSnapshotAuditRecord,
  restoreConfigSnapshotAuditRecord,
  upsertConfigSnapshotAuditRecord,
} from "./config-journal-snapshot.js";
import {
  applyUnsetPathsForWrite,
  resolveManagedUnsetPathsForWrite,
} from "./config-path-mutation.js";
import { assertConfigWriteAllowedInCurrentMode } from "./config-write-guard.js";
import {
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
import { prepareCronOwnerWriteRefusal } from "./io.cron-owner-refusal.js";
import { recordConfigWriteMetadata, stampConfigWriteMetadata } from "./io.meta.js";
import {
  containsConfigIncludeDirective,
  hashConfigRaw,
  hasConfigMeta,
  resolveConfigForRead,
  resolveGatewayMode,
  restoreAuthoredTildePathsForWrite,
} from "./io.read-helpers.js";
import { hashConfigRevision } from "./io.snapshot.js";
import { loggedConfigWarningFingerprints, setBoundedConfigIoWarningEntry } from "./io.state.js";
import type {
  ConfigWriteInputBasis,
  ConfigWriteOptions,
  InternalConfigWriteResult,
  ReadConfigFileSnapshotInternalResult,
} from "./io.types.js";
import {
  ConfigRuntimeRefreshError,
  configWriteCommittedSnapshot,
  configWritePostCommitRollback,
} from "./io.types.js";
import { logConfigWarningsOnce } from "./io.warnings.js";
import {
  ConfigWritePostCommitError,
  createConfigValidationFailedError,
  type ConfigWriteRollbackStatus,
} from "./io.write-errors.js";
import { resolvePersistCandidateForWrite } from "./io.write-prepare.js";
import {
  assertBaseSnapshotStillCurrent,
  createGuardedConfigFileSystem,
  formatConfigArtifactTimestamp,
  resolveConfigSizeBaselineBytes,
  resolveConfigStatMetadata,
  resolveConfigWriteBlockingReasons,
  resolveConfigWriteSuspiciousReasons,
  rollbackConfigFileWriteIfUnchanged,
  tightenStateDirPermissionsIfNeeded,
} from "./io.write-safety.js";
import { prepareConfigWriteTopology } from "./io.write-topology.js";
import { formatConfigIssueLines } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { applyMergePatch, createMergePatch } from "./merge-patch.js";
import { setConfigResolutionFacts } from "./resolution-facts.js";
import { preflightRuntimeSnapshotWrite } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";
import { rejectConfigNonFiniteNumbers } from "./value-tree.js";
import { captureConfigWriteLockGuard } from "./write-lock.js";

export async function writeConfigFileFromContext(
  context: ConfigIoContext,
  cfg: OpenClawConfig,
  writeOptions: ConfigWriteOptions,
  readSnapshot: () => Promise<ReadConfigFileSnapshotInternalResult>,
): Promise<InternalConfigWriteResult> {
  const { deps, configPath } = context;
  let options = writeOptions;
  const sourceGuard = captureConfigWriteLockGuard(configPath);
  const doctorAuthority = getUpdateDoctorConfigWriteAuthority(configPath);
  if (sourceGuard) {
    const original = options;
    options = {
      ...options,
      assertConfigPathForWrite: () => {
        sourceGuard();
        original.assertConfigPathForWrite?.();
      },
      beforeCommit: async () => {
        await original.beforeCommit?.();
        sourceGuard();
      },
    };
  }
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
  const deferredPluginMigrations = readDeferredPluginMigrations({ env: deps.env });
  const configForWrite = preserveDeferredPluginMigrationConfig({
    sourceConfig: snapshot.sourceConfig,
    nextConfig: cfg,
    pending: deferredPluginMigrations,
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
  } = prepareConfigWriteTopology({
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
  const cronOwnerRefusal = cronOwner
    ? await prepareCronOwnerWriteRefusal(snapshot.config, {
        storePath: resolveCronJobsStorePathFromConfig(nextConfig, deps.env),
        ...cronOwner,
        env: deps.env,
      })
    : undefined;

  let persistCandidate: unknown = authoredConfig;
  const changedPaths = new Set<string>();
  collectChangedPaths(inputBasis.config, authoredConfig, "", changedPaths);
  for (const changedPath of [...explicitSetPaths, ...(options.unsetPaths ?? [])]) {
    const normalizedPath = changedPath.filter((segment) => segment.length > 0).join(".");
    if (normalizedPath) {
      changedPaths.add(normalizedPath);
    }
  }
  const hasAuthoredIncludes = containsConfigIncludeDirective(snapshot.parsed);
  // Doctor repairs need the same authored projection so roster moves preserve nested includes.
  // Missing snapshots also use this owner; exact bootstrap rosters carry explicitSetPaths.
  if (snapshot.valid || (snapshot.exists && hasAuthoredIncludes)) {
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
      nextConfig: authoredConfig,
      rootAuthoredConfig: snapshot.parsed,
      agentRosterIncludeOwned: snapshot.agentRosterIncludeOwned,
      keyedAgentEntryIncludePaths: keyedAgentEntryIncludes?.includePaths,
      unsetPaths,
      explicitSetPaths,
      explicitSetValueSource,
      persistCanonicalAgentRoster,
      allowedAgentRosterRemovals: options.allowedAgentRosterRemovals,
      allowIncludeAncestorExplicitSetPaths: options.allowIncludeAncestorExplicitSetPaths,
      preserveLegacyAgentRoster,
    });
  }
  const validationEnvBase = createConfigRuntimeEnvBase(
    snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
    deps.env,
  );
  const resolveValidationCandidate = (candidate: unknown) => {
    // Validate removals now; apply them once to the final authored output after materialization.
    const config = applyUnsetPathsForWrite(candidate as OpenClawConfig, unsetPaths);
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
      deferredPluginMigrations,
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
    undefined,
    options.lastTouchedVersionOverride,
    snapshot.exists ? previousSource : null,
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
  const priorSnapshotAuditRecord = readLatestConfigSnapshotAuditRecord({
    env: deps.env,
    homedir: deps.homedir,
  });

  options.assertConfigPathForWrite?.();
  await deps.fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await tightenStateDirPermissionsIfNeeded({
    configPath,
    env: deps.env,
    homedir: deps.homedir,
    fsModule: deps.fs,
    assertConfigPathForWrite: options.assertConfigPathForWrite,
  });
  const tildeRestoredOutputConfig = restoreAuthoredTildePathsForWrite(
    persistCandidate,
    snapshot.parsed,
    undefined,
    deps.homedir(),
  ) as OpenClawConfig;
  const outputConfig = preserveDeferredPluginMigrationConfig({
    sourceConfig: snapshot.parsed,
    nextConfig: applyUnsetPathsForWrite(tildeRestoredOutputConfig, unsetPaths),
    pending: deferredPluginMigrations,
  });
  const stampedOutputConfig = stampConfigWriteMetadata(
    outputConfig,
    undefined,
    options.lastTouchedVersionOverride,
  );
  rejectConfigNonFiniteNumbers(stampedOutputConfig);
  const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
  const nextHash = hashConfigRaw(json);
  const previousHash = hashConfigRaw(snapshot.raw);
  const changedPathCount = changedPaths.size;
  const previousBytes =
    typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
  const sizeBaselineBytes = resolveConfigSizeBaselineBytes({
    raw: snapshot.raw,
    json5: deps.json5,
    lastTouchedVersionOverride: options.lastTouchedVersionOverride,
  });
  const nextBytes = Buffer.byteLength(json, "utf-8");
  const previousStat = snapshot.exists
    ? await deps.fs.promises.stat(configPath).catch(() => null)
    : null;
  const hasMetaBefore = hasConfigMeta(snapshot.parsed);
  const hasMetaAfter = hasConfigMeta(stampedOutputConfig);
  const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
  const includeFileHashes: Record<string, string> = {};
  const includeFileTargets: Record<string, string> = {};
  const sourceConfigForPreflight = context.resolveRuntimePreflightSourceConfig(
    stampedOutputConfig,
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
    if (
      !snapshot.exists ||
      options.skipOutputLogs ||
      (isVitestRuntimeEnv(deps.env) && !readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG"))
    ) {
      return;
    }
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (!isVerbose() && deps.env.OPENCLAW_CONFIG_OVERWRITE_LOG !== "1" && !testLog) {
      return;
    }
    deps.logger.warn(
      formatConfigOverwriteLogMessage({
        configPath,
        previousHash: previousHash ?? null,
        nextHash,
        changedPathCount,
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
    changedPathCount,
    changedPaths: [...changedPaths],
    origin: options.auditOrigin,
    hasMetaBefore,
    hasMetaAfter,
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
    await appendConfigAuditRecord({
      env: deps.env,
      homedir: deps.homedir,
      record: finalizeConfigWriteAuditRecord({
        base: auditRecordBase,
        result,
        err: error,
        nextMetadata: resolveConfigStatMetadata(nextStat ?? null),
      }),
    });
  };
  const blockingReasons = resolveConfigWriteBlockingReasons(suspiciousReasons, options);
  if (blockingReasons.length > 0 && options.allowDestructiveWrite !== true) {
    const rejectedPath = `${configPath}.rejected.${formatConfigArtifactTimestamp(new Date().toISOString())}`;
    // Only the completed exclusive create proves this payload is available for inspection.
    options.assertConfigPathForWrite?.();
    const rejectedSave = await deps.fs.promises
      .writeFile(rejectedPath, json, { encoding: "utf-8", mode: 0o600, flag: "wx" })
      .then(ok, err);
    const saveDetail = rejectedSave.ok
      ? `Rejected payload saved to ${rejectedPath}.`
      : `Rejected payload could not be saved to ${rejectedPath}: ${formatErrorMessage(rejectedSave.error)}.`;
    const message = `Config write rejected: ${configPath} (${blockingReasons.join(", ")}). ${saveDetail}`;
    const error = Object.assign(new Error(message), {
      code: "CONFIG_WRITE_REJECTED",
      ...(rejectedSave.ok ? { rejectedPath } : {}),
      reasons: blockingReasons,
    });
    deps.logger.warn(message);
    await appendWriteAudit("rejected", error);
    throw error;
  }

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
    const guardedFs = createGuardedConfigFileSystem(
      configPath,
      deps.fs,
      options.assertConfigPathForWrite,
      {
        snapshot,
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
        ...guardedFs.captureRollbackProof(assertCurrent),
      });
    await using preparedFile = await prepareConfigFileWrite({
      configPath,
      content: json,
      previousRaw: snapshot.raw,
      fsModule: guardedFs.fileSystem,
      assertCurrent: guardedFs.assertCurrent,
    });
    await options.beforeCommit?.();
    const result = withDeferredPluginMigrationsCurrent(
      { env: deps.env, expectedPending: deferredPluginMigrations },
      () => {
        const published = preparedFile.publish();
        publication.phase = "published";
        return published;
      },
    );
    options.assertConfigPathForWrite?.();
    publication.phase = "accepted";
    recordUpdateDoctorConfigWrite(configPath, previousHash, nextHash, snapshot.parsed, json);
    try {
      recordConfigWriteMetadata(new Date().toISOString(), options.lastTouchedVersionOverride);
    } catch (error) {
      deps.logger.warn(`Config metadata state update failed: ${formatErrorMessage(error)}`);
    }
    logConfigOverwrite();
    logConfigWriteAnomalies();
    await appendWriteAudit(
      result.method,
      undefined,
      await deps.fs.promises.stat(configPath).catch(() => null),
    );
    options.assertConfigPathForWrite?.();
    if (
      configSnapshotAuditRecordMatchesPath(priorSnapshotAuditRecord, configPath) &&
      priorSnapshotAuditRecord.rawHash !== previousHash
    ) {
      const offlineChangedPaths = new Set<string>();
      collectChangedPaths(
        priorSnapshotAuditRecord.fingerprintedAuthoredConfig,
        fingerprintConfigSnapshotAuthoredConfig(snapshot.parsed, {
          env: deps.env,
          homedir: deps.homedir,
        }),
        "",
        offlineChangedPaths,
      );
      await appendConfigAuditRecord({
        env: deps.env,
        homedir: deps.homedir,
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
      });
    }
    options.assertConfigPathForWrite?.();
    const writtenSnapshotAuditRecord = upsertConfigSnapshotAuditRecord({
      env: deps.env,
      homedir: deps.homedir,
      configPath,
      rawHash: nextHash,
      authoredConfig: stampedOutputConfig,
      expectedSnapshot: priorSnapshotAuditRecord,
    });
    if (!options.skipPluginValidation) {
      logConfigWarningsOnce({ configPath, warnings: validated.warnings, logger: deps.logger });
    }
    if (clearedSessionStoreOwner && !options.skipOutputLogs) {
      deps.logger.warn(
        "Cleared agents.defaults.sessionStore.agentId because session.store changed. Set that owner path explicitly to assign the destination store's owner.",
      );
    }
    setDeferredPluginMigrationConfigFacts(sourceConfigForPreflight, deferredPluginMigrations);
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
        restoreEffects: (assertCurrent) => {
          assertCurrent();
          restoreConfigSnapshotAuditRecord({
            env: deps.env,
            homedir: deps.homedir,
            snapshot: priorSnapshotAuditRecord,
            expectedSnapshot: writtenSnapshotAuditRecord,
          });
          if (previousWarningFingerprint === undefined) {
            loggedConfigWarningFingerprints.delete(configPath);
          } else {
            setBoundedConfigIoWarningEntry(
              loggedConfigWarningFingerprints,
              configPath,
              previousWarningFingerprint,
            );
          }
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
