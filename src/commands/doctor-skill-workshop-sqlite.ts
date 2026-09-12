import fs from "node:fs/promises";
import path from "node:path";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { assertWorkspaceStateMigrationReady } from "../agents/workspace-legacy-state.js";
import {
  resolveCanonicalWorkspacePath,
  resolveWorkspaceStateIdentity,
} from "../agents/workspace-state-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pathExists } from "../infra/fs-safe.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isPathInside } from "../infra/path-guards.js";
import { movePathWithCopyFallback } from "../infra/replace-file.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import {
  isUpdateRehearsalReadOnlyPath,
  resolveUpdateRehearsalRoot,
} from "../infra/update-rehearsal-paths.js";
import { transitionPendingSkillProposalToStale } from "../skills/workshop/apply-transition.js";
import { reconcileInterruptedSkillProposalApply } from "../skills/workshop/reconcile-transition.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  parseSkillProposalRow,
  readStoredProposal,
  updateProposal,
} from "../skills/workshop/store-sqlite-record.js";
import {
  SkillProposalDraftMissingError,
  readSkillProposalBundle,
  readSkillProposalRollback,
  resolveSkillProposalTarget,
} from "../skills/workshop/store.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  inspectWorkshopAutomationReferences,
  type WorkshopAutomationReference,
} from "./doctor-skill-workshop-automations.js";
import {
  listPendingLegacyCollectionBackupRoots,
  migrateLegacyCollectionBackups,
  type LegacyCollectionBackupRoot,
} from "./doctor-skill-workshop-collection-backups.js";
import {
  classifyWorkshopRelocation,
  inferOwnerAgentId,
  isReadOnlyRehearsalProposal,
  planWorkshopRelocation,
  readLegacyWorkshopSourceStat,
  resolveLegacyWorkshopWorkspaceDir,
  type WorkshopProposalUpdate,
} from "./doctor-skill-workshop-relocation.js";
import {
  importLegacySkillProposalSidecars,
  type MigrationResult,
} from "./doctor-skill-workshop-sidecars.js";
import { readWorkshopMigrationRecords } from "./doctor-skill-workshop-sources.js";
import {
  finishWorkshopWorkspaceRelocations,
  prepareWorkshopWorkspaceRelocation,
} from "./doctor-skill-workshop-workspaces.js";

type WorkshopRelocationResult = {
  movedSkills: number;
  retargetedProposals: number;
  staleProposals: number;
  migratedBackupRoots: number;
  warnings: string[];
  recoverableWarningCount: number;
};

export type LegacyWorkshopMigrationInspection = {
  externalProposalCount: number;
  externalProposalCountsByAgent: Record<string, number>;
  externalProposalDetails?: string[];
  legacyBackupRootCount: number;
  preservedLegacyBackupRootCount: number;
  automationReferences?: WorkshopAutomationReference[];
};

export async function inspectLegacySkillWorkshopMigration(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  // Lint's private database snapshot does not change persisted filesystem targets.
  stateEnv?: NodeJS.ProcessEnv;
}): Promise<LegacyWorkshopMigrationInspection> {
  const env = params.env ?? process.env;
  const stateEnv = params.stateEnv ?? env;
  const { records, appliedEvents } = await readWorkshopMigrationRecords(stateEnv, true);
  // Lint needs ownership counts, not adoption verification through writable recovery readers.
  const { external } = classifyWorkshopRelocation(
    records.filter(({ record }) => !isReadOnlyRehearsalProposal(record, env)),
    params.config,
    env,
  );
  const backups = await listPendingLegacyCollectionBackupRoots(params.config, env);
  const automationReferences = await inspectWorkshopAutomationReferences({
    config: params.config,
    env,
    stateEnv,
    records,
    appliedEvents,
  });
  return {
    externalProposalCount: external.length,
    externalProposalCountsByAgent: external.reduce<Record<string, number>>((counts, plan) => {
      const ownerAgentId = plan.ownerAgentId ?? plan.unconfiguredOwnerAgentId ?? "unknown";
      counts[ownerAgentId] = (counts[ownerAgentId] ?? 0) + 1;
      return counts;
    }, {}),
    ...(external.length > 0
      ? {
          externalProposalDetails: external
            .toSorted((left, right) => left.record.id.localeCompare(right.record.id))
            .slice(0, 20)
            .map(({ record, ownerAgentId, unconfiguredOwnerAgentId }) =>
              truncateWithMarker(
                `${record.id}: ${record.target.skillDir} (owner: ${ownerAgentId ?? unconfiguredOwnerAgentId ?? "unknown"})`,
                2000,
                { marker: "…", reserve: 1, trimEnd: true },
              ),
            ),
        }
      : {}),
    legacyBackupRootCount: backups.length,
    preservedLegacyBackupRootCount: backups.filter((backup) => "warning" in backup).length,
    ...(automationReferences.length > 0 ? { automationReferences } : {}),
  };
}

