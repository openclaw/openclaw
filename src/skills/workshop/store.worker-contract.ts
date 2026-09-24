import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease-store.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import type {
  RecordSkillExperienceReviewOutcomeInput,
  ReadSkillCollectionBackupDropsInput,
  SkillCollectionReviewOutcome,
} from "./collection-review.kernel.js";
import type { RecordSkillProposalEvaluationInput } from "./store-evaluation.kernel.js";
import type {
  CreateSkillProposalInput,
  ImportLegacySkillProposalInput,
  ListStoredSkillProposalsInput,
  UpdateSkillProposalRecordInput,
} from "./store-proposal.kernel.js";
import type { StoredSkillProposal } from "./store-sqlite-record.js";
import type {
  ClearSkillProposalRollbackInput,
  WriteSkillProposalRollbackInput,
} from "./store-sqlite-rollback.js";
import type {
  CommitPendingSkillProposalTransitionInput,
  PendingSkillProposalTransitionCommit,
  ReadCommittedSkillProposalTransitionInput,
} from "./store-sqlite-transition.js";
import type { SkillProposalEvent, SkillProposalRecord, SkillProposalRollback } from "./types.js";

type WorkshopOperation<Input, Output> = {
  input: {
    value: Input;
    agentId?: string;
    leaseIdentities?: readonly OpenClawStateLeaseIdentity[];
  };
  output: Output;
};

export type SkillWorkshopExecutionOperations = {
  "workshop.schema.ensure": WorkshopOperation<undefined, void>;
  "workshop.proposal.read": WorkshopOperation<string, StoredSkillProposal | null>;
  "workshop.proposals.list": WorkshopOperation<
    ListStoredSkillProposalsInput,
    StoredSkillProposal[]
  >;
  "workshop.proposal.create": WorkshopOperation<CreateSkillProposalInput, SkillProposalEvent>;
  "workshop.proposal.update": WorkshopOperation<
    UpdateSkillProposalRecordInput,
    SkillProposalEvent | undefined
  >;
  "workshop.proposal.import": WorkshopOperation<
    ImportLegacySkillProposalInput,
    "imported" | "already-imported"
  >;
  "workshop.proposal.evaluate": WorkshopOperation<
    RecordSkillProposalEvaluationInput,
    { record: SkillProposalRecord; event: SkillProposalEvent }
  >;
  "workshop.transition.commit": WorkshopOperation<
    CommitPendingSkillProposalTransitionInput & { operationLabel: string },
    PendingSkillProposalTransitionCommit
  >;
  "workshop.transition.committed": WorkshopOperation<
    ReadCommittedSkillProposalTransitionInput,
    Extract<PendingSkillProposalTransitionCommit, { state: "committed" }> | null
  >;
  "workshop.rollback.read": WorkshopOperation<string, SkillProposalRollback | null>;
  "workshop.rollback.write": WorkshopOperation<WriteSkillProposalRollbackInput, void>;
  "workshop.rollback.clear": WorkshopOperation<ClearSkillProposalRollbackInput, boolean>;
  "workshop.collection.list": WorkshopOperation<string, SkillCollectionReviewOutcome[]>;
  "workshop.collection.drops": WorkshopOperation<ReadSkillCollectionBackupDropsInput, Set<string>>;
  "workshop.experience.record": WorkshopOperation<RecordSkillExperienceReviewOutcomeInput, void>;
};

export type SkillWorkshopWorkerOperations = SkillWorkshopExecutionOperations &
  Pick<
    OpenClawStateWorkerOperations,
    "skills.curator.read" | "skills.usage.record" | "workshop.events.list"
  >;

export function isSkillWorkshopCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<SkillWorkshopWorkerOperations> {
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
