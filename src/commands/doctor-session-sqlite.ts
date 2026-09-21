import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  isPrimarySessionTranscriptFileName,
  resolveTrajectoryPath,
  resolveTrajectoryPointerPath,
} from "../config/sessions/artifacts.js";
import {
  isLegacySessionRecordOwnedByTarget,
  shouldFilterLegacySessionRecordsByTarget,
} from "../config/sessions/legacy-store-inspection.js";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
  type SessionStoreTarget as ResolvedSessionStoreTarget,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DeferredPluginMigrationConflictError,
  readDeferredPluginMigrations,
  withDeferredPluginMigrationsCurrent,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import {
  captureDeferredPluginSessionSources,
  deferredPluginSessionStoreIds,
  readDeferredPluginSessionImport,
  recordDeferredPluginSessionImport,
  type DeferredPluginSessionImport,
} from "../infra/deferred-plugin-session-sources.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareLegacyAcpMigrationSource } from "../infra/legacy-acp-migration-source.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { prepareActiveSqliteTranscriptSettlement } from "./doctor-session-sqlite-active.js";
import {
  planImportedTranscriptArtifactsToArchive,
  planSessionJsonlArchiveMove,
} from "./doctor-session-sqlite-archive.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  moveMigrationArtifact,
  type MigrationArtifactIdentity,
} from "./doctor-session-sqlite-artifact.js";
import {
  appendActiveSqliteTranscriptFileIssues,
  appendRetainedPluginSessionSourceIssue,
  appendSqliteDbStats,
  compactSqliteDatabase,
  countLegacyTranscript,
  summarizeDoctorSessionSqliteReport,
} from "./doctor-session-sqlite-diagnostics.js";
import {
  collectHistoricalArchiveSources,
  discoverLegacyHistoricalTranscripts,
  gatherLegacyArchiveCoverage,
  listUnreferencedJsonlFiles,
  readLegacySessionRecords,
  HISTORICAL_IMPORT_REASON,
  type HistoricalArchiveSources,
  type LegacySessionRecord,
} from "./doctor-session-sqlite-discovery.js";
import { writeSessionSqliteMigrationFailureReports } from "./doctor-session-sqlite-failure.js";
import {
  canonicalMigrationFilePath,
  assertSafeSessionSqliteMigrationMove,
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationTargetInput,
  type SessionSqliteMigrationMove,
} from "./doctor-session-sqlite-migration-run.js";
import { createMissingSessionIndexVerifier } from "./doctor-session-sqlite-missing-index.js";
import {
  countTranscriptEventsForPath,
  createTranscriptEventReader,
  readOnlySqliteValidationSnapshot,
  readTranscriptFingerprint,
  readSqliteEntryCount,
  resolveTargetSqlitePath,
  type ReadOnlySqliteValidationSnapshot,
} from "./doctor-session-sqlite-readers.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import { restoreDoctorSessionSqliteTargets } from "./doctor-session-sqlite-restore-report.js";
import { reconcileSessionSqliteMigrationPublications } from "./doctor-session-sqlite-restore.js";
import {
  countRetainedSessionSources,
  prepareRetainedSessionImport,
} from "./doctor-session-sqlite-retained.js";
import {
  createDoctorSessionSqliteTargetReport,
  countBlockingSessionSqliteIssues,
  isRetainedSourceIssue,
  isInformationalMissingSessionIndex,
  type DoctorSessionSqliteIssue,
  type DoctorSessionSqliteMode,
  type DoctorSessionSqliteOptions,
  type DoctorSessionSqliteReport,
  type DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";
import {
  assertDoctorSqliteMaintenancePathsNotAliased,
  isDestructiveDoctorSessionSqliteMode,
  type DoctorSqliteMaintenanceAuthority,
} from "./doctor-sqlite-maintenance-lock.js";
export type {
  DoctorSessionSqliteOptions,
  DoctorSessionSqliteReport,
} from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

type LegacyArchiveTarget = {
  sourceTarget: SessionStoreTarget;
  target: SessionSqliteMigrationTargetInput;
  report: DoctorSessionSqliteTargetReport;
  validated: boolean;
  records: Array<Omit<LegacySessionRecord, "entry"> & { sessionId: string }>;
  deferredPluginIds: string[];
  retainedImportVerified: boolean;
  sourceConflicts?: Set<string>;
  verifiedSources?: DeferredPluginSessionImport["sources"];
};

const retainedArchivePlans = new WeakMap<
  DoctorSessionSqliteReport,
  {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    owners: Array<{ owner: LegacyArchiveTarget; receipt: DeferredPluginSessionImport }>;
  }
>();

const SESSION_IMPORT_BATCH_SIZE = 256;

/**
 * Runs the targeted doctor SQLite session migration/inspection submode.
 * Destructive production callers hold the Gateway/SQLite-maintenance state lock for the full call.
 */
export async function runDoctorSessionSqlite(
  options: DoctorSessionSqliteOptions,
): Promise<DoctorSessionSqliteReport> {
  const env = options.env ?? process.env;
  const cfg = resolveDoctorSessionSqliteConfig(options);
  const pendingPlugins = readDeferredPluginMigrations({ env });
  const verifyMissingIndex = createMissingSessionIndexVerifier({ cfg, env });
  const historicalArchives =
    options.mode === "import" || options.mode === "dry-run" || options.mode === "validate"
      ? collectHistoricalArchiveSources({ cfg, env })
      : new Map();
  const candidates = resolveDoctorSessionSqliteTargets({ ...options, cfg, env });
  const targets = filterLegacySessionStoreTargets(candidates, options.mode, historicalArchives);
  if (isDestructiveDoctorSessionSqliteMode(options.mode)) {
    const maintenancePaths = resolveDoctorSessionSqliteMaintenancePaths(targets);
    assertDoctorSqliteMaintenancePathsNotAliased(
      `session SQLite ${options.mode}`,
      maintenancePaths,
      resolveDoctorSessionSqliteMaintenanceRoots(targets, env),
    );
  }
  if (options.mode === "restore") {
    return restoreDoctorSessionSqliteTargets({
      env,
      targets,
    });
  }
  if (options.mode === "recover") {
    return recoverDoctorSessionSqliteTargets({
      env,
      options,
      targets,
      validateTarget: (target) =>
        inspectOrMigrateTarget({
          cfg,
          env,
          mode: "recover",
          target,
          verifyMissingIndex,
          deferredPluginIds: deferredPluginSessionStoreIds({ target, pending: pendingPlugins }),
        }),
    });
  }
  if (options.mode === "import") {
    await reconcileSessionSqliteMigrationPublications({
      env,
      trustedTargets: targets.map(createMigrationTargetInput),
    });
  }
  const activeRun =
    options.mode === "import" && targets.length > 0
      ? createSessionSqliteMigrationRun(env, targets.map(createMigrationTargetInput))
      : undefined;
  const coverage =
    options.mode === "import" || options.mode === "dry-run" || options.mode === "validate"
      ? gatherLegacyArchiveCoverage(
          cfg,
          env,
          targets,
          options.allAgents && !options.agent && !options.store ? candidates : undefined,
        )
      : undefined;
  const reports: DoctorSessionSqliteTargetReport[] = [];
  const archiveTargets: LegacyArchiveTarget[] = [];
  for (const target of targets) {
    reports.push(
      await inspectOrMigrateTarget({
        activeRun,
        archiveTargets,
        verifyMissingIndex,
        cfg,
        env,
        mode: options.mode,
        target,
        historicalArchives,
        referencedPaths: coverage?.referencedPaths,
        expectedIndexIdentity: coverage?.indexIdentities.get(
          canonicalMigrationFilePath(target.storePath),
        ),
        deferredPluginIds: deferredPluginSessionStoreIds({
          target,
          pending: pendingPlugins,
        }),
      }),
    );
  }
  if (activeRun && coverage) {
    const deferredSourcePaths = new Set<string>();
    for (const target of reports.filter(isInformationalMissingSessionIndex)) {
      coverage.selectedStorePaths.delete(canonicalMigrationFilePath(target.storePath));
      coverage.retainedDirectories.add(path.dirname(canonicalMigrationFilePath(target.storePath)));
    }
    for (const owner of archiveTargets) {
      for (const source of owner.sourceConflicts ?? []) {
        coverage.retainedPaths.add(canonicalMigrationFilePath(source));
        deferredSourcePaths.add(canonicalMigrationFilePath(source));
      }
    }
    const retainDeferredSources = () => {
      for (const owner of archiveTargets) {
        if (owner.deferredPluginIds.length > 0) {
          coverage.selectedStorePaths.delete(canonicalMigrationFilePath(owner.target.storePath));
          coverage.retainedDirectories.add(
            path.dirname(canonicalMigrationFilePath(owner.target.storePath)),
          );
          if (owner.retainedImportVerified) {
            // Retry skips historical discovery; the receipt retains those originals too.
            for (const source of owner.verifiedSources ?? []) {
              deferredSourcePaths.add(canonicalMigrationFilePath(source.path));
            }
          }
        }
      }
    };
    const publishArchive = (remove: () => void, retainSource: () => void) => {
      const conflict = withDeferredPluginMigrationsCurrent<
        readonly DeferredPluginMigration[] | undefined
      >(
        {
          env,
          expectedPending: pendingPlugins,
          onConflict(pending) {
            retainSource();
            if (pending.length > 0) {
              for (const owner of archiveTargets) {
                if (!owner.retainedImportVerified && owner.verifiedSources) {
                  recordDeferredPluginSessionImport({
                    cfg,
                    target: owner.sourceTarget,
                    sqlitePath: owner.target.sqlitePath,
                    env,
                    pluginIds: pending.map((plugin) => plugin.pluginId),
                    sources: owner.verifiedSources,
                    recordCount: owner.report.legacyEntries,
                  });
                }
              }
            }
            return pending;
          },
        },
        () => {
          remove();
          return undefined;
        },
      );
      if (conflict) {
        for (const owner of archiveTargets) {
          owner.deferredPluginIds = deferredPluginSessionStoreIds({
            target: owner.target,
            pending: conflict,
          });
          if (owner.deferredPluginIds.length > 0) {
            owner.retainedImportVerified ||= owner.verifiedSources !== undefined;
            owner.report.issues.push({
              code: "plugin_migration_source_retained",
              message: `Plugin migration obligations changed before archival. Original session migration inputs remain pending for plugin(s): ${owner.deferredPluginIds.join(", ")}. Run openclaw doctor --fix after the plugin is available.`,
            });
          }
        }
        retainDeferredSources();
        throw new DeferredPluginMigrationConflictError(conflict);
      }
    };
    retainDeferredSources();
    await archiveLegacyArtifacts(
      archiveTargets,
      coverage,
      activeRun,
      undefined,
      undefined,
      publishArchive,
    );
    for (const { target, report } of archiveTargets) {
      appendActiveSqliteTranscriptFileIssues(target, report, deferredSourcePaths);
      updateMigrationManifestTarget(activeRun, createMigrationTargetInput(target), report.issues);
    }
    await archiveImportedLegacySessionStores(
      archiveTargets,
      activeRun,
      coverage,
      undefined,
      publishArchive,
    );
    const hasBlockingIssues = reports.some(
      (report) => countBlockingSessionSqliteIssues(report) > 0,
    );
    activeRun.manifest.completedAt = new Date().toISOString();
    if (hasBlockingIssues) {
      activeRun.manifest.failedAt = activeRun.manifest.completedAt;
      const failureReports = writeSessionSqliteMigrationFailureReports(activeRun.manifestPath, {
        reason: "doctor import reported session SQLite migration issues",
      });
      activeRun.manifest.failureReports = failureReports;
    }
    writeSessionSqliteMigrationManifest(activeRun);
  }
  const report = summarizeDoctorSessionSqliteReport(options.mode, reports, activeRun);
  if (activeRun) {
    const owners = archiveTargets
      .filter(
        (owner) =>
          owner.retainedImportVerified &&
          owner.deferredPluginIds.length > 0 &&
          !owner.sourceConflicts?.size,
      )
      .map((owner) => {
        const receipt = readDeferredPluginSessionImport({
          cfg,
          target: owner.sourceTarget,
          sqlitePath: owner.target.sqlitePath,
          env,
        });
        if (!receipt) {
          throw new Error("Verified retained session import receipt is missing.");
        }
        return { owner, receipt };
      });
    if (owners.length > 0) {
      retainedArchivePlans.set(report, { cfg, env: { ...env }, owners });
    }
  }
  return report;
}

/** Retire only this import's verified originals before the last plugin obligation clears. */
export async function settleRetainedDoctorSessionSources(
  report: DoctorSessionSqliteReport,
  completedPluginIds: readonly string[],
  authority: DoctorSqliteMaintenanceAuthority,
  assertCompletionCurrent: () => void,
): Promise<void> {
  const plan = retainedArchivePlans.get(report);
  if (!plan) {
    return;
  }
  const assertCurrent = () => {
    authority.assertCurrent();
    assertCompletionCurrent();
  };
  assertCurrent();
  retainedArchivePlans.delete(report);
  const completed = new Set(completedPluginIds);
  const expectedPending = readDeferredPluginMigrations({ env: plan.env });
  const remainingPending = expectedPending.filter((plugin) => !completed.has(plugin.pluginId));
  if (remainingPending.length > 0) {
    return;
  }
  const publishArchive = (remove: () => void, retainSource: () => void) => {
    const conflict = withDeferredPluginMigrationsCurrent<
      readonly DeferredPluginMigration[] | undefined
    >(
      {
        env: plan.env,
        expectedPending,
        onConflict(pending) {
          authority.assertCurrent();
          retainSource();
          return pending;
        },
      },
      () => {
        remove();
        return undefined;
      },
    );
    if (conflict) {
      throw new DeferredPluginMigrationConflictError(conflict);
    }
  };
  const verifyImports = () => {
    assertCurrent();
    for (const { owner, receipt } of plan.owners) {
      const current = readDeferredPluginSessionImport({
        cfg: plan.cfg,
        target: owner.sourceTarget,
        sqlitePath: owner.target.sqlitePath,
        env: plan.env,
      });
      if (!current || !isDeepStrictEqual(current, receipt)) {
        throw new Error("Verified retained session import receipt changed before settlement.");
      }
    }
  };
  const owners = plan.owners.map(({ owner }) => ({
    ...owner,
    deferredPluginIds: [],
    report: {
      ...owner.report,
      archivedLegacyStoreFiles: [...(owner.report.archivedLegacyStoreFiles ?? [])],
      archivedTranscriptFiles: [...owner.report.archivedTranscriptFiles],
      archivedUnreferencedJsonlFiles: [...owner.report.archivedUnreferencedJsonlFiles],
      issues: owner.report.issues.filter(
        (issue) => issue.code !== "plugin_migration_source_retained",
      ),
    },
  }));
  let activeRun: ActiveSessionSqliteMigrationRun | undefined;
  let failure: Error | undefined;
  try {
    verifyImports();
    const coverage = gatherLegacyArchiveCoverage(
      plan.cfg,
      plan.env,
      owners.map(({ sourceTarget }) => sourceTarget),
    );
    verifyImports();
    const targets = owners.map(({ target }) => target);
    assertDoctorSqliteMaintenancePathsNotAliased(
      "retained session source settlement",
      resolveDoctorSessionSqliteMaintenancePaths(targets),
      resolveDoctorSessionSqliteMaintenanceRoots(targets, plan.env),
    );
    assertCurrent();
    activeRun = createSessionSqliteMigrationRun(plan.env, targets);
    for (const owner of owners) {
      updateMigrationManifestTarget(activeRun, owner.target, owner.report.issues, {
        validationBeforeArchive: "passed",
      });
    }
    const capturedSources = new Set(
      plan.owners.flatMap(({ receipt }) => receipt.sources.map((source) => source.path)),
    );
    await archiveLegacyArtifacts(
      owners,
      coverage,
      activeRun,
      assertCurrent,
      capturedSources,
      publishArchive,
    );
    verifyImports();
    await archiveImportedLegacySessionStores(
      owners.filter((owner) => owner.report.issues.every(isRetainedSourceIssue)),
      activeRun,
      coverage,
      assertCurrent,
      publishArchive,
    );
    verifyImports();
    const issue = owners
      .flatMap((owner) => owner.report.issues)
      .find((candidate) => !isRetainedSourceIssue(candidate));
    if (issue || owners.some((owner) => fs.existsSync(owner.target.storePath))) {
      throw new Error(issue?.message ?? "Retained session sources could not be archived.");
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(formatErrorMessage(error));
    const failedOwners = owners.filter((owner) =>
      owner.report.issues.some((issue) => !isRetainedSourceIssue(issue)),
    );
    for (const [index, owner] of owners.entries()) {
      owner.report.issues.push(
        ...plan.owners[index]!.owner.report.issues.filter(
          (issue) => issue.code === "plugin_migration_source_retained",
        ),
      );
      if (failedOwners.length === 0 || failedOwners.includes(owner)) {
        const ownIssue = owner.report.issues.find(
          (issue) =>
            !isRetainedSourceIssue(issue) && issue.code !== "plugin_migration_source_retained",
        );
        owner.report.issues.push({
          code: "retained_plugin_source_settlement_failed",
          message: ownIssue?.message ?? formatErrorMessage(error),
        });
      }
    }
  }
  for (const [index, owner] of owners.entries()) {
    Object.assign(plan.owners[index]!.owner.report, owner.report);
  }
  if (activeRun) {
    assertCurrent();
    for (const owner of owners) {
      updateMigrationManifestTarget(activeRun, owner.target, owner.report.issues);
    }
    activeRun.manifest.completedAt = new Date().toISOString();
    if (failure) {
      activeRun.manifest.failedAt = activeRun.manifest.completedAt;
    }
    writeSessionSqliteMigrationManifest(activeRun);
  }
  Object.assign(report, summarizeDoctorSessionSqliteReport(report.mode, report.targets, activeRun));
  if (failure) {
    throw failure;
  }
}

/** Called only under the public maintenance lock, before its strict alias recheck. */
export async function reconcileDoctorSessionSqlitePublication(
  options: DoctorSessionSqliteOptions,
  sourcePath: string,
): Promise<void> {
  const env = options.env ?? process.env;
  const cfg = resolveDoctorSessionSqliteConfig(options);
  const targets = resolveDoctorSessionSqliteTargets({ ...options, cfg, env });
  assertDoctorSqliteMaintenancePathsNotAliased(
    `session SQLite ${options.mode}`,
    resolveDoctorSessionSqliteMaintenancePaths(targets),
    resolveDoctorSessionSqliteMaintenanceRoots(targets, env),
  );
  await reconcileSessionSqliteMigrationPublications({
    env,
    sourcePath,
    trustedTargets: targets.map(createMigrationTargetInput),
  });
}

function resolveDoctorSessionSqliteMaintenancePaths(
  targets: readonly SessionStoreTarget[],
): string[] {
  const protectedPaths = new Set<string>();
  for (const target of targets) {
    for (const databasePath of resolveSqliteDatabaseFilePaths(resolveTargetSqlitePath(target))) {
      protectedPaths.add(databasePath);
    }
  }
  return [...protectedPaths];
}

function resolveDoctorSessionSqliteMaintenanceRoots(
  targets: readonly SessionStoreTarget[],
  env: NodeJS.ProcessEnv,
): string[] {
  const stateDir = path.resolve(resolveStateDir(env));
  const roots = new Set([stateDir]);
  for (const target of targets) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (isPathWithin(stateDir, target.storePath) && isPathWithin(stateDir, sqlitePath)) {
      continue;
    }
    const commonRoot = commonPathAncestor(path.dirname(target.storePath), path.dirname(sqlitePath));
    const parentRoot = path.dirname(commonRoot);
    roots.add(parentRoot === path.parse(commonRoot).root ? commonRoot : parentRoot);
  }
  return [...roots];
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  return isPathInside(rootPath, path.resolve(candidatePath));
}

function commonPathAncestor(leftPath: string, rightPath: string): string {
  let currentPath = path.resolve(leftPath);
  const resolvedRightPath = path.resolve(rightPath);
  while (!isPathWithin(currentPath, resolvedRightPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return currentPath;
    }
    currentPath = parentPath;
  }
  return currentPath;
}

// Direct store migrations are scoped by path; broader agent discovery needs runtime config.
function resolveDoctorSessionSqliteConfig(options: DoctorSessionSqliteOptions): OpenClawConfig {
  if (options.cfg) {
    return options.cfg;
  }
  const requestedAgentId = normalizeAgentId(options.agent ?? LEGACY_IMPLICIT_AGENT_ID);
  return options.store
    ? { agents: { entries: { [requestedAgentId]: { default: true } } } }
    : getRuntimeConfig();
}

function resolveDoctorSessionSqliteTargets(params: {
  allAgents?: boolean;
  agent?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: DoctorSessionSqliteMode;
  store?: string;
}): SessionStoreTarget[] {
  if (params.store) {
    return resolveSessionStoreTargets(params.cfg, { store: params.store }, { env: params.env });
  }
  const discoversHistory =
    params.mode === "dry-run" || params.mode === "import" || params.mode === "validate";
  if (
    params.mode === "restore" ||
    params.mode === "recover" ||
    (discoversHistory && params.agent)
  ) {
    const candidates = resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
      env: params.env,
    });
    if (!params.agent) {
      return candidates;
    }
    const requestedAgentId = normalizeAgentId(params.agent);
    return candidates.filter((target) => normalizeAgentId(target.agentId) === requestedAgentId);
  }
  if (params.agent) {
    return resolveAgentSessionStoreTargetsSync(params.cfg, params.agent, { env: params.env });
  }
  if (params.allAgents) {
    // Discovery must admit validated directories even before either registry exists.
    const targets = discoversHistory
      ? resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, { env: params.env })
      : resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env });
    if (!discoversHistory) {
      return targets;
    }
    const legacyStorePath = path.join(resolveStateDir(params.env), "sessions", "sessions.json");
    if (!fs.existsSync(legacyStorePath)) {
      return targets;
    }
    const legacyTargets = resolveSessionStoreTargets(
      params.cfg,
      { allAgents: true },
      { env: params.env },
    ).map((target) => ({
      agentId: target.agentId,
      sqlitePath: resolveTargetSqlitePath(target),
      storePath: legacyStorePath,
    }));
    return [...legacyTargets, ...targets];
  }
  return resolveSessionStoreTargets(params.cfg, {}, { env: params.env });
}

