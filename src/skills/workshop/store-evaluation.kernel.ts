import type { DatabaseSync } from "node:sqlite";
import { hashSkillProposalRevision } from "./revision-hash.js";
import { assertProposalId } from "./store-record.js";
import { appendSkillProposalEvent, type NewSkillProposalEvent } from "./store-sqlite-event.js";
import { readStoredProposalInDatabase, updateProposal } from "./store-sqlite-record.js";
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
  const current = readStoredProposalInDatabase(db, params.proposalId);
  if (!current) {
    throw new Error(`Skill proposal not found: ${params.proposalId}`);
  }
  const { record } = current;
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
  updateProposal(db, current.row, next);
  return {
    record: next,
    event: appendSkillProposalEvent(db, params.event),
  };
}
