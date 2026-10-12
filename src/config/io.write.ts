import type fs from "node:fs";
import path from "node:path";
import { err, ok } from "@openclaw/normalization-core/result";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { isVerbose } from "../global-state.js";
import {
  readConfigWritePendingMigrations,
  withDeferredPluginConfigRollback,
  withDeferredPluginMigrationsCurrent,
} from "../infra/deferred-plugin-migrations.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getUpdateDoctorConfigWriteAuthority,
  assertUpdateDoctorConfigInputHash,
  recordUpdateDoctorConfigWrite,
} from "../infra/update-doctor-result.js";
import { assertAgentDeletionTargetsUnchanged } from "./agent-workspace-roster-transition.js";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { collectChangedPaths } from "./config-change-paths.js";
import {
  configSnapshotAuditRecordMatchesPath,
  fingerprintConfigSnapshotAuthoredConfig,
  readLatestConfigSnapshotAuditRecordAsync,
  restoreConfigSnapshotAuditRecordAsync,
  upsertConfigSnapshotAuditRecordAsync,
} from "./config-journal-snapshot.js";
import { resolveManagedUnsetPathsForWrite } from "./config-path-mutation.js";
import { assertConfigWriteAllowedInCurrentMode } from "./config-write-guard.js";
import {
  preserveDeferredPluginMigrationConfig,
  setDeferredPluginMigrationConfigFacts,
} from "./deferred-plugin-migration-config.js";
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
import { recordConfigWriteMetadata } from "./io.meta.js";
import { hashConfigRaw, hasConfigMeta } from "./io.read-helpers.js";
import { loggedConfigWarningFingerprints, setBoundedConfigIoWarningEntry } from "./io.state.js";
import type {
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
  createConfigWriteSafetyRejectionError,
  type ConfigWriteRollbackStatus,
} from "./io.write-errors.js";
import { prepareConfigWritePayload } from "./io.write-payload.js";
import {
  assertBaseSnapshotStillCurrent,
  createConfigFileWriteGuard,
  formatConfigArtifactTimestamp,
  resolveConfigStatMetadata,
  resolveConfigWriteBlockingReasons,
  rollbackConfigFileWriteIfUnchanged,
} from "./io.write-safety.js";
import { prepareConfigWriteTopology } from "./io.write-topology.js";
import { formatConfigIssueLines } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { resolveStateDir } from "./paths.js";
import { preflightRuntimeSnapshotWrite } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";
import { composeConfigWriteAssertions } from "./write-authority.js";
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
      assertConfigPathForWrite: composeConfigWriteAssertions(
        sourceGuard,
        original.assertConfigPathForWrite,
      ),
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
  const deferredPluginMigrations = readConfigWritePendingMigrations(configPath, deps.env);
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

  const topology = await prepareConfigWriteTopology({
    ...snapshotRead,
    nextConfig: configForWrite,
    options,
    unsetPaths,
    env: deps.env,
    lowerPrecedenceEnv: deps.lowerPrecedenceEnv,
    homedir: deps.homedir,
  });
  const { nextConfig, clearedSessionStoreOwner, cronOwner } = topology;
  const cronOwnerRefusal = cronOwner
    ? await prepareCronOwnerWriteRefusal(snapshot.config, {
        storePath: resolveCronJobsStorePathFromConfig(nextConfig, deps.env),
        ...cronOwner,
        env: deps.env,
      })
    : undefined;
  const {
    json,
    stampedOutputConfig,
    validated,
    changedPaths,
    changedPathCount,
    nextHash,
    previousHash,
    previousBytes,
    nextBytes,
    hasMetaBefore,
    gatewayModeBefore,
    gatewayModeAfter,
    includeFileHashes,
    includeFileTargets,
    sourceConfigForPreflight,
    committedRevision,
    suspiciousReasons,
  } = prepareConfigWritePayload(context, snapshot, topology, options, deferredPluginMigrations);
  const previousWarningFingerprint = loggedConfigWarningFingerprints.get(configPath);
  // Capture before commit so rollback cannot restore a watcher-updated slot.
  options.assertConfigPathForWrite?.();
  const priorSnapshotAuditRecord = await readLatestConfigSnapshotAuditRecordAsync(
    { env: deps.env, homedir: deps.homedir },
    options.assertConfigPathForWrite,
  );

  options.assertConfigPathForWrite?.();
  await deps.fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const previousStat = snapshot.exists
    ? await deps.fs.promises.stat(configPath).catch(() => null)
    : null;

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
    const diagnosticMessage = `Config write rejected: ${configPath} (${blockingReasons.join(", ")}). ${saveDetail}`;
    const diagnosticError = Object.assign(new Error(diagnosticMessage), {
      code: "CONFIG_WRITE_REJECTED",
      ...(rejectedSave.ok ? { rejectedPath } : {}),
      reasons: blockingReasons,
    });
    const userFacingError = createConfigWriteSafetyRejectionError({
      reasons: blockingReasons,
      ...(rejectedSave.ok ? { rejectedPath } : {}),
    });
    deps.logger.warn(diagnosticMessage);
    await appendWriteAudit("rejected", diagnosticError);
    throw userFacingError;
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
          withDeferredPluginConfigRollback(
            { configPath, env: deps.env, assertCurrent },
            publish,
            didMutate,
          ),
      });
    await using preparedFile = await prepareConfigFileWrite({
      configPath,
      content: json,
      previousRaw: snapshot.raw,
      fsModule: writeGuard.fileSystem,
      assertCurrent: writeGuard.assertCurrent,
      assertBeforeMutation: writeGuard.assertBeforeMutation,
      onDestinationState: writeGuard.onDestinationState,
    });
    await assertAgentDeletionTargetsUnchanged(snapshot.config, sourceConfigForPreflight, deps.env);
    await options.beforeCommit?.();
    const result = withDeferredPluginMigrationsCurrent(
      { env: deps.env, configPath, expectedPending: deferredPluginMigrations },
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
      await recordConfigWriteMetadata();
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
    const writtenSnapshotAuditRecord = await upsertConfigSnapshotAuditRecordAsync(
      {
        env: deps.env,
        homedir: deps.homedir,
        configPath,
        rawHash: nextHash,
        authoredConfig: stampedOutputConfig,
        expectedSnapshot: priorSnapshotAuditRecord,
      },
      options.assertConfigPathForWrite,
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
        restoreEffects: async (assertCurrent) => {
          assertCurrent();
          await restoreConfigSnapshotAuditRecordAsync(
            {
              env: deps.env,
              homedir: deps.homedir,
              snapshot: priorSnapshotAuditRecord,
              expectedSnapshot: writtenSnapshotAuditRecord,
            },
            assertCurrent,
          );
          assertCurrent();
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