function filterLegacySessionStoreTargets(
  targets: SessionStoreTarget[],
  mode: DoctorSessionSqliteMode,
  historicalArchives: HistoricalArchiveSources,
): SessionStoreTarget[] {
  if (mode === "inspect" || mode === "compact" || mode === "restore" || mode === "recover") {
    return targets;
  }
  return targets.filter(
    (target) =>
      !target.storePath.endsWith(".sqlite") &&
      (fs.existsSync(target.storePath) ||
        (historicalArchives.get(canonicalMigrationFilePath(target.storePath))?.transcripts.length ??
          0) > 0 ||
        (fs.existsSync(path.dirname(target.storePath)) &&
          fs.readdirSync(path.dirname(target.storePath)).some(isPrimarySessionTranscriptFileName))),
  );
}

async function inspectOrMigrateTarget(params: {
  verifyMissingIndex: ReturnType<typeof createMissingSessionIndexVerifier>;
  historicalArchives?: HistoricalArchiveSources;
  referencedPaths?: ReadonlySet<string>;
  activeRun?: ActiveSessionSqliteMigrationRun;
  archiveTargets?: LegacyArchiveTarget[];
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  mode: Exclude<DoctorSessionSqliteMode, "restore">;
  target: SessionStoreTarget;
  expectedIndexIdentity?: MigrationArtifactIdentity;
  deferredPluginIds?: string[];
}): Promise<DoctorSessionSqliteTargetReport> {
  const issues: DoctorSessionSqliteIssue[] = [];
  // Exact SQLite locators are maintenance targets, never legacy import sources.
  // Keeping them out of the file path also prevents archiving a live database.
  const isSqliteStore = params.target.storePath.endsWith(".sqlite");
  const retained = prepareRetainedSessionImport(params, issues);
  if (!retained) {
    return createDoctorSessionSqliteTargetReport({
      ...params.target,
      sqlitePath: resolveTargetSqlitePath(params.target, params.env),
      issues,
    });
  }
  const { retainedImport, sourceConflicts, retainedIndexPath } = retained;
  const allRecords = isSqliteStore
    ? []
    : readLegacySessionRecords(params.target, issues, {
        allowMissingStore: true,
        ...(retainedIndexPath ? { sourcePath: retainedIndexPath } : {}),
        verifiedSourcePaths: retainedImport
          ? new Set(retainedImport.sources.map((source) => source.path))
          : undefined,
      });
  if (
    !isSqliteStore &&
    (!retainedImport || !retainedIndexPath) &&
    params.mode !== "inspect" &&
    params.mode !== "compact" &&
    (issues.length === 0 || retainedImport)
  ) {
    const archiveSources = params.historicalArchives?.get(
      canonicalMigrationFilePath(params.target.storePath),
    );
    // Archived registries supply lineage only; never replay stale entries over live SQLite state.
    const ownershipRecords: LegacySessionRecord[] = [];
    let archiveOwnershipVerified = true;
    for (const move of retainedImport ? [] : (archiveSources?.stores ?? [])) {
      if (!fs.existsSync(move.archivePath)) {
        continue;
      }
      const ownershipIssues: DoctorSessionSqliteIssue[] = [];
      try {
        if (
          !sameMigrationArtifact(
            readMigrationArtifactIdentity(move.archivePath),
            move.artifact!.identity,
          )
        ) {
          throw new Error("archived registry identity changed");
        }
        ownershipRecords.push(
          ...readLegacySessionRecords(params.target, ownershipIssues, {
            sourcePath: move.archivePath,
          }),
        );
        if (
          ownershipIssues.length ||
          !sameMigrationArtifact(
            readMigrationArtifactIdentity(move.archivePath),
            move.artifact!.identity,
          )
        ) {
          throw new Error("archived registry could not be verified");
        }
      } catch (error) {
        archiveOwnershipVerified = false;
        issues.push({
          code: "historical_transcript_deferred",
          message: `${move.archivePath}: ${String(error)}`,
        });
      }
    }
    const snapshot = readOnlySqliteValidationSnapshot(params.target);
    if (snapshot.ok && archiveOwnershipVerified) {
      const discovered = await discoverLegacyHistoricalTranscripts({
        target: params.target,
        records: allRecords,
        ownershipRecords,
        referencedPaths: params.referencedPaths,
        archiveSources:
          !retainedImport && archiveOwnershipVerified ? archiveSources?.transcripts : [],
        verifiedSourcePaths: retainedImport
          ? new Set(
              retainedImport.sources
                .filter((source) => !sourceConflicts.has(source.path))
                .map((source) => source.path),
            )
          : undefined,
        snapshot: snapshot.snapshot,
        issues,
      });
      for (const historical of discovered) {
        const registered = allRecords.find(
          (record) =>
            record.sessionKey === historical.sessionKey &&
            record.entry.sessionId === historical.entry.sessionId &&
            (!record.transcriptPath || !fs.existsSync(record.transcriptPath)),
        );
        if (registered) {
          // Resolve a missing legacy filename here, never in runtime session path resolution.
          registered.transcriptPath = historical.transcriptPath;
          registered.transcriptDependencies.push(...historical.transcriptDependencies);
          registered.historical = historical.historical;
        } else {
          allRecords.push(historical);
        }
      }
    } else if (!snapshot.ok) {
      issues.push({ code: "sqlite_read_failed", message: String(snapshot.error) });
    }
  }
  const records = shouldFilterLegacySessionRecordsByTarget(params.target)
    ? allRecords.filter((record) =>
        isLegacySessionRecordOwnedByTarget(params.cfg, params.target, record.sessionKey),
      )
    : allRecords;
  const referencedTranscriptFiles = new Set(
    allRecords.flatMap((record) => (record.transcriptPath ? [record.transcriptPath] : [])),
  );
  const report = createDoctorSessionSqliteTargetReport({
    agentId: params.target.agentId,
    archivedLegacyStoreFiles: [],
    issues,
    legacyEntries: records.length,
    referencedTranscriptFiles: referencedTranscriptFiles.size,
    sqliteEntries: readSqliteEntryCount(params.target),
    sqlitePath: resolveTargetSqlitePath(params.target),
    storePath: params.target.storePath,
    unreferencedJsonlFiles: isSqliteStore
      ? []
      : listUnreferencedJsonlFiles(params.target.storePath, [...referencedTranscriptFiles]),
  });
  const retainedSourcePaths = retainedImport
    ? new Set(retainedImport.sources.map((source) => canonicalMigrationFilePath(source.path)))
    : undefined;
  if ((params.mode === "import" && retainedImport) || params.mode === "recover") {
    const activeRecords = await prepareActiveSqliteTranscriptSettlement({
      target: params.target,
      env: params.env,
      report,
      excludedPaths: retainedSourcePaths ?? new Set(),
    });
    if (activeRecords.length > 0) {
      const target = createMigrationTargetInput(params.target);
      const activeRun = params.activeRun ?? createSessionSqliteMigrationRun(params.env, [target]);
      const activeCoverage = gatherLegacyArchiveCoverage(params.cfg, params.env, [params.target]);
      if (isSqliteStore) {
        // An explicit database is a maintenance locator, never an index to import or archive.
        activeCoverage.selectedStorePaths.add(target.storePath);
      }
      await archiveLegacyArtifacts(
        [
          {
            sourceTarget: params.target,
            target,
            report,
            validated: true,
            deferredPluginIds: [],
            retainedImportVerified: false,
            records: activeRecords.map(({ entry, ...record }) => ({
              ...record,
              sessionId: entry.sessionId,
            })),
          },
        ],
        activeCoverage,
        activeRun,
        undefined,
        new Set(activeRecords.map((record) => record.transcriptPath!)),
      );
      updateMigrationManifestTarget(activeRun, target, report.issues, {
        validationBeforeArchive: "passed",
      });
      if (!params.activeRun) {
        activeRun.manifest.completedAt = new Date().toISOString();
        writeSessionSqliteMigrationManifest(activeRun);
      }
    }
  }
  if (
    retainedImport &&
    params.mode !== "import" &&
    retainedImport.sources.some((source) => fs.existsSync(source.path))
  ) {
    appendRetainedPluginSessionSourceIssue(report, params.deferredPluginIds ?? []);
  }
  if (params.mode === "compact") {
    await compactSqliteDatabase(params.target, report, { env: params.env });
    report.sqliteEntries = readSqliteEntryCount(params.target);
  }
  if (isSqliteStore || params.mode === "inspect" || params.mode === "compact") {
    appendSqliteDbStats(params.target, report);
    if (params.mode !== "compact") {
      appendActiveSqliteTranscriptFileIssues(params.target, report, retainedSourcePaths);
    }
    return report;
  }
  // A retained but ineligible support artifact does not make an already migrated store work.
  if (records.length === 0 && !fs.existsSync(params.target.storePath) && !retainedImport) {
    report.sqliteEntries = 0;
    return report;
  }
  if (!retainedImport && params.verifyMissingIndex(report)) {
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      report.issues,
      { validationBeforeArchive: "passed" },
    );
    return report;
  }
  if (retainedImport) {
    countRetainedSessionSources(retained, records, report);
  } else if (params.mode === "import") {
    await importLegacySessionRecords(params.target, records, report);
  } else if (params.mode === "dry-run") {
    for (const record of records) {
      countLegacyTranscript(record, report);
    }
  } else {
    validateLegacySessionRecords(params.target, records, report, "validate");
  }
  let validationPassed = retainedImport !== undefined;
  if (params.mode === "import" && retainedImport) {
    // Exact source and database identities carry the earlier verified import into archival.
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      report.issues,
      {
        validationBeforeArchive: "passed",
      },
    );
  }
  if (
    params.mode === "import" &&
    !retainedImport &&
    countBlockingSessionSqliteIssues(report) === 0
  ) {
    validationPassed = validateLegacySessionRecords(
      params.target,
      records,
      report,
      "before-archive",
    );
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      report.issues,
      {
        validationBeforeArchive: validationPassed ? "passed" : "failed",
      },
    );
    if (validationPassed && params.activeRun) {
      const recoveredMoves = records.flatMap((record) =>
        record.historical?.archiveMove && record.recovery?.complete
          ? [
              {
                ...record.historical.archiveMove,
                sessionKey: record.sessionKey,
                artifact: {
                  ...record.historical.archiveMove.artifact!,
                  classification: "protected" as const,
                  reason: HISTORICAL_IMPORT_REASON,
                },
              },
            ]
          : [],
      );
      // Receipt after verified import allows crash retry, but prevents resurrection after later deletion.
      if (recoveredMoves.length > 0) {
        recordPlannedMigrationMoves(
          params.activeRun,
          createMigrationTargetInput(params.target),
          recoveredMoves,
        );
        recordCompletedMigrationMoves(
          params.activeRun,
          createMigrationTargetInput(params.target),
          recoveredMoves,
        );
      }
    }
    if (validationPassed) {
      // Finalization enables incremental vacuum where needed and releases free pages.
      await compactSqliteDatabase(params.target, report, {
        env: params.env,
        operation: "import-finalize",
      });
    }
  }
  if (params.mode === "import") {
    const deferredPluginIds = params.deferredPluginIds ?? [];
    // Zero-row validation may certify an existing canonical store, but must never
    // create a database solely for an unused shared-index owner.
    const verifiedImport =
      validationPassed &&
      (retainedImport !== undefined ||
        records.length > 0 ||
        fs.existsSync(resolveTargetSqlitePath(params.target, params.env)));
    let retainedImportVerified = retainedImport !== undefined;
    let verifiedSources = retainedImport?.sources;
    const indexIdentity = params.expectedIndexIdentity;
    if (
      !retainedImport &&
      indexIdentity &&
      verifiedImport &&
      report.issues.every(isRetainedSourceIssue)
    ) {
      try {
        verifiedSources = captureDeferredPluginSessionSources({
          storePath: params.target.storePath,
          indexIdentity,
          records,
          unreferencedJsonlFiles: report.unreferencedJsonlFiles,
          referencedPaths: params.referencedPaths,
        });
      } catch (error) {
        report.issues.push({
          code: "transcript_archive_failed",
          message: formatErrorMessage(error),
        });
      }
    }
    if (
      deferredPluginIds.length > 0 &&
      verifiedImport &&
      report.issues.every(isRetainedSourceIssue)
    ) {
      if (!retainedImport) {
        if (!verifiedSources) {
          if (
            !fs.existsSync(params.target.storePath) &&
            records.every((record) => record.historical?.archiveMove) &&
            listUnreferencedJsonlFiles(params.target.storePath, []).length === 0
          ) {
            // Historical archives already have verified move receipts; no live inputs need deferral.
            report.sqliteEntries = readSqliteEntryCount(params.target);
            return report;
          }
          throw new Error(
            `Deferred plugin session inputs have no verified source index: ${params.target.storePath}. Preserve the session files and migration archives; restore the matching sessions.json from a backup, then run openclaw doctor --fix.`,
          );
        }
        recordDeferredPluginSessionImport({
          cfg: params.cfg,
          target: params.target,
          sqlitePath: resolveTargetSqlitePath(params.target, params.env),
          env: params.env,
          pluginIds: deferredPluginIds,
          sources: verifiedSources,
          recordCount: records.length,
        });
        retainedImportVerified = true;
      }
      appendRetainedPluginSessionSourceIssue(report, deferredPluginIds);
    }
    // Retain importer outcomes, not entry or transcript payloads, until every owner finishes.
    params.archiveTargets?.push({
      sourceTarget: params.target,
      target: createMigrationTargetInput(params.target),
      report,
      validated: validationPassed,
      deferredPluginIds,
      retainedImportVerified,
      sourceConflicts,
      verifiedSources,
      records: records
        .filter(
          (record) =>
            !record.historical?.archiveMove && !sourceConflicts.has(record.transcriptPath ?? ""),
        )
        .map(({ entry, ...record }) => Object.assign(record, { sessionId: entry.sessionId })),
    });
  }
  report.sqliteEntries = readSqliteEntryCount(params.target);
  if (params.mode !== "import") {
    appendActiveSqliteTranscriptFileIssues(params.target, report, retainedSourcePaths);
  }
  updateMigrationManifestTarget(
    params.activeRun,
    createMigrationTargetInput(params.target),
    report.issues,
  );
  return report;
}

