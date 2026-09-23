import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode, isMissingPathError } from "../infra/errors.js";
import { removePathWithinRoot } from "../infra/fs-safe-remove.js";
import { pathExists, root, type Root } from "../infra/fs-safe.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { isUpdateRehearsalReadOnlyPath } from "../infra/update-rehearsal-paths.js";
import { parseSkillProposalRow } from "../skills/workshop/store-sqlite-record.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  readSkillProposal,
  readSkillProposalRollback,
  validateSkillProposalRecord,
  validateSkillProposalRollback,
} from "../skills/workshop/store.js";
import type { SkillProposalRecord, SkillProposalRollback } from "../skills/workshop/types.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { listWorkspaceOwnerAgentIds } from "./doctor-skill-workshop-collection-backups.js";
import {
  inferOwnerAgentId,
  isReadOnlyRehearsalProposal,
  resolveLegacyWorkshopWorkspaceDir,
} from "./doctor-skill-workshop-relocation.js";
import {
  LEGACY_WORKSHOP_PROPOSALS_DIR as PROPOSALS_DIR,
  LEGACY_WORKSHOP_MAX_RECORD_BYTES as MAX_RECORD_BYTES,
  LEGACY_WORKSHOP_PROPOSAL_ID_PATTERN as PROPOSAL_ID_PATTERN,
  readLegacyWorkshopJson as readJson,
} from "./doctor-skill-workshop-sources.js";

const WORKSHOP_DIR = "skill-workshop";
const MANIFEST_PATH = `${WORKSHOP_DIR}/proposals.json`;
// Preserve incomplete proposal artifacts outside active discovery so Doctor
// does not retry an impossible import on every run.
const RECOVERY_DIR = `${WORKSHOP_DIR}/recovery`;
const RECOVERY_PROPOSALS_DIR = `${RECOVERY_DIR}/proposals`;
// Legacy rollback JSON can expand control characters sixfold across 1 MiB of
// SKILL.md plus 64 existing 256 KiB support targets.
const MAX_ROLLBACK_BYTES = 128 * 1024 * 1024;

export type MigrationResult = MigrationMessages & {
  detected: number;
  migrated: number;
};

