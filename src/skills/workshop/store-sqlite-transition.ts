import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  appendSkillProposalEvent,
  readStoredSkillProposalEventInDatabase,
  type NewSkillProposalEvent,
} from "./store-sqlite-event.js";
import { readStoredProposalInDatabase, updateProposal } from "./store-sqlite-record.js";
import type { SkillWorkshopDatabase } from "./store-sqlite-schema.js";
import type { SkillProposalEvent, SkillProposalRecord } from "./types.js";

export type PendingSkillProposalTransitionCommit =
  | { state: "committed"; event: SkillProposalEvent }
  | { state: "conflict"; current?: SkillProposalRecord };

export type CommitPendingSkillProposalTransitionInput = {
  expected: SkillProposalRecord;
  record: SkillProposalRecord;
  event: NewSkillProposalEvent;
  invalidateRollback?: boolean;
};

export type ReadCommittedSkillProposalTransitionInput = {
  record: SkillProposalRecord;
  event: NewSkillProposalEvent;
};

export function commitPendingSkillProposalTransitionInDatabase(
  db: DatabaseSync,
  params: CommitPendingSkillProposalTransitionInput,
): PendingSkillProposalTransitionCommit {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
  const current = readStoredProposalInDatabase(db, params.expected.id);
  if (
    !current ||
    current.record.status !== "pending" ||
    current.row.record_json !== JSON.stringify(params.expected)
  ) {
    return {
      state: "conflict" as const,
      ...(current ? { current: current.record } : {}),
    };
  }
  if (params.invalidateRollback) {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("skill_workshop_proposal_rollbacks")
        .where("proposal_id", "=", params.expected.id),
    );
  }
  updateProposal(db, current.row, params.record);
  return {
    state: "committed" as const,
    event: appendSkillProposalEvent(db, params.event),
  };
}

export function readCommittedSkillProposalTransitionInDatabase(
  db: DatabaseSync,
  params: ReadCommittedSkillProposalTransitionInput,
): Extract<PendingSkillProposalTransitionCommit, { state: "committed" }> | null {
  const stored = readStoredProposalInDatabase(db, params.record.id);
  if (!stored || stored.row.record_json !== JSON.stringify(params.record)) {
    return null;
  }
  const event = readStoredSkillProposalEventInDatabase(db, params.event.eventId);
  if (
    !event ||
    event.proposalId !== params.event.proposalId ||
    event.proposedVersion !== params.event.proposedVersion ||
    event.revisionHash !== params.event.revisionHash ||
    event.type !== params.event.type
  ) {
    return null;
  }
  return { state: "committed", event };
}
