import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import { assertProposalId } from "./store-record.js";
import { appendSkillProposalEvent, type NewSkillProposalEvent } from "./store-sqlite-event.js";
import { parseSkillProposalRow, updateProposal } from "./store-sqlite-record.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import type {
  SkillProposalEvent,
  SkillProposalEvaluation,
  SkillProposalEventsListInput,
  SkillProposalEventsListResult,
  SkillProposalRecord,
} from "./types.js";

export function recordSkillProposalEvaluation(params: {
  proposalId: string;
  expectedProposedVersion: string;
  expectedRevisionHash: string;
  evaluation: SkillProposalEvaluation;
  event: NewSkillProposalEvent;
  store?: SkillWorkshopStoreOptions;
}): { record: SkillProposalRecord; event: SkillProposalEvent } {
  assertProposalId(params.proposalId);
  ensureSkillWorkshopSchema(params.store);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
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
    },
    databaseOptions(params.store),
    { operationLabel: "skill-workshop.proposal.evaluate" },
  );
}

export async function readSkillProposalEvents(
  input: SkillProposalEventsListInput,
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalEventsListResult> {
  const context = captureOpenClawStateWorkerContext(databaseOptions(options));
  const query = {
    agentId: input.agentId,
    proposalId: input.proposalId,
    afterSequence: input.afterSequence,
    limit: input.limit,
  };
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "workshop.events.list",
    input: query,
  });
}
