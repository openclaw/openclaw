import type { DatabaseSync } from "node:sqlite";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import {
  listSkillCollectionReviewOutcomesInDatabase,
  readSkillCollectionBackupDropsInDatabase,
  recordSkillExperienceReviewOutcomeInDatabase,
} from "./collection-review.kernel.js";
import { readSkillCuratorStateInDatabase, recordSkillUsageInDatabase } from "./curator.kernel.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import { recordSkillProposalEvaluationInDatabase } from "./store-evaluation.kernel.js";
import {
  createSkillProposalInDatabase,
  importLegacySkillProposalInDatabase,
  listStoredSkillProposalsInDatabase,
  updateSkillProposalRecordInDatabase,
} from "./store-proposal.kernel.js";
import { listStoredSkillProposalEventsInDatabase } from "./store-sqlite-event.js";
import { readStoredProposalInDatabase } from "./store-sqlite-record.js";
import {
  clearSkillProposalRollbackInDatabase,
  readSkillProposalRollbackInDatabase,
  writeSkillProposalRollbackInDatabase,
} from "./store-sqlite-rollback.js";
import { ensureSkillWorkshopSchemaInDatabase } from "./store-sqlite-schema.js";
import {
  commitPendingSkillProposalTransitionInDatabase,
  readCommittedSkillProposalTransitionInDatabase,
} from "./store-sqlite-transition.js";

type WorkshopInput<Value> = {
  value: Value;
  agentId?: string;
  leaseIdentities?: readonly OpenClawStateLeaseIdentity[];
};

function assertWrite(
  db: DatabaseSync,
  input: WorkshopInput<unknown>,
  stage: "transaction" | "commit",
) {
  if (input.leaseIdentities) {
    assertOpenClawStateLeasesWorkerOwnedInTransaction(db, input.leaseIdentities, stage);
  } else {
    requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
  }
}

function write<T>(
  input: WorkshopInput<unknown>,
  { open, stateOptions }: WorkerOperationContext,
  operationLabel: string,
  operation: (database: OpenClawStateDatabase) => T,
  proposalId?: string,
): T {
  const database = open();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertWrite(db, input, "transaction");
      if (input.leaseIdentities) {
        const stored = proposalId ? readStoredProposalInDatabase(db, proposalId) : null;
        const { agentId } = input;
        for (const identity of input.leaseIdentities) {
          if (
            !agentId ||
            (identity.scope === "skill-collection"
              ? identity.key !== agentId
              : identity.scope !== "skill-workshop-target" ||
                !stored ||
                identity.key !==
                  `${agentId}:${hashSkillProposalContent(stored.record.target.skillFile)}`) ||
            (stored !== null &&
              stored.row.owner_agent_id !== null &&
              stored.row.owner_agent_id !== agentId)
          ) {
            throw new Error("Skill Workshop lease does not match its proposal target.");
          }
        }
      }
      const result = operation(database);
      assertWrite(db, input, "commit");
      return result;
    },
    { database, ...stateOptions() },
    { operationLabel },
  );
}

