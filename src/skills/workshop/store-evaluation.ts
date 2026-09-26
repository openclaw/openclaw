import { captureSkillWorkshopStoreOptions, executeSkillWorkshopOperation } from "./store-client.js";
import type { RecordSkillProposalEvaluationInput } from "./store-evaluation.kernel.js";
import { assertProposalId } from "./store-record.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import type { SkillProposalEventsListInput, SkillProposalEventsListResult } from "./types.js";

export async function recordSkillProposalEvaluation(
  params: RecordSkillProposalEvaluationInput & { store?: SkillWorkshopStoreOptions },
) {
  assertProposalId(params.proposalId);
  return executeSkillWorkshopOperation(
    "workshop.proposal.evaluate",
    {
      proposalId: params.proposalId,
      expectedProposedVersion: params.expectedProposedVersion,
      expectedRevisionHash: params.expectedRevisionHash,
      evaluation: params.evaluation,
      event: params.event,
    },
    params.store,
  );
}

export async function readSkillProposalEvents(
  input: SkillProposalEventsListInput,
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalEventsListResult> {
  const context = captureSkillWorkshopStoreOptions(options).execution.context;
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