async function importLegacySessionRecords(
  target: SessionStoreTarget,
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const importedTranscriptSources = new Set<string>();
  const existingSnapshot = readOnlySqliteValidationSnapshot(target);
  for (let offset = 0; offset < records.length; offset += SESSION_IMPORT_BATCH_SIZE) {
    const pending = records.slice(offset, offset + SESSION_IMPORT_BATCH_SIZE).flatMap((record) => {
      const prepared = prepareLegacySessionImport(
        target,
        record,
        report,
        importedTranscriptSources,
        existingSnapshot.ok ? existingSnapshot.snapshot : undefined,
      );
      return prepared ? [{ ...prepared, record }] : [];
    });
    const imported = await importSqliteSessionRowsBatch(pending.map((entry) => entry.params));
    for (const [index, result] of imported.entries()) {
      const record = pending[index]?.record;
      if (record && result.recovery) {
        record.recovery = result.recovery;
      }
    }
    report.importedEntries += imported.length;
    report.importedTranscriptEvents += imported.reduce(
      (total, result) => total + result.transcriptEvents,
      0,
    );
    report.issues.push(...pending.flatMap((entry) => (entry.issue ? [entry.issue] : [])));
    await setImmediate();
  }
}

function prepareLegacySessionImport(
  target: SessionStoreTarget,
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  importedTranscriptSources: Set<string>,
  existingSnapshot: ReadOnlySqliteValidationSnapshot | undefined,
) {
  if (
    record.historical &&
    record.transcriptPath &&
    !sameMigrationArtifact(
      record.historical.identity,
      readMigrationArtifactIdentity(record.transcriptPath),
    )
  ) {
    report.issues.push({
      code: "historical_transcript_deferred",
      sessionKey: record.sessionKey,
      message: `${record.historical.originalPath}: source changed after discovery; retained without importing`,
    });
    return undefined;
  }
  const transcriptSourceKey = record.transcriptPath
    ? `${record.entry.sessionId}\0${record.transcriptPath}`
    : undefined;
  const transcriptFingerprint =
    transcriptSourceKey !== undefined &&
    !importedTranscriptSources.has(transcriptSourceKey) &&
    record.transcriptPath &&
    fs.existsSync(record.transcriptPath)
      ? readTranscriptFingerprint(record.transcriptPath)
      : undefined;
  record.sourceFingerprint = transcriptFingerprint;
  const result = countTranscriptEvents(record);
  const transcriptMtimeMs = readLegacyTranscriptMtimeMs(record);
  const acpEntry = !record.historical
    ? normalizePersistedSessionEntryShape(record.entry, { sessionKey: record.sessionKey })
    : undefined;
  const params = {
    historicalOnly: Boolean(record.historical),
    allowMalformedRowRepair: true,
    repairLegacyTranscript: true,
    agentId: target.agentId,
    entry: record.entry,
    ...(acpEntry?.acp
      ? {
          legacyAcpMigrationSource: prepareLegacyAcpMigrationSource({
            sourcePath: target.storePath,
            sourceSessionKey: record.sessionKey,
            sessionId: acpEntry.sessionId,
            lifecycleRevision: acpEntry.lifecycleRevision,
            meta: acpEntry.acp,
          }),
        }
      : {}),
    preserveExactStoredKey: true,
    sessionKey: record.sessionKey,
    storePath: target.sqlitePath ?? target.storePath,
  };
  if (result.status === "missing") {
    if (markAlreadyMigratedTranscript(record, report, existingSnapshot)) {
      return undefined;
    }
    return {
      issue: {
        code: "transcript_missing",
        message: `Transcript file is missing: ${record.transcriptPath}`,
        sessionKey: record.sessionKey,
      },
      params,
    };
  }
  if (transcriptSourceKey) {
    importedTranscriptSources.add(transcriptSourceKey);
  }
  return {
    ...(result.status === "malformed"
      ? {
          issue: {
            code: "transcript_malformed" as const,
            message: result.message,
            sessionKey: record.sessionKey,
          },
        }
      : {}),
    params: {
      ...params,
      ...(record.transcriptPath && transcriptFingerprint
        ? {
            readTranscriptEvents: createTranscriptEventReader(
              record.transcriptPath,
              record.entry.sessionId,
              result.status === "malformed",
              transcriptFingerprint,
              record.historical?.originalPath ?? record.transcriptPath,
            ),
          }
        : {}),
      ...(transcriptMtimeMs !== undefined ? { transcriptMtimeMs } : {}),
    },
  };
}