async function readLegacyRollback(
  stateRoot: Root,
  proposalId: string,
): Promise<SkillProposalRollback | undefined> {
  try {
    const rollback = validateSkillProposalRollback(
      await readJson(stateRoot, `${PROPOSALS_DIR}/${proposalId}/rollback.json`, MAX_ROLLBACK_BYTES),
    );
    if (!rollback.ok) {
      throw new Error(rollback.error.message);
    }
    if (rollback.value.proposalId !== proposalId) {
      throw new Error("invalid rollback metadata");
    }
    return rollback.value;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function verifyImportedProposal(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  record: SkillProposalRecord,
  rollback?: SkillProposalRollback,
): Promise<void> {
  const imported = (
    await readSkillProposal(record.id, { config, env }, {}, { config, reconcile: false })
  )?.record;
  if (
    !imported ||
    imported.draftHash !== record.draftHash ||
    imported.target.skillFile !== record.target.skillFile
  ) {
    throw new Error("SQLite verification failed");
  }
  if (rollback && !(await readSkillProposalRollback(record.id, { env }))) {
    throw new Error("SQLite rollback verification failed");
  }
}

type PreparedLegacyProposal = {
  record: SkillProposalRecord;
  ownerAgentId: string;
};

async function readLegacyProposalArtifacts(
  stateRoot: Root,
  record: SkillProposalRecord,
  env: NodeJS.ProcessEnv,
): Promise<SkillProposalRollback | null | undefined> {
  const rollback = await readLegacyRollback(stateRoot, record.id);
  if (rollback && isUpdateRehearsalReadOnlyPath(rollback.targetSkillFile, env)) {
    return null;
  }
  const draft = await stateRoot
    .read(`${PROPOSALS_DIR}/${record.id}/PROPOSAL.md`, {
      hardlinks: "reject",
      maxBytes: MAX_RECORD_BYTES,
      symlinks: "reject",
    })
    .catch((error: unknown) => {
      // Missing drafts must not quarantine a bundle that still owns apply recovery.
      if (rollback && isMissingPathError(error)) {
        throw new Error(
          "Legacy bundle has a missing draft and unfinished apply recovery; restore its draft before retrying Doctor.",
        );
      }
      throw error;
    });
  if (hashSkillProposalContent(draft.buffer.toString("utf8")) !== record.draftHash) {
    throw new Error("proposal draft hash does not match proposal metadata");
  }
  return rollback;
}

async function prepareLegacyProposal(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  proposalId: string;
  stateRoot: Root;
}): Promise<PreparedLegacyProposal | { warning: string } | null> {
  const proposalDir = `${PROPOSALS_DIR}/${params.proposalId}`;
  const record = validateSkillProposalRecord(
    await readJson(params.stateRoot, `${proposalDir}/proposal.json`, MAX_RECORD_BYTES),
  );
  if (!record.ok) {
    throw new Error(record.error.message);
  }
  if (record.value.id !== params.proposalId) {
    throw new Error("invalid proposal metadata");
  }
  if (isReadOnlyRehearsalProposal(record.value, params.env)) {
    return null;
  }
  const rollback = await readLegacyProposalArtifacts(params.stateRoot, record.value, params.env);
  if (rollback === null) {
    return null;
  }
  const workspaceDir = resolveLegacyWorkshopWorkspaceDir(
    record.value.target.skillDir,
    params.config,
    params.env,
  );
  const owner = inferOwnerAgentId({
    config: params.config,
    env: params.env,
    record: record.value,
    workspaceDir,
  });
  if (!owner.ownerAgentId) {
    if (rollback) {
      throw new Error(
        `Legacy bundle has unfinished apply recovery at ${path.join(resolveStateDir(params.env), proposalDir, "rollback.json")}; resolve its owning agent and recover the retained apply before retrying Doctor.`,
      );
    }
    const candidates = workspaceDir
      ? listWorkspaceOwnerAgentIds(params.config, params.env, workspaceDir).toSorted()
      : [];
    const reason = owner.unconfiguredOwnerAgentId
      ? `owning agent "${owner.unconfiguredOwnerAgentId}" is not configured`
      : "owning agent could not be inferred";
    return {
      warning: `Preserved Skill Workshop proposal ${path.join(resolveStateDir(params.env), proposalDir)} for manual review: ${reason}; target ${record.value.target.skillDir} (candidate agents: ${candidates.join(", ") || "none"}). Review the retained metadata and configured workspace ownership before retrying Doctor.`,
    };
  }
  return { record: record.value, ownerAgentId: owner.ownerAgentId };
}

async function migrateProposal(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateRoot: Root;
  prepared: PreparedLegacyProposal;
}): Promise<boolean> {
  const { record, ownerAgentId } = params.prepared;
  if (isReadOnlyRehearsalProposal(record, params.env)) {
    return false;
  }
  const proposalDir = `${PROPOSALS_DIR}/${record.id}`;
  const rollback = await readLegacyProposalArtifacts(params.stateRoot, record, params.env);
  if (rollback === null) {
    return false;
  }
  importLegacySkillProposal({
    record,
    rollback,
    ownerAgentId,
    store: { env: params.env },
  });
  await verifyImportedProposal(params.config, params.env, record, rollback);
  if (rollback) {
    await params.stateRoot.remove(`${proposalDir}/rollback.json`);
  }
  await params.stateRoot.remove(`${proposalDir}/proposal.json`);
  return true;
}

async function reconcileIncompleteProposal(params: {
  proposalId: string;
  proposalDir: string;
  stateRoot: Root;
}): Promise<string> {
  const entries = await params.stateRoot.list(params.proposalDir, { withFileTypes: true });
  if (entries.length === 0) {
    await params.stateRoot.remove(params.proposalDir);
    return `Removed empty legacy Skill Workshop proposal directory ${params.proposalId}.`;
  }
  await params.stateRoot.mkdir(RECOVERY_PROPOSALS_DIR);
  // A unique target preserves earlier recovery artifacts without an unsafe
  // check-then-replace window. The fs-safe move pins both directory parents.
  const recoveryPath = `${RECOVERY_PROPOSALS_DIR}/${params.proposalId}-${randomUUID()}`;
  await params.stateRoot.move(params.proposalDir, recoveryPath, { overwrite: true });
  return `Quarantined incomplete Skill Workshop proposal ${params.proposalId} to ${recoveryPath} for manual recovery.`;
}