export const skillCuratorOperations = {
  "skills.curator.read": (input: { skillFiles: readonly string[] }, { open }) =>
    readSkillCuratorStateInDatabase(open(), input.skillFiles),
  "skills.usage.record": (
    input: Parameters<typeof recordSkillUsageInDatabase>[1],
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction((current) => recordSkillUsageInDatabase(current, input), {
      database: open(),
      ...stateOptions(),
    }),
} satisfies WorkerOperationHandlers;

export const skillWorkshopOperations = {
  "workshop.events.list": (
    input: Parameters<typeof listStoredSkillProposalEventsInDatabase>[1],
    { open, stateOptions },
  ) => {
    const database = open();
    ensureSkillWorkshopSchemaInDatabase(database, { database, ...stateOptions() });
    return listStoredSkillProposalEventsInDatabase(database.db, input);
  },
  "workshop.schema.ensure": (input: WorkshopInput<undefined>, { open, stateOptions }) => {
    const database = open();
    return ensureSkillWorkshopSchemaInDatabase(
      database,
      { database, ...stateOptions() },
      (db, stage) => assertWrite(db, input, stage),
    );
  },
  "workshop.proposal.read": (
    input: WorkshopInput<Parameters<typeof readStoredProposalInDatabase>[1]>,
    { open },
  ) => readStoredProposalInDatabase(open().db, input.value),
  "workshop.proposals.list": (
    input: WorkshopInput<Parameters<typeof listStoredSkillProposalsInDatabase>[1]>,
    { open },
  ) => listStoredSkillProposalsInDatabase(open().db, input.value),
  "workshop.proposal.create": (
    input: WorkshopInput<Parameters<typeof createSkillProposalInDatabase>[1]>,
    context,
  ) =>
    write(input, context, "skill-workshop.proposal.create", (database) =>
      createSkillProposalInDatabase(database.db, input.value),
    ),
  "workshop.proposal.update": (
    input: WorkshopInput<Parameters<typeof updateSkillProposalRecordInDatabase>[1]>,
    context,
  ) =>
    write(
      input,
      context,
      "skill-workshop.proposal.update",
      (database) => updateSkillProposalRecordInDatabase(database.db, input.value),
      input.value.record.id,
    ),
  "workshop.proposal.import": (
    input: WorkshopInput<Parameters<typeof importLegacySkillProposalInDatabase>[1]>,
    context,
  ) =>
    write(input, context, "doctor.skill-workshop.import", (database) =>
      importLegacySkillProposalInDatabase(database.db, input.value),
    ),
  "workshop.proposal.evaluate": (
    input: WorkshopInput<Parameters<typeof recordSkillProposalEvaluationInDatabase>[1]>,
    context,
  ) =>
    write(
      input,
      context,
      "skill-workshop.proposal.evaluate",
      (database) => recordSkillProposalEvaluationInDatabase(database.db, input.value),
      input.value.proposalId,
    ),
  "workshop.transition.commit": (
    input: WorkshopInput<
      Parameters<typeof commitPendingSkillProposalTransitionInDatabase>[1] & {
        operationLabel: string;
      }
    >,
    context,
  ) =>
    write(
      input,
      context,
      input.value.operationLabel,
      (database) => commitPendingSkillProposalTransitionInDatabase(database.db, input.value),
      input.value.expected.id,
    ),
  "workshop.transition.committed": (
    input: WorkshopInput<Parameters<typeof readCommittedSkillProposalTransitionInDatabase>[1]>,
    { open },
  ) => readCommittedSkillProposalTransitionInDatabase(open().db, input.value),
  "workshop.rollback.read": (
    input: WorkshopInput<Parameters<typeof readSkillProposalRollbackInDatabase>[1]>,
    { open },
  ) => readSkillProposalRollbackInDatabase(open().db, input.value),
  "workshop.rollback.write": (
    input: WorkshopInput<Parameters<typeof writeSkillProposalRollbackInDatabase>[1]>,
    context,
  ) =>
    write(
      input,
      context,
      "skill-workshop.rollback.write",
      (database) => writeSkillProposalRollbackInDatabase(database.db, input.value),
      input.value.proposalId,
    ),
  "workshop.rollback.clear": (
    input: WorkshopInput<Parameters<typeof clearSkillProposalRollbackInDatabase>[1]>,
    context,
  ) =>
    write(
      input,
      context,
      "skill-workshop.rollback.clear",
      (database) => clearSkillProposalRollbackInDatabase(database.db, input.value),
      input.value.proposalId,
    ),
  "workshop.collection.list": (
    input: WorkshopInput<Parameters<typeof listSkillCollectionReviewOutcomesInDatabase>[1]>,
    { open },
  ) => listSkillCollectionReviewOutcomesInDatabase(open().db, input.value),
  "workshop.collection.drops": (
    input: WorkshopInput<Parameters<typeof readSkillCollectionBackupDropsInDatabase>[1]>,
    { open },
  ) => readSkillCollectionBackupDropsInDatabase(open().db, input.value),
  "workshop.experience.record": (
    input: WorkshopInput<Parameters<typeof recordSkillExperienceReviewOutcomeInDatabase>[1]>,
    context,
  ) =>
    write(input, context, "skill-workshop.experience.record", (database) =>
      recordSkillExperienceReviewOutcomeInDatabase(database, input.value),
    ),
} satisfies WorkerOperationHandlers;