async function relocateLegacyWorkshopTargets(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  retireMissingDrafts: boolean,
  backupRoots: readonly LegacyCollectionBackupRoot[],
  unavailableWorkspaceDirs: ReadonlyMap<string, string> = new Map(),
): Promise<WorkshopRelocationResult> {
  const database = openOpenClawStateDatabase({ env });
  const kysely = getNodeSqliteKysely<
    Pick<OpenClawStateDatabase, "skill_workshop_proposals" | "skill_workshop_proposal_rollbacks">
  >(database.db);
  // Planning must not initialize optional Workshop tables or indexes on a no-op
  // startup. Actual proposal writes retain their feature-owned schema ensure.
  const readRows = () =>
    tableExists(database.db, "skill_workshop_proposals")
      ? executeSqliteQuerySync(
          database.db,
          kysely.selectFrom("skill_workshop_proposals").selectAll(),
        ).rows
      : [];
  const deferredSources = new Set<string>();
  const recoverableDeferredSources = new Set<string>();
  const hasRollback = (proposalId: string) =>
    tableExists(database.db, "skill_workshop_proposal_rollbacks") &&
    executeSqliteQueryTakeFirstSync(
      database.db,
      kysely
        .selectFrom("skill_workshop_proposal_rollbacks")
        .select("proposal_id")
        .where("proposal_id", "=", proposalId),
    ) !== undefined;
  const recoveryWarnings: string[] = [];
  const readOnlyProposalIds = new Set(
    resolveUpdateRehearsalRoot(env) && tableExists(database.db, "skill_workshop_proposal_rollbacks")
      ? executeSqliteQuerySync(
          database.db,
          kysely
            .selectFrom("skill_workshop_proposal_rollbacks")
            .select(["proposal_id", "target_skill_file"]),
        )
          .rows.filter((row) => isUpdateRehearsalReadOnlyPath(row.target_skill_file, env))
          .map((row) => row.proposal_id)
      : [],
  );
  let missingDraftsRetired = 0;
  let recoverableWarningCount = 0;
  // Settle writes while their proposal and rollback still name the same files.
  // Recovery can establish a create's ownership or restore a partial update.
  for (const row of readRows()) {
    const record = parseSkillProposalRow(row);
    if (!record || record.status !== "pending") {
      continue;
    }
    if (readOnlyProposalIds.has(record.id) || isReadOnlyRehearsalProposal(record, env)) {
      const source = resolveCanonicalWorkspacePath(record.target.skillDir);
      deferredSources.add(source);
      recoverableDeferredSources.add(source);
      continue;
    }
    const workspaceDir = resolveLegacyWorkshopWorkspaceDir(record.target.skillDir, config, env);
    const unavailableReason =
      workspaceDir &&
      unavailableWorkspaceDirs.get(resolveWorkspaceStateIdentity(workspaceDir).workspacePath);
    if (unavailableReason && hasRollback(record.id)) {
      const source = resolveCanonicalWorkspacePath(record.target.skillDir);
      deferredSources.add(source);
      recoverableDeferredSources.add(source);
      recoveryWarnings.push(
        `Preserved Skill Workshop proposal ${record.id} and its unfinished apply recovery for manual review: ${unavailableReason}`,
      );
      recoverableWarningCount += 1;
      continue;
    }
    if (retireMissingDrafts) {
      try {
        await readSkillProposalBundle(record, { config, env });
      } catch (error) {
        if (!(error instanceof SkillProposalDraftMissingError)) {
          recoveryWarnings.push(
            `Could not inspect Skill Workshop proposal ${record.id}: ${String(error)}`,
          );
          deferredSources.add(resolveCanonicalWorkspacePath(record.target.skillDir));
          continue;
        }
        // Any rollback row can describe an interrupted write. Keep it pending
        // for recovery rather than treating its missing draft as abandoned work.
        if (hasRollback(record.id)) {
          recoveryWarnings.push(
            `Skill Workshop proposal ${record.id} has a missing draft and unfinished apply recovery; restore its draft before retrying Doctor.`,
          );
          deferredSources.add(resolveCanonicalWorkspacePath(record.target.skillDir));
          continue;
        }
        transitionPendingSkillProposalToStale({
          record,
          reason:
            "Proposal draft is missing. Metadata and remaining files were preserved for recovery.",
          input: { config, env, eventActor: { type: "system" } },
        });
        missingDraftsRetired += 1;
        continue;
      }
    }
    const { ownerAgentId } = inferOwnerAgentId({
      record,
      config,
      env,
      workspaceDir,
      rowOwnerAgentId: row.owner_agent_id,
    });
    if (
      !workspaceDir ||
      !ownerAgentId ||
      isPathInside(resolveWorkshopSkillsDir(config, ownerAgentId, env), record.target.skillDir) ||
      !(await readSkillProposalRollback(record.id, { env }))
    ) {
      continue;
    }
    try {
      assertWorkspaceStateMigrationReady({
        workspaceDirs: [workspaceDir],
        env,
        operation: "doctor",
      });
      const sourceStat = await readLegacyWorkshopSourceStat(workspaceDir, record.target.skillDir);
      if (sourceStat?.isSymbolicLink()) {
        continue;
      }
      const skillsRoot = [
        path.join(workspaceDir, "skills"),
        path.join(workspaceDir, ".agents", "skills"),
      ].find((rootDir) => isPathInside(rootDir, record.target.skillDir));
      if (!skillsRoot) {
        throw new Error("the original skill root could not be verified");
      }
      const target = resolveSkillProposalTarget({
        skillName: record.target.skillKey,
        config,
        agentId: ownerAgentId,
        env,
      });
      if (!sourceStat && (await pathExists(target.skillDir))) {
        throw new Error("the original skill is missing and its destination already exists");
      }
      const store = { config, env, agentId: ownerAgentId };
      const proposal = await readSkillProposalBundle(record, store);
      const recovered = await reconcileInterruptedSkillProposalApply({
        record,
        expectedRecordJson: row.record_json,
        draftContent: proposal.content,
        skillsRoot,
        store,
      });
      if (!recovered) {
        throw new Error("the interrupted apply could not be verified or restored");
      }
    } catch (error) {
      // Moving the create claim alone would strand its pending update's recovery.
      deferredSources.add(resolveCanonicalWorkspacePath(record.target.skillDir));
      recoveryWarnings.push(
        `Skill Workshop did not relocate ${record.target.skillDir}: ${String(error)}. ` +
          `Recovery for proposal ${record.id} remains pending; check its files and saved proposal before retrying Doctor.`,
      );
    }
  }
  const rows = readRows();
  const initialRows = new Map(rows.map((row) => [row.proposal_id, row]));
  const records = rows.flatMap((row) => {
    const record = parseSkillProposalRow(row);
    return record && !readOnlyProposalIds.has(record.id)
      ? [{ record, ownerAgentId: row.owner_agent_id }]
      : [];
  });
  const persistedUpdates: WorkshopProposalUpdate[] = [];
  const persistUpdates = (updates: WorkshopProposalUpdate[]): void => {
    if (
      updates.length === 0 ||
      updates.some(({ record }) => isReadOnlyRehearsalProposal(record, env))
    ) {
      return;
    }
    // Every proposal for one moved skill must commit together. Otherwise a
    // retry loses the create row that proves where its pending updates belong.
    const committed = runOpenClawStateWriteTransaction(
      ({ db }) => {
        const currentUpdates = updates.map((update) => {
          const expected = initialRows.get(update.record.id);
          const current = readStoredProposal(update.record.id, { env });
          if (
            !current ||
            current.row.record_json !== expected?.record_json ||
            current.row.owner_agent_id !== expected?.owner_agent_id
          ) {
            throw new Error(`Skill proposal changed during relocation: ${update.record.id}`);
          }
          return { update, current };
        });
        if (
          currentUpdates.some(({ current }) => isReadOnlyRehearsalProposal(current.record, env))
        ) {
          return false;
        }
        for (const { update, current } of currentUpdates) {
          updateProposal(db, current.row, update.record, update.ownerAgentId);
        }
        return true;
      },
      { env },
      { operationLabel: "skill-workshop.relocation.commit" },
    );
    if (committed) {
      persistedUpdates.push(...updates);
    }
  };
  const plan = await planWorkshopRelocation(
    records,
    config,
    env,
    deferredSources,
    unavailableWorkspaceDirs,
    recoverableDeferredSources,
  );
  const workspaceMoves = new Map<string, typeof plan.moves>();
  for (const move of plan.moves) {
    // Adopted sources are already absent. Only pending filesystem moves can
    // prove that this attempt will empty a newly attested workspace.
    if (move.operation === "adopt") {
      continue;
    }
    const moves = workspaceMoves.get(move.workspaceDir) ?? [];
    moves.push(move);
    workspaceMoves.set(move.workspaceDir, moves);
  }
  for (const [workspaceDir, moves] of workspaceMoves) {
    await prepareWorkshopWorkspaceRelocation(workspaceDir, moves, env);
  }
  let movedSkills = 0;
  for (const move of plan.moves) {
    if (
      [move.source, move.destination].some((filePath) =>
        isUpdateRehearsalReadOnlyPath(filePath, env),
      ) ||
      move.updates.some(({ record }) => isReadOnlyRehearsalProposal(record, env))
    ) {
      continue;
    }
    if (move.operation === "move") {
      await fs.mkdir(path.dirname(move.destination), { recursive: true });
      await movePathWithCopyFallback({ from: move.source, to: move.destination });
      movedSkills += 1;
    } else if (move.operation === "remove-source") {
      await fs.rm(move.source, { recursive: true, force: false });
    }
    persistUpdates(move.updates);
  }
  persistUpdates(plan.updates);
  await finishWorkshopWorkspaceRelocations(env);
  const backupMigration = await migrateLegacyCollectionBackups(config, env, backupRoots);
  const staleProposals = persistedUpdates.filter(
    (update) => update.record.status === "stale",
  ).length;
  return {
    movedSkills,
    retargetedProposals: persistedUpdates.length - staleProposals,
    staleProposals: staleProposals + missingDraftsRetired,
    migratedBackupRoots: backupMigration.migrated,
    warnings: [...recoveryWarnings, ...plan.warnings, ...backupMigration.warnings],
    recoverableWarningCount:
      recoverableWarningCount +
      plan.recoverableWarningCount +
      backupMigration.recoverableWarningCount,
  };
}

