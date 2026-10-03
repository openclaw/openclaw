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
    assertCommitAllowed?: () => void;
  },
) {
  const { store, assertCommitAllowed, ...input } = params;
  return executeSkillWorkshopOperation(
    "workshop.transition.commit",
    input,
    store,
    assertCommitAllowed,
  );
}

export function readCommittedSkillProposalTransition(
  params: ReadCommittedSkillProposalTransitionInput & { store?: SkillWorkshopStoreOptions },
) {
  const { store, ...input } = params;
  return executeSkillWorkshopOperation("workshop.transition.committed", input, store);
}
