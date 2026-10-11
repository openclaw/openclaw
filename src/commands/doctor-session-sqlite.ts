import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds } from "../agents/agent-roster.js";
import {
  resolveTrajectoryPath,
  resolveTrajectoryPointerPath,
} from "../config/sessions/artifacts.js";
import {
  isLegacySessionRecordOwnedByTarget,
  shouldFilterLegacySessionRecordsByTarget,
} from "../config/sessions/legacy-store-inspection.js";
import type { SessionStoreTarget as ResolvedSessionStoreTarget } from "../config/sessions/targets.js";
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
  readStaleDeferredPluginSessionImport,
  recordDeferredPluginSessionImport,
  type DeferredPluginSessionImport,
} from "../infra/deferred-plugin-session-sources.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  readMigrationArtifactIdentity,
  moveMigrationArtifact,
  type MigrationArtifactIdentity,
} from "../infra/session-sqlite-migration-artifact.js";
import type { DoctorSessionSqliteIssue } from "../infra/session-sqlite-migration-issues.js";
import {
  HISTORICAL_IMPORT_REASON,
  canonicalMigrationFilePath,
  assertSafeSessionSqliteMigrationMove,
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationMoveKind,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  readOnlySqliteValidationSnapshot,
  readSqliteEntryCount,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import { prepareActiveSqliteTranscriptSettlement } from "./doctor-session-sqlite-active.js";
import {
  archiveImportedLegacySessionStores,
  planImportedTranscriptArtifactsToArchive,
  planSessionJsonlArchiveMove,
} from "./doctor-session-sqlite-archive.js";
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
  appendLegacyHistoricalTranscripts,
  gatherLegacyArchiveCoverage,
  listUnreferencedJsonlFiles,
  readLegacySessionRecords,
  type HistoricalArchiveSources,
} from "./doctor-session-sqlite-discovery.js";
import { writeSessionSqliteMigrationFailureReports } from "./doctor-session-sqlite-failure.js";
import { importLegacySessionRecords } from "./doctor-session-sqlite-import.js";
import { createMissingSessionIndexVerifier } from "./doctor-session-sqlite-missing-index.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import type { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreDoctorSessionSqliteTargets } from "./doctor-session-sqlite-restore-report.js";
import { reconcileSessionSqliteMigrationPublications } from "./doctor-session-sqlite-restore.js";
import {
  archiveConflictingRetainedSessionSources,
  countRetainedSessionSources,
  prepareRetainedSessionImport,
  retireDeferredPluginSessionImport,
} from "./doctor-session-sqlite-retained.js";
import { settleDuplicateSessionSqliteArchives } from "./doctor-session-sqlite-retirement.js";
import {
  createMigrationTargetInput,
  filterLegacySessionStoreTargets,
  prepareDoctorSessionSqliteTargets,
  resolveDoctorSessionSqliteConfig,
  resolveDoctorSessionSqliteMaintenancePaths,
  resolveDoctorSessionSqliteMaintenanceRoots,
  resolveDoctorSessionSqliteTargets,
} from "./doctor-session-sqlite-targets.js";
import {
  createDoctorSessionSqliteTargetReport,
  countBlockingSessionSqliteIssues,
  isRetainedSourceIssue,
  isSettleableIssue,
  isInformationalMissingSessionIndex,
  type DoctorSessionSqliteMode,
  type DoctorSessionSqliteOptions,
  type DoctorSessionSqliteReport,
  type DoctorSessionSqliteTargetReport,
  type LegacyArchiveTarget,
} from "./doctor-session-sqlite-types.js";
import { validateLegacySessionRecords } from "./doctor-session-sqlite-verification.js";
import {
  assertDoctorSqliteMaintenancePathsNotAliased,
  type DoctorSqliteMaintenanceAuthority,
} from "./doctor-sqlite-maintenance-lock.js";
export type {
  DoctorSessionSqliteOptions,
  DoctorSessionSqliteReport,
} from "./doctor-session-sqlite-types.js";

type SessionStoreTarget = ResolvedSessionStoreTarget & { sqlitePath?: string };

const retainedArchivePlans = new WeakMap<
  DoctorSessionSqliteReport,
  {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    owners: Array<{ owner: LegacyArchiveTarget; receipt: DeferredPluginSessionImport }>;
  }
>();

