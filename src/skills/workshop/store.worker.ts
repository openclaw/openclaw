import type { DatabaseSync } from "node:sqlite";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../../state/openclaw-state-lease-worker.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
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
import type { SkillWorkshopExecutionOperations } from "./store.worker-contract.js";

type Operations = SkillWorkshopExecutionOperations &
  Pick<
    OpenClawStateWorkerOperations,
    "skills.curator.read" | "skills.usage.record" | "workshop.events.list"
  >;

export function isSkillWorkshopCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<Operations> {
  switch (command.type) {
    case "skills.curator.read":
    case "skills.usage.record":
    case "workshop.events.list":
    case "workshop.schema.ensure":
    case "workshop.proposal.read":
    case "workshop.proposals.list":
    case "workshop.proposal.create":
    case "workshop.proposal.update":
    case "workshop.proposal.import":
    case "workshop.proposal.evaluate":
    case "workshop.transition.commit":
    case "workshop.transition.committed":
    case "workshop.rollback.read":
    case "workshop.rollback.write":
    case "workshop.rollback.clear":
    case "workshop.collection.list":
    case "workshop.collection.drops":
    case "workshop.experience.record":
      return true;
    default:
      return false;
  }
}

export function executeSkillWorkshopCommand(
  command: SqliteWorkerCommand<Operations>,
  database: OpenClawStateDatabase,
  databasePath: string,
): Operations[keyof Operations]["output"] {
  if (command.type === "skills.curator.read") {
    return readSkillCuratorStateInDatabase(database, command.input.skillFiles);
  }
  const options = {
    database,
    path: databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  if (command.type === "skills.usage.record") {
    return runOpenClawStateWriteTransaction(
      (current) => recordSkillUsageInDatabase(current, command.input),
      options,
    );
  }
  if (command.type === "workshop.events.list") {
    ensureSkillWorkshopSchemaInDatabase(database, options);
    return listStoredSkillProposalEventsInDatabase(database.db, command.input);
  }
  const { leaseIdentities } = command.input;
  const assertWrite = (db: DatabaseSync, stage: "transaction" | "commit") => {
    if (leaseIdentities) {
      assertOpenClawStateLeasesWorkerOwnedInTransaction(db, leaseIdentities, stage);
    } else {
      requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
    }
  };
  if (command.type === "workshop.schema.ensure") {
    return ensureSkillWorkshopSchemaInDatabase(database, options, assertWrite);
  }
  const write = <T>(operationLabel: string, operation: () => T, proposalId?: string): T =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        assertWrite(db, "transaction");
        if (leaseIdentities) {
          const stored = proposalId ? readStoredProposalInDatabase(db, proposalId) : null;
          const agentId = command.input.agentId;
          for (const identity of leaseIdentities) {
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
        const result = operation();
        assertWrite(db, "commit");
        return result;
      },
      options,
      { operationLabel },
    );
  switch (command.type) {
    case "workshop.proposal.read":
      return readStoredProposalInDatabase(database.db, command.input.value);
    case "workshop.proposals.list":
      return listStoredSkillProposalsInDatabase(database.db, command.input.value);
    case "workshop.proposal.create":
      return write("skill-workshop.proposal.create", () =>
        createSkillProposalInDatabase(database.db, command.input.value),
      );
    case "workshop.proposal.update":
      return write(
        "skill-workshop.proposal.update",
        () => updateSkillProposalRecordInDatabase(database.db, command.input.value),
        command.input.value.record.id,
      );
    case "workshop.proposal.import":
      return write("doctor.skill-workshop.import", () =>
        importLegacySkillProposalInDatabase(database.db, command.input.value),
      );
    case "workshop.proposal.evaluate":
      return write(
        "skill-workshop.proposal.evaluate",
        () => recordSkillProposalEvaluationInDatabase(database.db, command.input.value),
        command.input.value.proposalId,
      );
    case "workshop.transition.commit":
      return write(
        command.input.value.operationLabel,
        () => commitPendingSkillProposalTransitionInDatabase(database.db, command.input.value),
        command.input.value.expected.id,
      );
    case "workshop.transition.committed":
      return readCommittedSkillProposalTransitionInDatabase(database.db, command.input.value);
    case "workshop.rollback.read":
      return readSkillProposalRollbackInDatabase(database.db, command.input.value);
    case "workshop.rollback.write":
      return write(
        "skill-workshop.rollback.write",
        () => writeSkillProposalRollbackInDatabase(database.db, command.input.value),
        command.input.value.proposalId,
      );
    case "workshop.rollback.clear":
      return write(
        "skill-workshop.rollback.clear",
        () => clearSkillProposalRollbackInDatabase(database.db, command.input.value),
        command.input.value.proposalId,
      );
    case "workshop.collection.list":
      return listSkillCollectionReviewOutcomesInDatabase(database.db, command.input.value);
    case "workshop.collection.drops":
      return readSkillCollectionBackupDropsInDatabase(database.db, command.input.value);
    case "workshop.experience.record":
      return write("skill-workshop.experience.record", () =>
        recordSkillExperienceReviewOutcomeInDatabase(database, command.input.value),
      );
  }
}