/** Import verified legacy proposal sidecars, then remove only the imported JSON metadata. */
export async function importLegacySkillProposalSidecars(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationResult> {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  if (!(await pathExists(path.join(stateDir, PROPOSALS_DIR)))) {
    if (!(await pathExists(path.join(stateDir, MANIFEST_PATH)))) {
      return {
        changes: [],
        warnings: [],
        detected: 0,
        migrated: 0,
      };
    }
    await removePathWithinRoot({ rootDir: stateDir, relativePath: MANIFEST_PATH });
    return {
      changes: ["Removed the empty legacy Skill Workshop proposal index."],
      warnings: [],
      detected: 0,
      migrated: 0,
    };
  }
  const stateRoot = await root(stateDir);
  let entries;
  try {
    entries = await stateRoot.list(PROPOSALS_DIR, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "not-found")) {
      return { changes: [], warnings: [], detected: 0, migrated: 0 };
    }
    return {
      changes: [],
      warnings: [`Failed to inspect legacy Skill Workshop proposals: ${String(error)}`],
      detected: 0,
      migrated: 0,
    };
  }

  const proposalIds = entries
    .filter((entry) => entry.isDirectory && PROPOSAL_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
  const warnings: string[] = [];
  const changes: string[] = [];
  let recoverableWarningCount = 0;
  const prepared = new Map<
    string,
    PreparedLegacyProposal | { warning: string } | { error: unknown } | null
  >();
  // Resolve every sidecar's ownership before the first import or artifact retirement.
  for (const proposalId of proposalIds) {
    try {
      prepared.set(
        proposalId,
        await prepareLegacyProposal({ config: params.config, env, proposalId, stateRoot }),
      );
    } catch (error) {
      prepared.set(proposalId, { error });
    }
  }
  const database = openOpenClawStateDatabase({ env });
  const kysely = getNodeSqliteKysely<Pick<OpenClawStateDatabase, "skill_workshop_proposals">>(
    database.db,
  );
  let migrated = 0;
  let retainedForRehearsal = false;
  for (const proposalId of proposalIds) {
    const proposalDir = `${PROPOSALS_DIR}/${proposalId}`;
    const proposal = prepared.get(proposalId)!;
    if (proposal === null) {
      retainedForRehearsal = true;
      continue;
    }
    if ("warning" in proposal) {
      warnings.push(proposal.warning);
      recoverableWarningCount += 1;
      continue;
    }
    try {
      if ("error" in proposal) {
        throw proposal.error;
      }
      const imported = await migrateProposal({
        config: params.config,
        env,
        prepared: proposal,
        stateRoot,
      });
      if (imported) {
        migrated += 1;
      } else {
        retainedForRehearsal = true;
      }
      continue;
    } catch (error) {
      if (!isMissingPathError(error)) {
        warnings.push(`Failed to migrate Skill Workshop proposal ${proposalId}: ${String(error)}`);
        continue;
      }
      // Modern bundles have no legacy sidecar. Recognize their durable record
      // without entering the feature's schema-writing read facade.
      const stored = tableExists(database.db, "skill_workshop_proposals")
        ? executeSqliteQueryTakeFirstSync(
            database.db,
            kysely
              .selectFrom("skill_workshop_proposals")
              .selectAll()
              .where("proposal_id", "=", proposalId)
              .where("owner_agent_id", "is not", null),
          )
        : undefined;
      if (stored && parseSkillProposalRow(stored)) {
        continue;
      }
      try {
        changes.push(await reconcileIncompleteProposal({ proposalId, proposalDir, stateRoot }));
      } catch (reconcileError) {
        warnings.push(
          `Could not quarantine incomplete Skill Workshop proposal ${proposalId}: ${String(
            reconcileError,
          )}. Manually move ${proposalDir} to ${RECOVERY_PROPOSALS_DIR} to recover it.`,
        );
      }
    }
  }
  if (!retainedForRehearsal) {
    await removePathWithinRoot({ rootDir: stateDir, relativePath: MANIFEST_PATH }).catch(
      (error: unknown) => {
        if (!isMissingPathError(error)) {
          warnings.push(`Failed to remove legacy Skill Workshop proposal index: ${String(error)}`);
        }
      },
    );
  }
  if (migrated > 0) {
    changes.unshift(
      `Migrated ${migrated} Skill Workshop proposal${migrated === 1 ? "" : "s"} into shared SQLite.`,
    );
  }
  return {
    changes,
    warnings,
    ...(warnings.length > 0 && warnings.length === recoverableWarningCount
      ? { warningDisposition: "recoverable" as const }
      : {}),
    detected: proposalIds.length,
    migrated,
  };
}