/** Destructive production callers hold the Gateway/SQLite-maintenance state lock for the full call. */
export async function runDoctorSessionSqlite(
  options: DoctorSessionSqliteOptions,
  authority?: DoctorSqliteMaintenanceAuthority,
): Promise<DoctorSessionSqliteReport> {
  const env = options.env ?? process.env;
  const cfg = resolveDoctorSessionSqliteConfig(options);
  const configuredAgentIds = new Set(listAgentIds(cfg));
  const pendingPlugins = readDeferredPluginMigrations({ env });
  const verifyMissingIndex = createMissingSessionIndexVerifier({ cfg, env });
  const {
    targets: candidates,
    knownTargets,
    repairEntryStates,
  } = await prepareDoctorSessionSqliteTargets({ ...options, cfg, env, authority });
  const settlements =
    options.mode === "import" || options.mode === "recover"
      ? await settleDuplicateSessionSqliteArchives({
          cfg,
          env,
          targets: candidates.map(createMigrationTargetInput),
        })
      : [];
  const settlementIssuesForStore = (storePath: string) =>
    settlements
      .filter((item) => item.target.storePath === storePath)
      .flatMap((item) => item.issues);
  let historicalSources = ["import", "dry-run", "validate", "recover"].includes(options.mode)
    ? collectHistoricalArchiveSources({ cfg, env })
    : undefined;
  let historicalArchives = historicalSources?.sources ?? new Map();
  const targets = filterLegacySessionStoreTargets(
    candidates,
    options.mode,
    historicalArchives,
    new Set(settlements.map(({ target }) => target.storePath)),
  );
  if (options.mode === "restore") {
    return restoreDoctorSessionSqliteTargets({
      env,
      targets,
    });
  }
  if (options.mode === "recover") {
    return recoverDoctorSessionSqliteTargets({
      env,
      targets,
      prepareTarget: (target) => repairEntryStates([target]),
      recoveryInventory: historicalSources?.inventory,
      historicalArchiveStores: new Set([
        ...historicalArchives.keys(),
        ...settlements.map(({ target }) => target.storePath),
      ]),
      validateTarget: async (target) => {
        authority?.assertCurrent();
        const report =
          collectHistoricalArchiveSources({ cfg, env }).sources.get(target.storePath)?.transcripts
            .length ||
          readStaleDeferredPluginSessionImport({ target, sqlitePath: target.sqlitePath, env })
            ? (
                await runDoctorSessionSqlite(
                  {
                    cfg,
                    env,
                    mode: "import",
                    store: target.storePath,
                    agent: target.agentId,
                  },
                  authority,
                )
              ).targets[0]!
            : await inspectOrMigrateTarget({
                configuredAgentIds,
                cfg,
                env,
                mode: "recover",
                target,
                verifyMissingIndex,
                deferredPluginIds: deferredPluginSessionStoreIds({
                  target,
                  pending: pendingPlugins,
                }),
              });
        report.issues.push(...settlementIssuesForStore(target.storePath));
        return report;
      },
    });
  }
  if (options.mode === "import") {
    await reconcileSessionSqliteMigrationPublications({
      env,
      trustedTargets: targets.map(createMigrationTargetInput),
    });
    // Reconciliation can consume a restored original and rewrite its receipt.
    historicalSources = collectHistoricalArchiveSources({ cfg, env });
    historicalArchives = historicalSources.sources;
  }
  const activeRun =
    options.mode === "import" && targets.length > 0
      ? createSessionSqliteMigrationRun(env, targets.map(createMigrationTargetInput))
      : undefined;
  const coverage =
    options.mode === "import" || options.mode === "dry-run" || options.mode === "validate"
      ? gatherLegacyArchiveCoverage(cfg, env, targets, knownTargets)
      : undefined;
  const reports: DoctorSessionSqliteTargetReport[] = [];
  const archiveTargets: LegacyArchiveTarget[] = [];
  for (const target of targets) {
    reports.push(
      await inspectOrMigrateTarget({
        configuredAgentIds,
        activeRun,
        archiveTargets,
        verifyMissingIndex,
        cfg,
        env,
        mode: options.mode,
        target,
        historicalArchives,
        recoveryInventory: historicalSources?.inventory,
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
  for (const report of reports) {
    report.issues.push(...settlementIssuesForStore(report.storePath));
  }
  if (activeRun && coverage) {
    for (const owner of archiveTargets) {
      if (
        owner.sourceConflicts?.size &&
        (!shouldFilterLegacySessionRecordsByTarget(owner.sourceTarget) ||
          (options.allAgents &&
            !options.agent &&
            !options.store &&
            (coverage.selectedStorePaths.has(owner.target.storePath) ||
              coverage.incompleteDirectories.has(path.dirname(owner.target.storePath))) &&
            coverage.knownTargets
              .filter(
                (known) => canonicalMigrationFilePath(known.storePath) === owner.target.storePath,
              )
              .every((known) =>
                archiveTargets.some(
                  (candidate) =>
                    candidate.target.agentId === known.agentId &&
                    candidate.target.storePath === owner.target.storePath &&
                    candidate.validated,
                ),
              ))) &&
        targets
          .filter(
            (target) => canonicalMigrationFilePath(target.storePath) === owner.target.storePath,
          )
          .every((target) =>
            archiveTargets.some(
              (candidate) => candidate.sourceTarget === target && candidate.validated,
            ),
          )
      ) {
        await archiveConflictingRetainedSessionSources(
          {
            cfg,
            env,
            target: owner.sourceTarget,
            activeRun,
            protectedPaths: coverage.retainedPaths,
            expectedIndexIdentity: coverage.indexIdentities.get(owner.target.storePath),
            targets: archiveTargets
              .filter((candidate) => candidate.target.storePath === owner.target.storePath)
              .map((candidate) => candidate.target),
          },
          owner.sourceConflicts,
          owner.report,
        );
      }
    }
    const deferredSourcePaths = new Set<string>();
    for (const target of reports.filter(isInformationalMissingSessionIndex)) {
      coverage.selectedStorePaths.delete(canonicalMigrationFilePath(target.storePath));
      coverage.retainedDirectories.add(path.dirname(canonicalMigrationFilePath(target.storePath)));
    }
    for (const owner of archiveTargets) {
      for (const source of owner.sourceConflicts?.keys() ?? []) {
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
    }
    // Findings belong to every inspected target, including historical-only targets with no moves.
    for (const report of reports) {
      updateMigrationManifestTarget(activeRun, createMigrationTargetInput(report), report.issues);
    }
    await archiveImportedLegacySessionStores(
      archiveTargets,
      activeRun,
      coverage,
      undefined,
      publishArchive,
    );
    for (const owner of archiveTargets) {
      if (owner.retainedImportVerified && owner.deferredPluginIds.length === 0) {
        try {
          retireDeferredPluginSessionImport({
            cfg,
            env,
            target: owner.sourceTarget,
            sqlitePath: owner.target.sqlitePath,
          });
        } catch (error) {
          owner.report.issues.push({
            code: "retained_plugin_source_conflict",
            message: `Deferred import receipt awaits retirement: ${formatErrorMessage(error)}. Run openclaw doctor --fix to retry.`,
          });
          updateMigrationManifestTarget(activeRun, owner.target, owner.report.issues);
        }
      }
    }
    const hasBlockingIssues = reports.some(
      (report) => countBlockingSessionSqliteIssues(report) > 0,
    );
    activeRun.manifest.completedAt = new Date().toISOString();
    if (hasBlockingIssues) {
      activeRun.manifest.failedAt = activeRun.manifest.completedAt;
      writeSessionSqliteMigrationManifest(activeRun);
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

/** Verified originals retained for unavailable plugins still await settlement. */
export function hasRetainedDoctorSessionSources(report: DoctorSessionSqliteReport): boolean {
  return retainedArchivePlans.has(report);
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
  const assertCurrent = (): undefined => {
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
      owners.filter((owner) => owner.report.issues.every(isSettleableIssue)),
      activeRun,
      coverage,
      assertCurrent,
      publishArchive,
    );
    verifyImports();
    const issue = owners
      .flatMap((owner) => owner.report.issues)
      .find((candidate) => !isSettleableIssue(candidate));
    if (issue || owners.some((owner) => fs.existsSync(owner.target.storePath))) {
      throw new Error(issue?.message ?? "Retained session sources could not be archived.");
    }
    for (const { owner } of plan.owners) {
      retireDeferredPluginSessionImport({
        cfg: plan.cfg,
        env: plan.env,
        target: owner.sourceTarget,
        sqlitePath: owner.target.sqlitePath,
        completedPluginIds,
        assertCurrent,
      });
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(formatErrorMessage(error));
    const failedOwners = owners.filter((owner) =>
      owner.report.issues.some((issue) => !isSettleableIssue(issue)),
    );
    for (const [index, owner] of owners.entries()) {
      owner.report.issues.push(
        ...plan.owners[index]!.owner.report.issues.filter(
          (issue) => issue.code === "plugin_migration_source_retained",
        ),
      );
      if (failedOwners.length === 0 || failedOwners.includes(owner)) {
        const ownIssue = owner.report.issues.find(
          (issue) => !isSettleableIssue(issue) && issue.code !== "plugin_migration_source_retained",
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
  const { targets } = resolveDoctorSessionSqliteTargets({ ...options, cfg, env });
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

async function inspectOrMigrateTarget(params: {
  configuredAgentIds: ReadonlySet<string>;
  verifyMissingIndex: ReturnType<typeof createMissingSessionIndexVerifier>;
  historicalArchives?: HistoricalArchiveSources;
  recoveryInventory?: ReturnType<typeof collectRecoveryInventory>;
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
  const report = createDoctorSessionSqliteTargetReport({
    ...params.target,
    sqlitePath: resolveTargetSqlitePath(params.target, params.env),
    sqliteEntries: readSqliteEntryCount(params.target),
    archivedLegacyStoreFiles: [],
    issues,
  });
  const updateManifest = (validationBeforeArchive?: "passed" | "failed") =>
    updateMigrationManifestTarget(
      params.activeRun,
      createMigrationTargetInput(params.target),
      report.issues,
      { validationBeforeArchive },
    );
  const retained = await prepareRetainedSessionImport(params, report);
  if (!retained) {
    return report;
  }
  const { retainedImport, staleImport, sourceConflicts, retainedIndexPath } = retained;
  if (params.mode === "recover" && !shouldFilterLegacySessionRecordsByTarget(params.target)) {
    await archiveConflictingRetainedSessionSources(params, sourceConflicts, report);
  }
  const allRecords =
    isSqliteStore || sourceConflicts.has(path.resolve(params.target.storePath))
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
    (issues.every(({ code }) => code === "retained_plugin_source_index_rebuilt") ||
      retainedImport ||
      staleImport)
  ) {
    await appendLegacyHistoricalTranscripts({
      ...params,
      allRecords,
      retainedImport,
      sourceConflicts,
      issues,
    });
  }
  let records = shouldFilterLegacySessionRecordsByTarget(params.target)
    ? allRecords.filter((record) =>
        isLegacySessionRecordOwnedByTarget(params.cfg, params.target, record.sessionKey),
      )
    : allRecords;
  if (staleImport) {
    const snapshot = readOnlySqliteValidationSnapshot(params.target);
    if (!snapshot.ok) {
      issues.push({ code: "sqlite_read_failed", message: String(snapshot.error) });
      return report;
    }
    records = records.filter((record) => {
      if (!snapshot.snapshot.archivedSessionIds.has(record.entry.sessionId)) {
        record.preserveCurrentSession = true;
        return true;
      }
      issues.push({
        code: "historical_transcript_deferred",
        sessionKey: record.sessionKey,
        message: `${record.transcriptPath}: live SQLite already archives this history. Retained source was not replayed; existing deletion and archive state remain authoritative.`,
      });
      return false;
    });
  }
  const referencedTranscriptFiles = new Set(
    allRecords.flatMap((record) => (record.transcriptPath ? [record.transcriptPath] : [])),
  );
  Object.assign(report, {
    legacyEntries: records.length,
    referencedTranscriptFiles: referencedTranscriptFiles.size,
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
  if (params.mode === "import" && retainedImport) {
    for (const source of report.unreferencedJsonlFiles) {
      if (!retainedSourcePaths?.has(canonicalMigrationFilePath(source)) && fs.existsSync(source)) {
        report.issues.push({
          code: "plugin_migration_source_retained",
          message: `${source}: skipped because the deferred-plugin-session-import receipt for ${params.target.storePath} still retains inputs for plugin(s): ${retainedImport.pluginIds.join(", ")}. Run openclaw doctor --fix to finish or retire the plugin migration, then rerun openclaw doctor --session-sqlite import. The new transcript remains in place.`,
        });
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
  if (
    records.length === 0 &&
    report.unreferencedJsonlFiles.length === 0 &&
    !fs.existsSync(params.target.storePath) &&
    !retainedImport
  ) {
    if (issues.length === 0) {
      report.sqliteEntries = 0;
    }
    updateManifest();
    return report;
  }
  if (!retainedImport && params.verifyMissingIndex(report)) {
    updateManifest("passed");
    return report;
  }
  if (retainedImport) {
    countRetainedSessionSources(retained, records, report);
  } else if (params.mode === "import") {
    await importLegacySessionRecords(params, records, report, params.activeRun);
  } else if (params.mode === "dry-run") {
    for (const record of records) {
      countLegacyTranscript(record, report);
    }
  } else {
    validateLegacySessionRecords(params.target, records, report, "validate", params.env);
  }
  let validationPassed = retainedImport !== undefined;
  if (params.mode === "import" && retainedImport) {
    // Exact source and database identities carry the earlier verified import into archival.
    updateManifest("passed");
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
      params.env,
    );
    updateManifest(validationPassed ? "passed" : "failed");
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
    const indexIdentity = params.expectedIndexIdentity;
    const indexless = !indexIdentity && !fs.existsSync(params.target.storePath);
    const deferredPluginIds =
      indexless && (!params.configuredAgentIds.has(params.target.agentId) || records.length === 0)
        ? []
        : (params.deferredPluginIds ?? []);
    // Zero-row validation may certify an existing canonical store, but must never
    // create a database solely for an unused shared-index owner.
    const verifiedImport =
      validationPassed &&
      (retainedImport !== undefined ||
        records.length > 0 ||
        fs.existsSync(resolveTargetSqlitePath(params.target, params.env)));
    let retainedImportVerified = retainedImport !== undefined;
    let verifiedSources = retainedImport?.sources;
    if (
      !retainedImport &&
      verifiedImport &&
      (indexIdentity ||
        records.some((record) => !record.historical?.archiveMove) ||
        report.unreferencedJsonlFiles.length > 0) &&
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
          report.sqliteEntries = readSqliteEntryCount(params.target);
          return report;
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
        if (indexless) {
          report.issues.push({
            code: "retained_plugin_source_index_rebuilt",
            message: `Derived the retained source index from verified transcripts for ${path.dirname(params.target.storePath)}. Recorded their identities in the completed import receipt without creating sessions.json or replaying existing metadata.`,
          });
        }
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
  updateManifest();
  return report;
}

async function archiveLegacyArtifacts(
  owners: readonly LegacyArchiveTarget[],
  coverage: ReturnType<typeof gatherLegacyArchiveCoverage>,
  activeRun: ActiveSessionSqliteMigrationRun,
  assertCurrent?: () => undefined,
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
            !owner.report.issues.some(
              (issue) =>
                issue.code === "transcript_malformed" && issue.sessionKey === record.sessionKey,
            ),
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
          ...(complete &&
          move.kind === "transcript" &&
          first.record.recovery?.sqliteEvents !== undefined
            ? {
                verification: `superseded by SQLite (${first.record.recovery.events} of ${first.record.recovery.sqliteEvents} events present)`,
              }
            : {}),
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
    const planUnreferencedMove = (source: string, kind: SessionSqliteMigrationMoveKind) => {
      try {
        const move = planSessionJsonlArchiveMove({
          archiveKey: "archive-tier",
          kind,
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
        return true;
      } catch (error) {
        recordFailure(owner, source, error, true);
        return false;
      }
    };
    const pointers = new Set<string>();
    const receiptSources = new Set(
      owner.retainedImportVerified
        ? (owner.verifiedSources ?? []).map((source) => source.path)
        : [],
    );
    for (const source of listUnreferencedJsonlFiles(storePath, [
      ...referencedPaths,
      ...planned.keys(),
    ])) {
      if (retainedPaths.has(source)) {
        continue;
      }
      if (
        (capturedSources && !capturedSources.has(source)) ||
        (owner.retainedImportVerified && !receiptSources.has(source))
      ) {
        continue;
      }
      const pointer = resolveTrajectoryPointerPath(source);
      if (planUnreferencedMove(source, "unreferenced-jsonl") && pointer) {
        pointers.add(pointer);
      }
    }
    // A pointer sidecar only locates its transcript's trajectory, so it settles with that
    // transcript, including a receipt-verified one an earlier run archived without it.
    for (const transcript of receiptSources) {
      const pointer = resolveTrajectoryPointerPath(transcript);
      if (
        pointer &&
        receiptSources.has(pointer) &&
        !owner.sourceConflicts?.has(transcript) &&
        !fs.existsSync(transcript)
      ) {
        pointers.add(pointer);
      }
    }
    for (const pointer of pointers) {
      const source = canonicalMigrationFilePath(pointer);
      if (
        fs.existsSync(source) &&
        !planned.has(source) &&
        !referencedPaths.has(source) &&
        !retainedPaths.has(source) &&
        !owner.sourceConflicts?.has(pointer) &&
        (!capturedSources || capturedSources.has(source))
      ) {
        planUnreferencedMove(source, "trajectory");
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
        assertCurrent,
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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
