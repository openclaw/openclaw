import path from "node:path";
import { err, ok } from "@openclaw/normalization-core/result";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import {
  readDeferredPluginMigrations,
  withDeferredPluginMigrationsCurrent,
} from "../infra/deferred-plugin-migrations.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getUpdateDoctorConfigWriteAuthority,
  assertUpdateDoctorConfigInputHash,
  recordUpdateDoctorConfigWrite,
} from "../infra/update-doctor-result.js";
import { initializeNativeSessionCatalogPreferences } from "../plugins/native-session-catalog-config.js";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { collectChangedPaths } from "./config-change-paths.js";
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
import {
  EnvRefArrayMutationError,
  restoreEnvRefsFromMap,
  restoreEnvVarRefs,
} from "./env-preserve.js";
import {
  publishStagedIncludeWrites,
  resolveIncludeWriteThroughPaths,
  restoreStagedIncludeWrites,
  restoreStagedIncludeWritesOrFold,
  stageIncludeWriteThrough,
  type IncludeWriteRestorer,
  type PendingIncludeWrite,
  type StagedIncludeWrite,
} from "./include-write-through.js";
import { readConfigIncludeFileWithGuards, resolveConfigIncludes } from "./includes.js";
import { appendConfigAuditRecord, capConfigAuditIssues, capConfigAuditPaths } from "./io.audit.js";
import type { ConfigIoContext } from "./io.context.js";
import { prepareCronOwnerWriteRefusal } from "./io.cron-owner-refusal.js";
import { recordConfigWriteMetadata } from "./io.meta.js";
import {
  collectEnvRefPaths,
  containsConfigIncludeDirective,
  hashConfigRaw,
  hasConfigMeta,
  parseConfigJson5,
  rejectConfigNonFiniteNumbers,
  resolveGatewayMode,
  restoreAuthoredTildePathsForWrite,
} from "./io.read-helpers.js";
import { getConfigSnapshotIncludeLoadGraph } from "./io.snapshot-shared.js";
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
import { createConfigWriteAuditLog } from "./io.write-audit-log.js";
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
  resolveConfigWriteBlockingReasons,
  resolveConfigWriteSuspiciousReasons,
  rollbackConfigFileWriteIfUnchanged,
  stampConfigVersion,
  tightenStateDirPermissionsIfNeeded,
} from "./io.write-safety.js";
import { prepareConfigWriteTopology } from "./io.write-topology.js";
import { formatConfigIssueLines } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { applyMergePatch, createMergePatch } from "./merge-patch.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { resolveIncludeRoots } from "./paths.js";
import { preflightRuntimeSnapshotWrite } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";
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
  // Caller-captured maps win; otherwise the graph the producing read bound to
  // this snapshot. Copied: publication advances written leaves in this write's
  // graph, and the read's load fact stays immutable for every other writer.
  const loadGraph =
    options.includeFileHashesForWrite && options.includeFileTargetsForWrite
      ? { hashes: options.includeFileHashesForWrite, targets: options.includeFileTargetsForWrite }
      : getConfigSnapshotIncludeLoadGraph(snapshot);
  const includeGraphForWrite = loadGraph ? structuredClone(loadGraph) : undefined;
  const hasAuthoredIncludes = containsConfigIncludeDirective(snapshot.parsed);
  if (hasAuthoredIncludes && !includeGraphForWrite) {
    // Every write over authored includes must bind a load graph; a snapshot
    // that lost it (cloned/spread) fails closed here, before any staging or
    // disk effect -- for root-only writes too, not only mixed ones.
    throw new ConfigMutationConflictError(
      "cannot verify included config is unchanged since last load; reload and retry",
    );
  }
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
  const inputBasis: ConfigWriteInputBasis = {
    kind: options.inputBase ?? "runtime",
    config: options.inputBase === "source" ? snapshot.sourceConfig : snapshot.runtimeConfig,
  };
  if (options.baseSnapshot) {
    assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
  }

  const {
    nextConfig,
    clearedSessionStoreOwner,
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
    homedir: deps.homedir,
  });
  const cronOwnerRefusal = cronOwner
    ? await prepareCronOwnerWriteRefusal(snapshot.config, {
        storePath: resolveCronJobsStorePathFromConfig(nextConfig, deps.env),
        ...cronOwner,
        env: deps.env,
      })
    : undefined;

  let persistCandidate: unknown = nextConfig;
  let envRefMap: Map<string, string> | null = null;
  let authoredPreviousSource: unknown;
  const changedPaths = new Set<string>();
  collectChangedPaths(inputBasis.config, nextConfig, "", changedPaths);
  for (const changedPath of [...explicitSetPaths, ...(options.unsetPaths ?? [])]) {
    const normalizedPath = changedPath.filter((segment) => segment.length > 0).join(".");
    if (normalizedPath) {
      changedPaths.add(normalizedPath);
    }
  }
  const identityRestoredPaths = new Set<string>();
  const hasIncludes = hasAuthoredIncludes && !containsConfigIncludeDirective(snapshot.sourceConfig);
  const pendingIncludeWrites: PendingIncludeWrite[] = [];
  const includeWriteRestorers: IncludeWriteRestorer[] = [];
  const envForRestore = options.envSnapshotForRestore ?? deps.env;
  let stagedIncludeWrites: StagedIncludeWrite[] = [];
  let includeReadOverlay: ReadonlyMap<string, string> | undefined;
  // Doctor repairs need the same authored projection so roster moves preserve nested includes.
  // Missing snapshots also use this owner; exact bootstrap rosters carry explicitSetPaths.
  if (snapshot.valid || (snapshot.exists && hasAuthoredIncludes)) {
    const { keyedAgentEntryIncludePaths, includeWriteThroughPaths } =
      resolveIncludeWriteThroughPaths({
        configPath: snapshot.path,
        provenance: snapshot.includeProvenance,
      });
    persistCandidate = resolvePersistCandidateForWrite({
      inputBasis,
      runtimeConfig: snapshot.config,
      sourceConfig: snapshot.resolved,
      sourceConfigValid: snapshot.valid,
      sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
      nextConfig,
      rootAuthoredConfig: snapshot.parsed,
      agentRosterIncludeOwned: snapshot.agentRosterIncludeOwned,
      keyedAgentEntryIncludePaths,
      includeWriteThroughPaths:
        includeWriteThroughPaths.length > 0 ? includeWriteThroughPaths : undefined,
      pendingIncludeWrites: includeWriteThroughPaths.length > 0 ? pendingIncludeWrites : undefined,
      unsetPaths,
      explicitSetPaths,
      explicitSetValueSource,
      persistCanonicalAgentRoster,
      allowedAgentRosterRemovals: options.allowedAgentRosterRemovals,
      allowIncludeAncestorExplicitSetPaths: options.allowIncludeAncestorExplicitSetPaths,
      preserveLegacyAgentRoster,
    });
    // Stage only (no disk effects); staged bytes feed the read overlay below.
    // No authored includes means no pending include writes, so a missing
    // graph here never needs staging.
    if (includeGraphForWrite) {
      ({ staged: stagedIncludeWrites, overlay: includeReadOverlay } =
        await stageIncludeWriteThrough({
          snapshot,
          pendingIncludeWrites,
          envForRestore,
          homedir: deps.homedir(),
          includeLoadGraph: includeGraphForWrite,
        }));
    }
  }
  if (snapshot.exists && (snapshot.valid || hasIncludes)) {
    try {
      const resolvedIncludes = resolveConfigIncludes(
        snapshot.parsed,
        configPath,
        {
          readFile: (candidate) => deps.fs.readFileSync(candidate, "utf-8"),
          readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
            readConfigIncludeFileWithGuards({
              includePath,
              resolvedPath,
              rootRealDir,
              ioFs: deps.fs,
            }),
          parseJson: (raw) => deps.json5.parse(raw),
        },
        { allowedRoots: resolveIncludeRoots(deps.env, deps.homedir) },
      );
      const collected = new Map<string, string>();
      collectEnvRefPaths(resolvedIncludes, "", collected);
      authoredPreviousSource = resolvedIncludes;
      if (collected.size > 0) {
        envRefMap = collected;
      }
    } catch {
      envRefMap = null;
    }
  }

  const resolveValidationCandidate = (candidate: unknown) => {
    // Validate removals now; apply them once to the final authored output after materialization.
    const config = applyUnsetPathsForWrite(candidate as OpenClawConfig, unsetPaths);
    return containsConfigIncludeDirective(config)
      ? context.resolveRuntimePreflightSourceConfig(
          restoreEnvVarRefs(config, snapshot.parsed, envForRestore) as OpenClawConfig,
          undefined,
          undefined,
          includeReadOverlay,
        )
      : config;
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
  // Pre-disk: a throw here needs no include restore, propagates directly.
  validateCandidate(validationCandidate);
  // SAFETY: the original resolved input was just validated; retain raw values, not parser defaults.
  const validatedCandidate = validationCandidate as OpenClawConfig;
  const previousSource =
    authoredPreviousSource ?? snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const materialized = stampConfigVersion(
    snapshot.exists
      ? validatedCandidate
      : initializeNativeSessionCatalogPreferences(validatedCandidate),
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

  let cfgToWrite = persistCandidate as OpenClawConfig;
  try {
    if (deps.fs.existsSync(configPath)) {
      const currentRaw = await deps.fs.promises.readFile(configPath, "utf-8");
      const parsed = parseConfigJson5(currentRaw, deps.json5);
      if (parsed.ok) {
        const beforeIdentityRestore = cfgToWrite;
        cfgToWrite = restoreEnvVarRefs(cfgToWrite, parsed.parsed, envForRestore) as OpenClawConfig;
        collectChangedPaths(beforeIdentityRestore, cfgToWrite, "", identityRestoredPaths);
      }
    }
  } catch (error) {
    if (error instanceof EnvRefArrayMutationError) {
      throw error;
    }
    // A failed current-file reread leaves the already validated candidate unchanged.
  }

  options.assertConfigPathForWrite?.();
  await deps.fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await tightenStateDirPermissionsIfNeeded({
    configPath,
    env: deps.env,
    homedir: deps.homedir,
    fsModule: deps.fs,
    assertConfigPathForWrite: options.assertConfigPathForWrite,
  });
  const outputConfigBase = envRefMap
    ? (restoreEnvRefsFromMap(
        cfgToWrite,
        "",
        envRefMap,
        changedPaths,
        identityRestoredPaths,
      ) as OpenClawConfig)
    : cfgToWrite;
  const tildeRestoredOutputConfig = restoreAuthoredTildePathsForWrite(
    outputConfigBase,
    snapshot.parsed,
    undefined,
    deps.homedir(),
  ) as OpenClawConfig;
  const outputConfig = preserveDeferredPluginMigrationConfig({
    sourceConfig: snapshot.parsed,
    nextConfig: applyUnsetPathsForWrite(tildeRestoredOutputConfig, unsetPaths),
    pending: deferredPluginMigrations,
  });
  const stampedOutputConfig = stampConfigVersion(outputConfig, options.lastTouchedVersionOverride);
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
    includeReadOverlay,
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

  const { logConfigOverwrite, logConfigWriteAnomalies, appendWriteAudit } =
    createConfigWriteAuditLog({
      configPath,
      env: deps.env,
      homedir: deps.homedir,
      logger: deps.logger,
      skipOutputLogs: options.skipOutputLogs,
      assertConfigPathForWrite: options.assertConfigPathForWrite,
      existsBefore: snapshot.exists,
      previousHash: previousHash ?? null,
      nextHash,
      previousBytes,
      nextBytes,
      previousStat,
      changedPathCount,
      changedPaths: [...changedPaths],
      origin: options.auditOrigin,
      hasMetaBefore,
      hasMetaAfter,
      gatewayModeBefore,
      gatewayModeAfter,
      suspiciousReasons,
    });
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
  // Still pre-disk: preflight failure propagates directly, same as above.
  await preCommitRuntimePreflight(sourceConfigForPreflight);

  const publication: { phase: "unpublished" | "removed" | "published" | "accepted" } = {
    phase: "unpublished",
  };
  let rollbackStatus: ConfigWriteRollbackStatus = "not-restored";
  try {
    options.assertConfigPathForWrite?.();
    if (options.baseSnapshot) {
      assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
    }
    options.assertConfigPathForWrite?.();
    await cronOwnerRefusal?.recheck();
    options.assertConfigPathForWrite?.();
    // Includes publish before the root, in this guarded window (finding 6).
    await publishStagedIncludeWrites({
      staged: stagedIncludeWrites,
      restorers: includeWriteRestorers,
      configPath,
      env: deps.env,
      assertConfigPathForWrite: options.assertConfigPathForWrite,
      skipOutputLogs: options.skipOutputLogs,
      includeGraph: includeGraphForWrite,
      rootRawForGraph: snapshot.exists ? snapshot.raw : undefined,
    });
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
        // Load-time graph with written leaves advanced: a fresh resolution here
        // would adopt an include redirected since load as the new baseline.
        // The fallback below now serves only configs with no authored
        // includes; the fail-closed check above guarantees this is defined
        // whenever any exist.
        includeGraph: includeGraphForWrite ?? {
          hashes: includeFileHashes,
          targets: includeFileTargets,
        },
        onRootRemoved: () => {
          publication.phase = "removed";
        },
      },
    );
    await using preparedFile = await prepareConfigFileWrite({
      configPath,
      content: json,
      previousRaw: snapshot.raw,
      fsModule: guardedFs,
      assertCurrent: options.assertConfigPathForWrite,
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
      [configWritePostCommitRollback]: async (assertCurrent) => {
        // sourceGuard is scoped to createConfigIO's nested lock (io.factory.ts),
        // which closes the moment writeConfigFileFromContext returns -- dead
        // long before post-commit finalization can invoke this rollback. Use
        // the caller-supplied assertCurrent instead: it is the outer lock
        // guard (io.runtime.ts's assertPostCommitCurrent), still live here,
        // and -- like sourceGuard -- an ownership check, not a config-selection
        // check, so it still authorizes restoration after a selection change.
        await restoreStagedIncludeWrites(includeWriteRestorers, {
          configPath,
          env: deps.env,
          restoreAuthority: assertCurrent,
        });
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
    };
  } catch (error) {
    let failure = error;
    if (publication.phase === "removed" || publication.phase === "published") {
      try {
        rollbackStatus = (await rollbackConfigFileWriteIfUnchanged({
          configPath,
          previousSnapshot: snapshot,
          committedHash: publication.phase === "published" ? nextHash : hashConfigRaw(null),
          fsModule: deps.fs,
          assertCurrent: sourceGuard,
        }))
          ? "restored"
          : "not-restored";
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
    if (publication.phase === "unpublished" || rollbackStatus === "restored") {
      // Still inside writeConfigFileFromContext's own synchronous catch, so
      // sourceGuard's nested factory-lock scope has not closed yet -- unlike
      // the post-commit rollback path above, sourceGuard is live here.
      failure = await restoreStagedIncludeWritesOrFold(includeWriteRestorers, failure, {
        configPath,
        env: deps.env,
        restoreAuthority: sourceGuard,
      });
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
