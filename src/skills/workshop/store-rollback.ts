import { executeSkillWorkshopOperation } from "./store-client.js";
import { assertProposalId } from "./store-record.js";
import type {
  ClearSkillProposalRollbackInput,
  WriteSkillProposalRollbackInput,
} from "./store-sqlite-rollback.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";

export async function writeSkillProposalRollback(
  params: WriteSkillProposalRollbackInput & { store?: SkillWorkshopStoreOptions },
) {
  assertProposalId(params.proposalId);
  return executeSkillWorkshopOperation(
    "workshop.rollback.write",
    { proposalId: params.proposalId, rollback: params.rollback },
    params.store,
  );
}

export async function readSkillProposalRollback(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
) {
  assertProposalId(proposalId);
  return executeSkillWorkshopOperation("workshop.rollback.read", proposalId, options);
}

export async function clearSkillProposalRollback(
  params: ClearSkillProposalRollbackInput & { store?: SkillWorkshopStoreOptions },
) {
  assertProposalId(params.proposalId);
  return executeSkillWorkshopOperation(
    "workshop.rollback.clear",
    { proposalId: params.proposalId, expectedRecordJson: params.expectedRecordJson },
    params.store,
  );
}