export async function migrateLegacySkillWorkshopProposals(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  retireMissingDrafts?: boolean;
  unavailableWorkspaceDirs?: ReadonlyMap<string, string>;
}): Promise<MigrationResult> {
  const env = params.env ?? process.env;
  // Plain Doctor can reach automatic migration without its repair scope.
  // Keep one owner through filesystem moves, receipt completion, and backup retirement.
  const coordinator = acquireStateDatabaseCoordinator({
    databasePath: resolveOpenClawStateSqlitePath(env),
  });
  try {
    const backupRoots = await listPendingLegacyCollectionBackupRoots(params.config, env);
    const sidecars = await importLegacySkillProposalSidecars({ config: params.config, env });
    const relocation = await relocateLegacyWorkshopTargets(
      params.config,
      env,
      params.retireMissingDrafts === true,
      backupRoots,
      params.unavailableWorkspaceDirs,
    );
    if (
      relocation.movedSkills > 0 ||
      relocation.retargetedProposals > 0 ||
      relocation.staleProposals > 0 ||
      relocation.migratedBackupRoots > 0
    ) {
      sidecars.changes.push(
        `Relocated ${relocation.movedSkills} Skill Workshop skill${relocation.movedSkills === 1 ? "" : "s"}, retargeted ${relocation.retargetedProposals} proposal${relocation.retargetedProposals === 1 ? "" : "s"}, marked ${relocation.staleProposals} stale, and migrated ${relocation.migratedBackupRoots} legacy collection backup root${relocation.migratedBackupRoots === 1 ? "" : "s"}.`,
      );
    }
    const warnings = [...sidecars.warnings, ...relocation.warnings];
    const recoverableWarningCount =
      (sidecars.warningDisposition === "recoverable" ? sidecars.warnings.length : 0) +
      relocation.recoverableWarningCount;
    return {
      changes: sidecars.changes,
      detected: sidecars.detected,
      migrated: sidecars.migrated,
      warnings,
      ...(warnings.length > 0 && warnings.length === recoverableWarningCount
        ? { warningDisposition: "recoverable" as const }
        : {}),
    };
  } finally {
    coordinator.release();
  }
}
