import type { ReplyPayload } from "../types.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";

export async function finalizeReplyAgentRun(
  context: FinalizeReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  return withAgentTurnCompletion(
    {
      agentId: context.followupRun.run.agentId,
      storePath: context.storePath,
      sessionKey: context.sessionKey,
      entry: context.activeSessionEntry,
      writer: context.execution.sessionWriter,
      operation: context.replyOperation,
      publish(entry) {
        context.activeSessionEntry = entry;
        if (context.activeSessionStore && context.sessionKey) {
          context.activeSessionStore[context.sessionKey] = entry;
        }
      },
    },
    async (completion) => {
      const current = { ...context, completion };
      const accounting = await accountAgentTurn(current);
      const prepared = await prepareReplyAgentPayloads({ context: current, accounting });
      if (prepared.kind === "return") {
        await completion?.complete();
        return prepared.value;
      }
      return completeReplyAgentRun({ context: current, accounting, prepared });
    },
  );
}
