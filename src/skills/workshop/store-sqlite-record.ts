import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { parseSkillProposalRecord } from "./store-record.js";
import type { SkillProposalRow, SkillWorkshopDatabase } from "./store-sqlite-schema.js";
import type { SkillProposalRecord } from "./types.js";

export type StoredSkillProposal = { record: SkillProposalRecord; row: SkillProposalRow };

export function parseJson(value: string | null): unknown {
  return value === null ? undefined : safeParseJson(value);
}

export function parseSkillProposalRow(row: SkillProposalRow): SkillProposalRecord | null {
  const record = parseSkillProposalRecord(parseJson(row.record_json));
  if (
    !record ||
    record.id !== row.proposal_id ||
    record.kind !== row.kind ||
    record.status !== row.status ||
    record.createdAt !== row.created_at ||
    record.updatedAt !== row.updated_at ||
    record.draftHash !== row.draft_hash ||
    record.origin?.agentId !== (row.origin_agent_id ?? undefined) ||
    record.origin?.sessionKey !== (row.origin_session_key ?? undefined) ||
    record.origin?.runId !== (row.origin_run_id ?? undefined) ||
    record.origin?.messageId !== (row.origin_message_id ?? undefined)
  ) {
    return null;
  }
  return record;
}

export function readStoredProposalInDatabase(
  database: DatabaseSync,
  proposalId: string,
): StoredSkillProposal | null {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    kysely.selectFrom("skill_workshop_proposals").selectAll().where("proposal_id", "=", proposalId),
  );
  if (!row) {
    return null;
  }
  const record = parseSkillProposalRow(row);
  return record ? { record, row } : null;
}

function proposalRowValues(params: {
  record: SkillProposalRecord;
  ownerAgentId: string | null;
}): Insertable<SkillWorkshopDatabase["skill_workshop_proposals"]> {
  const { record } = params;
  return {
    proposal_id: record.id,
    record_json: JSON.stringify(record),
    owner_agent_id: params.ownerAgentId,
    kind: record.kind,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    draft_hash: record.draftHash,
    origin_agent_id: record.origin?.agentId ?? null,
    origin_session_key: record.origin?.sessionKey ?? null,
    origin_run_id: record.origin?.runId ?? null,
    origin_message_id: record.origin?.messageId ?? null,
    applied_at: record.appliedAt ?? null,
    rejected_at: record.rejectedAt ?? null,
    quarantined_at: record.quarantinedAt ?? null,
    stale_at: record.staleAt ?? null,
    status_reason: record.statusReason ?? null,
  };
}

export function insertProposal(
  database: DatabaseSync,
  params: { record: SkillProposalRecord; ownerAgentId: string | null },
): void {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  executeSqliteQuerySync(
    database,
    kysely.insertInto("skill_workshop_proposals").values(proposalRowValues(params)),
  );
}

export function updateProposal(
  database: DatabaseSync,
  current: SkillProposalRow,
  record: SkillProposalRecord,
  ownerAgentId?: string,
): void {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  const { proposal_id: _proposalId, ...values } = proposalRowValues({
    record,
    ownerAgentId: ownerAgentId ?? current.owner_agent_id,
  });
  executeSqliteQuerySync(
    database,
    kysely.updateTable("skill_workshop_proposals").set(values).where("proposal_id", "=", record.id),
  );
}

/** Called inside the Workshop worker's guarded write transaction. */
export function purgeRejectedProposalInDatabase(
  db: DatabaseSync,
  proposalId: string,
  agentId?: string,
): void {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .select(["status", "owner_agent_id"])
      .where("proposal_id", "=", proposalId),
  );
  if (!row || row.owner_agent_id !== agentId || row.status !== "rejected") {
    throw new Error("Only a rejected proposal owned by the selected agent can be purged.");
  }
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("skill_workshop_proposal_events").where("proposal_id", "=", proposalId),
  );
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("skill_workshop_proposal_rollbacks").where("proposal_id", "=", proposalId),
  );
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("skill_workshop_proposals").where("proposal_id", "=", proposalId),
  );
}
