import type fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentEntries, tryResolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { maintainConfigBackups } from "./backup-rotation.js";
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
import {
  EnvRefArrayMutationError,
  restoreEnvRefsFromMap,
  restoreEnvVarRefs,
} from "./env-preserve.js";
import { readConfigIncludeFileWithGuards, resolveConfigIncludes } from "./includes.js";
import {
  appendConfigAuditRecord,
  capConfigAuditIssues,
  capConfigAuditPaths,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  type ConfigWriteAuditResult,
} from "./io.audit.js";
import type { ConfigIoContext } from "./io.context.js";
import { planCronStoreWrite, prepareLegacyCronOwnerHandoffs } from "./io.cron-owner-handoff.js";
import { recordConfigWriteMetadata } from "./io.meta.js";
import { materializeRetainedOwnerForTopologyWrite } from "./io.ownership-topology-materialization.js";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";
import {
  collectEnvRefPaths,
  containsConfigIncludeDirective,
  hashConfigRaw,
  hasConfigMeta,
  parseConfigJson5,
  resolveConfigSnapshotHash,
  resolveGatewayMode,
  restoreAuthoredTildePathsForWrite,
} from "./io.read-helpers.js";
import { loggedConfigWarningFingerprints, setBoundedConfigIoWarningEntry } from "./io.state.js";
import type {
  ConfigWriteOptions,
  InternalConfigWriteResult,
  ReadConfigFileSnapshotInternalResult,
} from "./io.types.js";
import { ConfigRuntimeRefreshError, configWritePostCommitRollback } from "./io.types.js";
import { logConfigWarningsOnce } from "./io.warnings.js";
import {
  commitConfigFileWrite,
  createWorkspacePluginDirectory,
  removeEmptyWorkspacePluginDirectories,
} from "./io.write-commit.js";
import { formatConfigValidationFailure } from "./io.write-errors.js";
import { createConfigWriteLoggers } from "./io.write-logging.js";
import {
  hasIncludedGatewayModeOwner,
  hasOwnIncludeDirective,
  readConfigPath,
  setConfigPath,
} from "./io.write-path-helpers.js";
import {
  preserveIncludeOwnedConfigForWrite,
  resolvePersistCandidateForWrite,
} from "./io.write-prepare.js";
import {
  assertBaseSnapshotStillCurrent,
  formatConfigArtifactTimestamp,
  resolveConfigSizeBaselineBytes,
  resolveConfigStatMetadata,
  resolveConfigWriteBlockingReasons,
  resolveConfigWriteSuspiciousReasons,
  rollbackConfigFileWriteIfUnchanged,
  stampConfigVersion,
  tightenStateDirPermissionsIfNeeded,
} from "./io.write-safety.js";
import { formatConfigIssueLines } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";
import { resolveIncludeRoots } from "./paths.js";
import { preflightRuntimeSnapshotWrite } from "./runtime-snapshot.js";
import { isSameFixedSessionStoreConfig } from "./sessions/session-store-config.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

