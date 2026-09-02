import type { ReplyPayload } from "../types.js";
import { scheduleReplyRequestedTurnCompaction } from "./agent-runner-maintenance.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";

export async function finalizeReplyAgentRun(
  context: FinalizeReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const accounting = await accountAgentTurn(context);
  // Agent-requested compaction is scheduled here so it runs strictly after
  // delivery settlement: the reply must not wait on the summarization request,
  // and the turn's deferred lifecycle has already released the active run.
  scheduleReplyRequestedTurnCompaction({ context });
  const prepared = await prepareReplyAgentPayloads({ context, accounting });
  if (prepared.kind === "return") {
    return prepared.value;
  }
  return await completeReplyAgentRun({ context, accounting, prepared });
}
