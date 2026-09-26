import { executeSkillWorkshopOperation } from "./store-client.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import type {
  CommitPendingSkillProposalTransitionInput,
  ReadCommittedSkillProposalTransitionInput,
} from "./store-sqlite-transition.js";
export type { PendingSkillProposalTransitionCommit } from "./store-sqlite-transition.js";

export function commitPendingSkillProposalTransition(
  params: CommitPendingSkillProposalTransitionInput & {
    store?: SkillWorkshopStoreOptions;
    operationLabel: string;
  },
) {
  return executeSkillWorkshopOperation(
    "workshop.transition.commit",
    {
      expected: params.expected,
      record: params.record,
      event: params.event,
      operationLabel: params.operationLabel,
      invalidateRollback: params.invalidateRollback,
    },
    params.store,
  );
}

export function readCommittedSkillProposalTransition(
  params: ReadCommittedSkillProposalTransitionInput & { store?: SkillWorkshopStoreOptions },
) {
  return executeSkillWorkshopOperation(
    "workshop.transition.committed",
    { record: params.record, event: params.event },
    params.store,
  );
}