export async function writeConfigFileFromContext(
  context: ConfigIoContext,
  cfg: OpenClawConfig,
  options: ConfigWriteOptions,
  readSnapshot: () => Promise<ReadConfigFileSnapshotInternalResult>,
): Promise<InternalConfigWriteResult> {
  const { deps, configPath } = context;
  options.assertConfigPathForWrite?.();
  assertConfigWriteAllowedInCurrentMode({ configPath, env: deps.env });
  const unsetPaths = resolveManagedUnsetPathsForWrite(options.unsetPaths);
  let nextConfig = cfg;
  let persistCandidate: unknown;
  const snapshotRead = options.baseSnapshot
    ? {
        snapshot: options.baseSnapshot,
        pluginMetadataSnapshot: options.basePluginMetadataSnapshot,
      }
    : await readSnapshot();
  const snapshot = snapshotRead.snapshot;
  if (options.baseSnapshot) {
    assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
  }
  // Retired marker ownership comes from raw input; markerless sole-to-fleet
  // writes have one equally unambiguous previous owner. cron.store is also
  // raw-only, so the snapshot remains authoritative until this handoff commits.
  const sourceRosterMigrations = [snapshot.sourceConfigBeforeMigrations, snapshot.parsed].map(
    (source) => migratePersistedImplicitMainRoster(source, deps.env),
  );
  const retainedLegacyDefaultAgentId = sourceRosterMigrations
    .map((migration) => migration.retainedLegacyDefaultAgentId)
    .find((agentId) => agentId !== undefined);
  const legacySourceInsertedPaths = retainedLegacyDefaultAgentId
    ? (sourceRosterMigrations
        .filter(
          (migration) => migration.retainedLegacyDefaultAgentId === retainedLegacyDefaultAgentId,
        )
        .find((migration) => (migration.insertedPaths?.length ?? 0) > 0)?.insertedPaths ?? [])
    : [];
  const retainedLegacyRuntimeInsertedPaths =
    retainedLegacyDefaultAgentId &&
    Array.isArray(snapshot.config.bindings) &&
    snapshot.config.bindings.length > 0 &&
    !isDeepStrictEqual(snapshot.sourceConfigBeforeMigrations?.bindings, snapshot.config.bindings)
      ? [["bindings"]]
      : [];
  const previousSoleAgentId = tryResolveDefaultAgentId(snapshot.config);
  const previousAgentEntries = listAgentEntries(snapshot.config);
  const previousAgentCount = previousAgentEntries.length;
  const nextAgentEntries = listAgentEntries(nextConfig);
  const nextAgentIds = new Set(nextAgentEntries.map((entry) => normalizeAgentId(entry.id)));
  const keepsSameFixedSessionStore = isSameFixedSessionStoreConfig(
    (snapshot.sourceConfigBeforeMigrations ?? snapshot.config).session?.store,
    nextConfig.session?.store,
    deps.env,
  );
  // Stamp topology transitions and retained legacy owners independently from sole-agent handoff.
  const entersMultiAgent = previousAgentCount <= 1 && nextAgentEntries.length > 1;
  const previousSoleRemains =
    previousSoleAgentId !== undefined && nextAgentIds.has(normalizeAgentId(previousSoleAgentId));
  const previousSoleHandoffAgentId =
    entersMultiAgent && previousSoleRemains ? previousSoleAgentId : undefined;
  const writesOwnershipTopology =
    !isDeepStrictEqual(previousAgentEntries, nextAgentEntries) ||
    [...(options.explicitSetPaths ?? []), ...unsetPaths].some(
      (writePath) =>
        writePath[0] === "agents" &&
        (writePath.length === 1 ||
          writePath[1] === "entries" ||
          writePath[1] === "list" ||
          writePath[1] === "ownership"),
    );
  // A non-roster write must preserve the authored legacy roster. Retire its
  // default only when this write explicitly owns the topology migration.
  const persistOwnership =
    entersMultiAgent || (retainedLegacyDefaultAgentId !== undefined && writesOwnershipTopology);
  const retainExplicitOwnership =
    nextAgentEntries.length > 1 && snapshot.config.agents?.ownership === "explicit";
  const shouldStampOwnershipGeneration =
    (persistOwnership || retainExplicitOwnership) && nextConfig.agents?.ownership === undefined;
  if (shouldStampOwnershipGeneration) {
    nextConfig = {
      ...nextConfig,
      agents: { ...nextConfig.agents, ownership: "explicit" },
    };
  }
  const topologyMaterialization = materializeRetainedOwnerForTopologyWrite({
    sourceConfig: snapshot.config,
    targetConfig: nextConfig,
    previousSoleHandoffAgentId,
    retainedLegacyDefaultAgentId,
    writesOwnershipTopology,
    nextAgentIds,
    env: deps.env,
  });
  nextConfig = topologyMaterialization.config;
  const transitionInsertedPaths = [
    ...topologyMaterialization.insertedPaths,
    ...(shouldStampOwnershipGeneration ? [["agents", "ownership"]] : []),
  ];
  const nextSessionStoreOwner = nextConfig.agents?.defaults?.sessionStore;
  const canSynthesizeSessionStoreOwner =
    nextSessionStoreOwner === undefined ||
    (isRecord(nextSessionStoreOwner) && !Object.hasOwn(nextSessionStoreOwner, "agentId"));
  if (
    !topologyMaterialization.ownerAgentId &&
    writesOwnershipTopology &&
    previousAgentCount === 1 &&
    previousSoleAgentId &&
    !previousSoleRemains &&
    keepsSameFixedSessionStore &&
    canSynthesizeSessionStoreOwner
  ) {
    // A removed sole agent can still physically own unscoped fixed-store rows,
    // including across a sole-to-sole swap. Preserve that storage owner only.
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          sessionStore: {
            ...(isRecord(nextSessionStoreOwner) ? nextSessionStoreOwner : {}),
            agentId: normalizeAgentId(previousSoleAgentId),
          },
        },
      },
    };
    transitionInsertedPaths.push(["agents", "defaults", "sessionStore", "agentId"]);
  }
  const topologyOwnershipPaths =
    persistOwnership || retainExplicitOwnership
      ? [
          ...new Map(
            [
              ...legacySourceInsertedPaths,
              ...retainedLegacyRuntimeInsertedPaths,
              ...transitionInsertedPaths,
            ].map((ownershipPath) => [ownershipPath.join("\0"), ownershipPath]),
          ).values(),
        ]
      : [];
  assertAutomaticBindingsWriteAllowed({
    bindingsIncludeOwned: snapshot.bindingsIncludeOwned === true,
    ownershipPaths: topologyOwnershipPaths,
    sourceBindings: Array.isArray(snapshot.sourceConfigBeforeMigrations?.bindings)
      ? snapshot.sourceConfigBeforeMigrations.bindings
      : [],
    nextBindings: Array.isArray(nextConfig.bindings) ? nextConfig.bindings : [],
  });
  const explicitSetPaths = [...(options.explicitSetPaths ?? []), ...topologyOwnershipPaths];
  const cronHandoffAgentId =
    retainedLegacyDefaultAgentId && nextAgentIds.has(normalizeAgentId(retainedLegacyDefaultAgentId))
      ? retainedLegacyDefaultAgentId
      : previousSoleHandoffAgentId
        ? previousSoleHandoffAgentId
        : undefined;
  const sourceCronConfig = snapshot.sourceConfigBeforeMigrations ?? snapshot.config;
  const publishesExplicitOwnership =
    persistOwnership ||
    retainExplicitOwnership ||
    (nextAgentEntries.length > 1 && nextConfig.agents?.ownership === "explicit");
  const cronStoreWritePlan = await planCronStoreWrite({
    cronHandoffAgentId,
    env: deps.env,
    nextConfig,
    publishesExplicitOwnership,
    requiresCurrentStoreValidation: writesOwnershipTopology,
    sourceConfig: sourceCronConfig,
  });
  persistCandidate = nextConfig;
  let explicitSetValueSource: unknown = options.explicitSetValueSource ?? nextConfig;
  for (const ownershipPath of topologyOwnershipPaths) {
    explicitSetValueSource = setConfigPath(
      explicitSetValueSource,
      ownershipPath,
      readConfigPath(nextConfig, ownershipPath),
    );
  }
  let envRefMap: Map<string, string> | null = null;
  const changedPaths = new Set<string>();
  collectChangedPaths(snapshot.config, nextConfig, "", changedPaths);
  for (const changedPath of [...explicitSetPaths, ...(options.unsetPaths ?? [])]) {
    const normalizedPath = changedPath.filter((segment) => segment.length > 0).join(".");
    if (normalizedPath) {
      changedPaths.add(normalizedPath);
    }
  }
  const identityRestoredPaths = new Set<string>();
  const hasAuthoredIncludes = containsConfigIncludeDirective(snapshot.parsed);
  const hasResolvedAuthoredIncludes =
    hasAuthoredIncludes && !containsConfigIncludeDirective(snapshot.sourceConfig);
  // Missing snapshots still need runtime-to-authored projection. Callers authoring an
  // exact bootstrap roster mark that intent through explicitSetPaths.
  if (snapshot.valid) {
    persistCandidate = resolvePersistCandidateForWrite({
      runtimeConfig: snapshot.config,
      sourceConfig: snapshot.resolved,
      sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
      nextConfig,
      rootAuthoredConfig: snapshot.parsed,
      agentRosterIncludeOwned: snapshot.agentRosterIncludeOwned,
      unsetPaths,
      explicitSetPaths,
      explicitSetValueSource,
      allowedAgentRosterRemovals: options.allowedAgentRosterRemovals,
      allowIncludeAncestorExplicitSetPaths: options.allowIncludeAncestorExplicitSetPaths,
    });
  } else if (snapshot.exists && hasAuthoredIncludes) {
    persistCandidate = preserveIncludeOwnedConfigForWrite({
      runtimeConfig: snapshot.config,
      sourceConfig: snapshot.resolved,
      nextConfig,
      rootAuthoredConfig: snapshot.parsed,
    });
  }
  if (snapshot.exists && (snapshot.valid || hasResolvedAuthoredIncludes)) {
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
      if (collected.size > 0) {
        envRefMap = collected;
      }
    } catch {
      envRefMap = null;
    }
  }

  persistCandidate = applyUnsetPathsForWrite(persistCandidate as OpenClawConfig, unsetPaths);
  const envForRestore = options.envSnapshotForRestore ?? deps.env;
  const validationSourceCandidate = containsConfigIncludeDirective(persistCandidate)
    ? restoreEnvVarRefs(persistCandidate, snapshot.parsed, envForRestore)
    : persistCandidate;
  const validationCandidate = containsConfigIncludeDirective(validationSourceCandidate)
    ? context.resolveRuntimePreflightSourceConfig(validationSourceCandidate as OpenClawConfig)
    : validationSourceCandidate;
  const validationWorkspacePluginDirectories = topologyMaterialization.pluginPath
    ? await createWorkspacePluginDirectory(deps.fs, topologyMaterialization.pluginPath)
    : [];
  let validated: ReturnType<typeof validateConfigObjectRawWithPlugins>;
  try {
    validated = validateConfigObjectRawWithPlugins(validationCandidate, {
      env: deps.env,
      pluginValidation: options.skipPluginValidation ? "skip" : "full",
      preservedLegacyRootKeys: options.preservedLegacyRootKeys,
    });
  } finally {
    // The path exists only for plugin discovery here. Recreate it at the commit
    // edge so a later validation or preflight failure leaves no directory behind.
    await removeEmptyWorkspacePluginDirectories(deps.fs, validationWorkspacePluginDirectories);
  }
  if (!validated.ok) {
    const issue = validated.issues[0];
    throw new Error(
      formatConfigValidationFailure(issue?.path || "<root>", issue?.message ?? "invalid"),
    );
  }
  const previousWarningFingerprint = loggedConfigWarningFingerprints.get(configPath);
  // Capture before commit so rollback cannot restore a watcher-updated slot.
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

  await deps.fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await tightenStateDirPermissionsIfNeeded({
    configPath,
    env: deps.env,
    homedir: deps.homedir,
    fsModule: deps.fs,
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
  const outputConfig = applyUnsetPathsForWrite(tildeRestoredOutputConfig, unsetPaths);
  const stampedOutputConfig = stampConfigVersion(
    outputConfig,
    options.lastTouchedVersionOverride,
    snapshot.exists ? snapshot.parsed : null,
  );
  const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
  const nextHash = hashConfigRaw(json);
  const previousHash = resolveConfigSnapshotHash(snapshot);
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
  const authoredGateway = (snapshot.parsed as { gateway?: unknown }).gateway;
  const authoredGatewayMode =
    authoredGateway !== null &&
    typeof authoredGateway === "object" &&
    !Array.isArray(authoredGateway)
      ? (authoredGateway as Record<string, unknown>).mode
      : undefined;
  const gatewayModeAuthoredLocally =
    authoredGateway !== null &&
    typeof authoredGateway === "object" &&
    !Array.isArray(authoredGateway) &&
    Object.hasOwn(authoredGateway, "mode") &&
    !hasOwnIncludeDirective(authoredGatewayMode);
  const preservesIncludedGatewayMode =
    options.allowIncludeAncestorExplicitSetPaths === true &&
    gatewayModeBefore != null &&
    !gatewayModeAuthoredLocally &&
    hasIncludedGatewayModeOwner(stampedOutputConfig) &&
    !options.explicitSetPaths?.some((explicitPath) => explicitPath[0] === "gateway");
  const gatewayModeAfter =
    resolveGatewayMode(stampedOutputConfig) ??
    (preservesIncludedGatewayMode ? gatewayModeBefore : null) ??
    null;
  const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
    existsBefore: snapshot.exists,
    unreadableBefore: snapshot.readError != null,
    sizeBaselineBytes,
    nextBytes,
    hasMetaBefore,
    gatewayModeBefore,
    gatewayModeAfter,
  });

  const { logConfigOverwrite, logConfigWriteAnomalies } = createConfigWriteLoggers({
    changedPathCount,
    configPath,
    env: deps.env,
    existsBefore: snapshot.exists,
    logger: deps.logger,
    nextHash,
    previousHash: previousHash ?? null,
    skipOutputLogs: options.skipOutputLogs,
    suspiciousReasons,
  });

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
    await deps.fs.promises
      .writeFile(rejectedPath, json, { encoding: "utf-8", mode: 0o600, flag: "wx" })
      .catch(() => {});
    const message = `Config write rejected: ${configPath} (${blockingReasons.join(", ")}). Rejected payload saved to ${rejectedPath}.`;
    const error = Object.assign(new Error(message), {
      code: "CONFIG_WRITE_REJECTED",
      rejectedPath,
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
  const sourceConfigForPreflight = context.resolveRuntimePreflightSourceConfig(stampedOutputConfig);
  await preCommitRuntimePreflight(sourceConfigForPreflight);

  let releaseCronHandoffs: (() => void) | undefined;
  let rollbackCronHandoffs: (() => Promise<void>) | undefined;
  let createdWorkspacePluginDirectories: string[] = [];
  let configCommitted = false;
  try {
    const result = await commitConfigFileWrite({
      configPath,
      content: json,
      fsModule: deps.fs,
      beforeRename: async () => {
        options.assertConfigPathForWrite?.();
        if (options.baseSnapshot) {
          assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
        }
        if (deps.fs.existsSync(configPath)) {
          // Backup rotation is fallible and must precede the irreversible cron handoff.
          // Moving it later can leave cron ownership committed when backup creation fails.
          await maintainConfigBackups(configPath, deps.fs.promises);
        }
        if (cronStoreWritePlan.recheckExplicitDestination) {
          // Recheck effective rows at the commit edge. External old-code writers cannot
          // honor a new fence, so this protects only the inspected ownership boundary.
          await cronStoreWritePlan.recheckExplicitDestination();
        }
        if (topologyMaterialization.pluginPath) {
          createdWorkspacePluginDirectories = await createWorkspacePluginDirectory(
            deps.fs,
            topologyMaterialization.pluginPath,
          );
        }
        // Emit the warning before the final conflict guard. After that guard, the
        // cron handoff is the last fallible operation before the atomic rename.
        warnIfJSON5CommentsWillBeStripped({
          raw: snapshot.raw,
          filePath: configPath,
          warn: (message) => deps.logger.warn(message),
          skipOutputLogs: options.skipOutputLogs,
        });
        if (cronHandoffAgentId) {
          const prepared = await prepareLegacyCronOwnerHandoffs({
            env: deps.env,
            legacyDefaultAgentId: cronHandoffAgentId,
            targets: cronStoreWritePlan.targets,
          });
          releaseCronHandoffs = prepared.release;
          rollbackCronHandoffs = prepared.rollback;
        }
        // Ordering invariant: this is the final conflict fence. No await may occur
        // between these synchronous checks and replaceFileAtomic's rename.
        options.assertConfigPathForWrite?.();
        if (options.baseSnapshot) {
          assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
        }
      },
    });
    configCommitted = true;
    try {
      options.assertConfigPathForWrite?.();
    } catch (error) {
      try {
        await rollbackConfigFileWriteIfUnchanged({
          configPath,
          previousSnapshot: snapshot,
          committedHash: nextHash,
          fsModule: deps.fs,
        });
      } catch (rollbackError) {
        throw new ConfigRuntimeRefreshError(
          `${formatErrorMessage(error)} Rollback failed: ${formatErrorMessage(rollbackError)}`,
          { cause: error },
        );
      }
      configCommitted = false;
      throw error;
    }
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
    return {
      persistedHash: nextHash,
      persistedConfig: stampedOutputConfig,
      [configWritePostCommitRollback]: () => {
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
    if (!configCommitted) {
      try {
        await rollbackCronHandoffs?.();
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          "config write failed and cron ownership rollback did not complete",
        );
      }
      await removeEmptyWorkspacePluginDirectories(deps.fs, createdWorkspacePluginDirectories);
    }
    await appendWriteAudit("failed", failure);
    throw failure;
  } finally {
    releaseCronHandoffs?.();
  }
}