function markAlreadyMigratedTranscript(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
): boolean {
  const migratedEvents = countAlreadyMigratedTranscriptEventsForImport(snapshot, record);
  if (migratedEvents === undefined) {
    return false;
  }
  report.validatedEntries += 1;
  report.validatedTranscriptEvents += migratedEvents;
  return true;
}

function validateLegacySessionRecords(
  target: SessionStoreTarget,
  records: readonly LegacySessionRecord[],
  report: DoctorSessionSqliteTargetReport,
  purpose: "validate" | "before-archive",
): boolean {
  if (purpose === "before-archive" && records.length === 0) {
    return true;
  }
  const issueCountBeforeValidation = report.issues.length;
  const validation = readOnlySqliteValidationSnapshot(target);
  if (!validation.ok) {
    report.issues.push({
      code: "sqlite_read_failed",
      message: `SQLite validation read failed: ${String(validation.error)}`,
    });
    return false;
  }
  for (const record of records) {
    validateLegacySessionRecord(record, report, validation.snapshot, purpose);
  }
  return report.issues.length === issueCountBeforeValidation;
}

function validateLegacySessionRecord(
  record: LegacySessionRecord,
  report: DoctorSessionSqliteTargetReport,
  snapshot: ReadOnlySqliteValidationSnapshot,
  purpose: "validate" | "before-archive",
): void {
  const beforeArchive = purpose === "before-archive";
  // Import preserves aliases until canonical repair; standalone validation compares canonical keys.
  const normalizedKey = beforeArchive
    ? record.sessionKey
    : normalizeStoreSessionKey(record.sessionKey);
  const sqliteSessionId = record.historical
    ? snapshot.sessionKeysBySessionId.get(record.entry.sessionId) === normalizedKey
      ? record.entry.sessionId
      : undefined
    : snapshot.sessionIdsBySessionKey.get(normalizedKey);
  if (!sqliteSessionId) {
    report.issues.push({
      code: "sqlite_entry_missing",
      message: `SQLite entry is missing for ${normalizedKey}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (sqliteSessionId !== record.entry.sessionId) {
    report.issues.push({
      code: "sqlite_entry_mismatch",
      message: `SQLite sessionId ${sqliteSessionId} does not match ${record.entry.sessionId}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (!beforeArchive) {
    report.validatedEntries += 1;
  }
  const result = countTranscriptEvents(record);
  if (result.status === "missing") {
    if (!beforeArchive) {
      report.validatedTranscriptEvents +=
        snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
    }
    return;
  }
  if (result.status !== "ok") {
    if (!hasSessionIssue(report, "transcript_malformed", record.sessionKey)) {
      report.issues.push({
        code: "transcript_malformed",
        message: result.message,
        sessionKey: record.sessionKey,
      });
    }
    return;
  }
  const sqliteEvents = snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
  // Verified import may retain later history and repair source rows; validation compares the raw count.
  const expectedEvents = beforeArchive ? (record.recovery?.events ?? result.events) : result.events;
  if (beforeArchive ? sqliteEvents < expectedEvents : sqliteEvents !== expectedEvents) {
    report.issues.push({
      code: "sqlite_transcript_count_mismatch",
      message: beforeArchive
        ? `SQLite transcript has ${sqliteEvents} events; verified import expects ${expectedEvents}.`
        : `SQLite transcript has ${sqliteEvents} events; source has ${result.events}.`,
      sessionKey: record.sessionKey,
    });
    return;
  }
  if (!beforeArchive) {
    report.validatedTranscriptEvents += sqliteEvents;
  }
}

async function archiveLegacyArtifacts(
  owners: readonly LegacyArchiveTarget[],
  coverage: ReturnType<typeof gatherLegacyArchiveCoverage>,
  activeRun: ActiveSessionSqliteMigrationRun,
  assertCurrent?: () => void,
  capturedSources?: ReadonlySet<string>,
  publishSourceRemoval?: (remove: () => void, retainSource: () => void) => void,
): Promise<void> {
  const {
    selectedStorePaths,
    referencedPaths,
    retainedPaths,
    incompleteDirectories,
    retainedDirectories,
  } = coverage;
  const references = new Map<
    string,
    Array<{ owner: LegacyArchiveTarget; record: LegacyArchiveTarget["records"][number] }>
  >();
  for (const owner of owners) {
    if (!owner.validated || countBlockingSessionSqliteIssues(owner.report) > 0) {
      selectedStorePaths.delete(owner.target.storePath);
    }
    for (const record of owner.records) {
      if (!record.transcriptPath) {
        continue;
      }
      const source = canonicalMigrationFilePath(record.transcriptPath);
      references.set(source, [...(references.get(source) ?? []), { owner, record }]);
    }
  }
  // A retained index needs all its originals. Propagate through shared sources before planning,
  // so a direct retry cannot strand a sibling archive without its index.
  const retainedSources = [...references]
    .filter(
      ([source, refs]) =>
        retainedPaths.has(source) ||
        retainedDirectories.has(path.dirname(source)) ||
        refs.some(({ owner }) => !selectedStorePaths.has(owner.target.storePath)),
    )
    .map(([source]) => source);
  for (const source of retainedSources) {
    for (const file of [
      source,
      resolveTrajectoryPath(source),
      resolveTrajectoryPointerPath(source),
    ]) {
      if (file) {
        retainedPaths.add(file);
      }
    }
    for (const { owner } of references.get(source) ?? []) {
      const storePath = owner.target.storePath;
      if (!selectedStorePaths.delete(storePath)) {
        continue;
      }
      for (const sibling of owners.filter((item) => item.target.storePath === storePath)) {
        for (const record of sibling.records) {
          if (!record.transcriptPath) {
            continue;
          }
          const siblingSource = canonicalMigrationFilePath(record.transcriptPath);
          if (!retainedPaths.has(siblingSource)) {
            retainedPaths.add(siblingSource);
            retainedSources.push(siblingSource);
          }
        }
      }
    }
  }
  const reservedArchivePaths = new Set<string>();
  const planned = new Map<
    string,
    { move: SessionSqliteMigrationMove; owners: Map<LegacyArchiveTarget, string | undefined> }
  >();
  const recordFailure = (
    owner: LegacyArchiveTarget,
    source: string,
    error: unknown,
    unreferenced = false,
  ) => {
    owner.report.issues.push({
      code: unreferenced ? "unreferenced_jsonl_archive_failed" : "transcript_archive_failed",
      message: `${source}: ${formatErrorMessage(error)}`,
    });
  };
  for (const [source, refs] of references) {
    const first = refs[0]!;
    if (!fs.existsSync(source)) {
      // Only initially missing sources may be skipped. Losing an admitted original must
      // protect every referencing index and its remaining recovery dependencies.
      if (refs.some(({ record }) => record.sourceFingerprint)) {
        for (const owner of new Set(refs.map((ref) => ref.owner))) {
          recordFailure(owner, source, "Imported transcript disappeared before archival");
        }
      }
      continue;
    }
    if (retainedPaths.has(source) || retainedDirectories.has(path.dirname(source))) {
      for (const { owner, record } of refs) {
        if (
          countBlockingSessionSqliteIssues(owner.report) === 0 &&
          owner.deferredPluginIds.length === 0
        ) {
          owner.report.issues.push({
            code: "transcript_archive_deferred",
            message: `${source}: retaining the original for an incomplete or unselected importing owner; rerun import for all known owners after resolving their index/import issues.`,
            sessionKey: record.sessionKey,
          });
        }
      }
      continue;
    }
    try {
      const moves = planImportedTranscriptArtifactsToArchive(
        first.owner.target,
        first.record.sessionKey,
        source,
        reservedArchivePaths,
        capturedSources,
      );
      // Same-session aliases reuse the actual importer evidence only within their validated target.
      const imports = refs.map(({ owner, record }) =>
        record.sourceFingerprint
          ? record
          : refs.find(
              (ref) =>
                ref.owner === owner &&
                ref.record.sessionId === record.sessionId &&
                ref.record.sourceFingerprint,
            )?.record,
      );
      const fingerprints = imports.flatMap((record) =>
        record?.sourceFingerprint ? [record.sourceFingerprint] : [],
      );
      const fingerprint = fingerprints[0];
      if (
        fingerprint &&
        fingerprints.some((current) =>
          (["ctimeNs", "dev", "ino", "mtimeNs", "size"] as const).some(
            (key) => current[key] !== fingerprint[key],
          ),
        )
      ) {
        throw new Error("Transcript changed between imports; retaining the unverified original");
      }
      const complete =
        !incompleteDirectories.has(path.dirname(source)) &&
        imports.every((record) => record?.sourceFingerprint && record.recovery?.complete) &&
        refs.every(
          ({ owner, record }) =>
            !hasSessionIssue(owner.report, "transcript_malformed", record.sessionKey),
        );
      for (const move of moves) {
        if (retainedPaths.has(move.sourcePath)) {
          throw new Error("Artifact is required by an incomplete importing owner");
        }
        move.artifact = {
          identity: readMigrationArtifactIdentity(
            move.sourcePath,
            1n,
            move.kind === "transcript" ? fingerprint : undefined,
          ),
          classification:
            complete && move.kind === "transcript" && !first.record.historical
              ? imports.some((record) => record?.recovery?.repaired)
                ? "repair-original"
                : "imported"
              : "protected",
          reason:
            complete && first.record.historical && move.kind === "transcript"
              ? HISTORICAL_IMPORT_REASON
              : complete && move.kind === "transcript"
                ? "verified-import-original"
                : "unimported-or-unknown-history",
          dependencies: [],
          disposal: { state: "retained" },
        };
        const existing = planned.get(move.sourcePath);
        if (existing) {
          if (move.artifact.classification === "protected") {
            existing.move.artifact = move.artifact;
          }
          for (const ref of refs) {
            existing.owners.set(ref.owner, ref.record.sessionKey);
          }
        } else {
          planned.set(move.sourcePath, {
            move,
            owners: new Map(refs.map((ref) => [ref.owner, ref.record.sessionKey])),
          });
        }
      }
    } catch (error) {
      for (const owner of new Set(refs.map((ref) => ref.owner))) {
        recordFailure(owner, source, error);
      }
    }
  }
  // Gather all indexed sources and plans before sweeping any directory; another custom index
  // may own a file even when its importer failed or was not selected for this run.
  for (const owner of owners) {
    const storePath = owner.target.storePath;
    if (
      !selectedStorePaths.has(storePath) ||
      countBlockingSessionSqliteIssues(owner.report) > 0 ||
      incompleteDirectories.has(path.dirname(storePath))
    ) {
      continue;
    }
    for (const source of listUnreferencedJsonlFiles(storePath, [
      ...referencedPaths,
      ...planned.keys(),
    ])) {
      if (retainedPaths.has(source)) {
        continue;
      }
      if (capturedSources && !capturedSources.has(source)) {
        continue;
      }
      try {
        const move = planSessionJsonlArchiveMove({
          archiveKey: "archive-tier",
          baseNameRaw: path.basename(source),
          kind: "unreferenced-jsonl",
          reservedArchivePaths,
          sourcePathRaw: source,
          target: owner.target,
        });
        move.artifact = {
          identity: readMigrationArtifactIdentity(source),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        };
        reservedArchivePaths.add(move.archivePath);
        planned.set(source, { move, owners: new Map([[owner, undefined]]) });
      } catch (error) {
        recordFailure(owner, source, error, true);
      }
    }
  }
  // A physical move must remain resolvable through every receipt that captured its source.
  for (const owner of owners) {
    for (const { path: source } of owner.verifiedSources ?? []) {
      const shared = planned.get(source);
      if (shared && !shared.owners.has(owner)) {
        shared.owners.set(owner, undefined);
      }
    }
  }
  const movesForOwner = (owner: LegacyArchiveTarget) =>
    [...planned.values()]
      .filter((item) => item.owners.has(owner))
      .map(({ move, owners: refs }) => Object.assign({}, move, { sessionKey: refs.get(owner) }));
  // Every referencing target gets its own session key and shared mapping before publication.
  for (const owner of owners) {
    assertCurrent?.();
    recordPlannedMigrationMoves(activeRun, owner.target, movesForOwner(owner));
  }
  const completed = new Set<string>();
  for (const { move, owners: referencingOwners } of planned.values()) {
    try {
      for (const owner of referencingOwners.keys()) {
        assertSafeSessionSqliteMigrationMove(move, owner.target);
      }
      assertCurrent?.();
      await moveMigrationArtifact(
        move.sourcePath,
        move.archivePath,
        move.artifact!.identity,
        assertCurrent
          ? () => {
              assertCurrent();
            }
          : undefined,
        publishSourceRemoval,
      );
      assertCurrent?.();
      completed.add(move.sourcePath);
      for (const { report } of referencingOwners.keys()) {
        (move.kind === "unreferenced-jsonl"
          ? report.archivedUnreferencedJsonlFiles
          : report.archivedTranscriptFiles
        ).push(move.archivePath);
      }
    } catch (error) {
      if (error instanceof DeferredPluginMigrationConflictError && error.pending.length > 0) {
        break;
      }
      for (const owner of referencingOwners.keys()) {
        recordFailure(owner, move.sourcePath, error, move.kind === "unreferenced-jsonl");
      }
    }
  }
  for (const owner of owners) {
    assertCurrent?.();
    recordCompletedMigrationMoves(
      activeRun,
      owner.target,
      movesForOwner(owner).filter((move) => completed.has(move.sourcePath)),
    );
    owner.report.unreferencedJsonlFiles = listUnreferencedJsonlFiles(owner.target.storePath, [
      ...referencedPaths,
    ]);
  }
}

async function archiveImportedLegacySessionStores(
  owners: readonly LegacyArchiveTarget[],
  activeRun: ActiveSessionSqliteMigrationRun,
  coverage: ReturnType<typeof gatherLegacyArchiveCoverage>,
  assertCurrent?: () => void,
  publishSourceRemoval?: (remove: () => void, retainSource: () => void) => void,
): Promise<void> {
  const byStore = new Map<string, LegacyArchiveTarget[]>();
  for (const owner of owners) {
    const storePath = owner.target.storePath;
    byStore.set(storePath, [...(byStore.get(storePath) ?? []), owner]);
  }
  for (const [storePath, entries] of byStore) {
    assertCurrent?.();
    // A historical-only target may never have had an index; losing an admitted index is a failure.
    if (!coverage.indexIdentities.has(storePath) && !fs.existsSync(storePath)) {
      continue;
    }
    if (
      !coverage.selectedStorePaths.has(storePath) ||
      entries.some(
        ({ report }) =>
          countBlockingSessionSqliteIssues(report) > 0 ||
          report.issues.some((issue) => issue.code === "active_sqlite_transcript_jsonl"),
      )
    ) {
      continue;
    }
    const first = entries[0]!;
    let publicationPlanned = false;
    try {
      const expected = coverage.indexIdentities.get(storePath);
      if (!expected || !sameMigrationArtifact(readMigrationArtifactIdentity(storePath), expected)) {
        throw new Error("Session index changed after import; retaining the unverified original");
      }
      const move = planSessionJsonlArchiveMove({
        archiveKey: "legacy-store",
        baseNameRaw: path.basename(storePath),
        kind: "legacy-store",
        sourcePathRaw: storePath,
        target: first.target,
      });
      const manifestTargets = activeRun.manifest.targets.filter(
        (target) => target.storePath === storePath,
      );
      const transcripts = manifestTargets.flatMap((target) =>
        target.plannedMoves.filter((item) => item.kind === "transcript"),
      );
      const complete =
        entries.every(({ validated, report }) => validated && report.issues.length === 0) &&
        transcripts.every((item) => item.artifact?.classification !== "protected");
      const dependencies = entries
        .flatMap(({ records }) => records.flatMap((record) => record.transcriptDependencies))
        .map(canonicalMigrationFilePath);
      move.artifact = {
        identity: expected,
        classification: complete ? "imported" : "protected",
        reason: complete ? "verified-index-import" : "incomplete-index-import",
        dependencies: [...new Set(dependencies)],
        disposal: { state: "retained" },
      };
      for (const { target } of entries) {
        assertCurrent?.();
        recordPlannedMigrationMoves(activeRun, target, [move]);
        assertSafeSessionSqliteMigrationMove(move, target);
      }
      publicationPlanned = true;
      assertCurrent?.();
      await moveMigrationArtifact(
        move.sourcePath,
        move.archivePath,
        expected,
        assertCurrent
          ? () => {
              assertCurrent();
            }
          : undefined,
        publishSourceRemoval,
      );
      assertCurrent?.();
      for (const { target, report } of entries) {
        recordCompletedMigrationMoves(activeRun, target, [move]);
        report.archivedLegacyStoreFiles!.push(move.archivePath);
      }
    } catch (error) {
      if (error instanceof DeferredPluginMigrationConflictError && error.pending.length > 0) {
        break;
      }
      for (const { report, target } of entries) {
        report.issues.push({
          code: "legacy_store_archive_failed",
          message: `${storePath}: ${formatErrorMessage(error)}`,
        });
        // A recorded index plan already protects its dependencies and can reconcile on retry.
        // Earlier failures have no artifact record, so retain that failure on the owner instead.
        if (!publicationPlanned) {
          assertCurrent?.();
          updateMigrationManifestTarget(activeRun, target, report.issues);
        }
      }
    }
  }
}

function hasSessionIssue(
  report: DoctorSessionSqliteTargetReport,
  code: string,
  sessionKey: string,
): boolean {
  return report.issues.some((issue) => issue.code === code && issue.sessionKey === sessionKey);
}

function countAlreadyMigratedTranscriptEventsForImport(
  snapshot: ReadOnlySqliteValidationSnapshot | undefined,
  record: LegacySessionRecord,
): number | undefined {
  if (!snapshot) {
    return undefined;
  }
  const normalizedKey = record.sessionKey;
  if (snapshot.sessionIdsBySessionKey.get(normalizedKey) !== record.entry.sessionId) {
    return undefined;
  }
  return snapshot.transcriptEventCountsBySessionId.get(record.entry.sessionId) ?? 0;
}

function countTranscriptEvents(
  record: LegacySessionRecord,
):
  | { status: "ok"; events: number }
  | { status: "missing" }
  | { status: "malformed"; message: string } {
  return countTranscriptEventsForPath(record.transcriptPath);
}

function readLegacyTranscriptMtimeMs(record: LegacySessionRecord): number | undefined {
  if (!record.transcriptPath) {
    return undefined;
  }
  try {
    const mtimeMs = Math.floor(fs.statSync(record.transcriptPath).mtimeMs);
    return Number.isFinite(mtimeMs) && mtimeMs >= 0 ? mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function createMigrationTargetInput(target: SessionStoreTarget): SessionSqliteMigrationTargetInput {
  return {
    agentId: target.agentId,
    sqlitePath: canonicalMigrationFilePath(resolveTargetSqlitePath(target)),
    storePath: canonicalMigrationFilePath(target.storePath),
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
