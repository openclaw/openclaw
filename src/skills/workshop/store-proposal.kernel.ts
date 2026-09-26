import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { assertProposalId } from "./store-record.js";
import { appendSkillProposalEvent, type NewSkillProposalEvent } from "./store-sqlite-event.js";
import {
  insertProposal,
  parseSkillProposalRow,
  updateProposal,
  type StoredSkillProposal,
} from "./store-sqlite-record.js";
import type { SkillWorkshopDatabase } from "./store-sqlite-schema.js";
import type { SkillProposalEvent, SkillProposalRecord, SkillProposalRollback } from "./types.js";

export type CreateSkillProposalInput = {
  record: SkillProposalRecord;
  ownerAgentId: string;
  maxPending: number;
  event: NewSkillProposalEvent;
};

export type UpdateSkillProposalRecordInput = {
  record: SkillProposalRecord;
  ownerAgentId?: string;
  invalidateRollback?: boolean;
  event?: NewSkillProposalEvent;
};

export type ImportLegacySkillProposalInput = {
  record: SkillProposalRecord;
  rollback?: SkillProposalRollback;
  ownerAgentId: string;
};

export type ListStoredSkillProposalsInput = {
  agentId?: string;
  kind?: SkillProposalRecord["kind"];
};

export function createSkillProposalInDatabase(
  db: DatabaseSync,
  params: CreateSkillProposalInput,
): SkillProposalEvent {
  assertProposalId(params.record.id);
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .select("proposal_id")
      .where("proposal_id", "=", params.record.id),
  );
  if (existing) {
    throw new Error(`Skill proposal already exists: ${params.record.id}`);
  }
  const count = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("owner_agent_id", "=", params.ownerAgentId)
      .where("status", "in", ["pending", "quarantined"]),
  );
  if ((count?.count ?? 0) >= params.maxPending) {
    throw new Error(`Skill Workshop pending proposal limit reached (${params.maxPending}).`);
  }
  insertProposal(db, {
    record: params.record,
    ownerAgentId: params.ownerAgentId,
  });
  return appendSkillProposalEvent(db, params.event);
}

export function updateSkillProposalRecordInDatabase(
  db: DatabaseSync,
  params: UpdateSkillProposalRecordInput,
): SkillProposalEvent | undefined {
  assertProposalId(params.record.id);
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .selectAll()
      .where("proposal_id", "=", params.record.id),
  );
  if (!current || !parseSkillProposalRow(current)) {
    throw new Error(`Skill proposal not found: ${params.record.id}`);
  }
  // Recovery only visits pending proposals. A dismissal must not strand
  // a partial install, including when its rollback metadata is damaged.
  if (
    current.status === "pending" &&
    (params.record.status === "rejected" || params.record.status === "quarantined") &&
    executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("skill_workshop_proposal_rollbacks")
        .select("proposal_id")
        .where("proposal_id", "=", params.record.id),
    )
  ) {
    throw new Error(
      "Skill proposal has unfinished apply recovery. Run openclaw doctor --fix and restore the files it identifies before retrying.",
    );
  }
  if (params.invalidateRollback) {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("skill_workshop_proposal_rollbacks")
        .where("proposal_id", "=", params.record.id),
    );
  }
  updateProposal(db, current, params.record, params.ownerAgentId);
  return params.event ? appendSkillProposalEvent(db, params.event) : undefined;
}

export function listStoredSkillProposalsInDatabase(
  database: DatabaseSync,
  scope: ListStoredSkillProposalsInput,
): StoredSkillProposal[] {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  let query = kysely.selectFrom("skill_workshop_proposals").selectAll();
  if (scope.kind) {
    query = query.where("kind", "=", scope.kind);
  }
  if (scope.agentId) {
    query = query.where("owner_agent_id", "=", scope.agentId);
  } else {
    query = query.where("owner_agent_id", "is not", null);
  }
  return executeSqliteQuerySync(
    database,
    query.orderBy("updated_at", "desc").orderBy("proposal_id", "asc"),
  ).rows.flatMap((row) => {
    const record = parseSkillProposalRow(row);
    return record ? [{ record, row }] : [];
  });
}

export function importLegacySkillProposalInDatabase(
  db: DatabaseSync,
  params: ImportLegacySkillProposalInput,
): "imported" | "already-imported" {
  assertProposalId(params.record.id);
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .selectAll()
      .where("proposal_id", "=", params.record.id),
  );
  if (current) {
    const existing = parseSkillProposalRow(current);
    if (
      !existing ||
      existing.draftHash !== params.record.draftHash ||
      existing.target.skillFile !== params.record.target.skillFile
    ) {
      throw new Error(`Legacy skill proposal conflicts with SQLite: ${params.record.id}`);
    }
  } else {
    insertProposal(db, {
      record: params.record,
      ownerAgentId: params.ownerAgentId,
    });
  }
  if (params.rollback) {
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("skill_workshop_proposal_rollbacks")
        .values({
          proposal_id: params.record.id,
          written_at: params.rollback.writtenAt,
          target_skill_file: params.rollback.targetSkillFile,
          action: params.rollback.action,
          previous_content_hash: params.rollback.previousContentHash ?? null,
          previous_content: params.rollback.previousContent ?? null,
          support_files_json: params.rollback.supportFiles
            ? JSON.stringify(params.rollback.supportFiles)
            : null,
        })
        .onConflict((conflict) => conflict.column("proposal_id").doNothing()),
    );
  }
  return current ? "already-imported" : "imported";
}
