import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import { assertProposalId } from "./store-record.js";
import { appendSkillProposalEvent, type NewSkillProposalEvent } from "./store-sqlite-event.js";
import { parseSkillProposalRow, updateProposal } from "./store-sqlite-record.js";
import type { SkillWorkshopDatabase } from "./store-sqlite-schema.js";
import type { SkillProposalEvent, SkillProposalEvaluation, SkillProposalRecord } from "./types.js";

export type RecordSkillProposalEvaluationInput = {
  proposalId: string;
  expectedProposedVersion: string;
  expectedRevisionHash: string;
  evaluation: SkillProposalEvaluation;
  event: NewSkillProposalEvent;
};

export function recordSkillProposalEvaluationInDatabase(
  db: DatabaseSync,
  params: RecordSkillProposalEvaluationInput,
): { record: SkillProposalRecord; event: SkillProposalEvent } {
  assertProposalId(params.proposalId);
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .selectAll()
      .where("proposal_id", "=", params.proposalId),
  );
  const record = current ? parseSkillProposalRow(current) : null;
  if (!current || !record) {
    throw new Error(`Skill proposal not found: ${params.proposalId}`);
  }
  if (
    record.status !== "pending" ||
    record.proposedVersion !== params.expectedProposedVersion ||
    hashSkillProposalRevision(record) !== params.expectedRevisionHash
  ) {
    throw new Error(
      "Skill proposal changed while evaluation was running; discard the stale evaluation and retry.",
    );
  }
  const next: SkillProposalRecord = {
    ...record,
    updatedAt: params.evaluation.completedAt,
    evaluation: params.evaluation,
  };
  updateProposal(db, current, next);
  return {
    record: next,
    event: appendSkillProposalEvent(db, params.event),
  };
}
