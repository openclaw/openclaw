import type { ReplyPayload } from "../types.js";
import { withAgentTurnCompletion } from "./agent-runner-completion.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { completeReplyAgentRun } from "./agent-runner-result-complete.js";
import { buildReplyDiagnosticsPayload } from "./agent-runner-result-diagnostics.js";
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
      prepareRestartClaimCleanup: context.prepareRestartClaimCleanup,
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
        const refreshDiagnostics =
          context.followupRun.run.verboseLevelOverride !== "off" ||
          context.followupRun.run.traceAuthorized === true;
        const activeSessionEntry =
          refreshDiagnostics && completion
            ? await completion.refresh()
            : accounting.activeSessionEntry;
        const diagnostics = await buildReplyDiagnosticsPayload({
          activeSessionEntry,
          followupRun: context.followupRun,
          accounting,
          cfg: context.cfg,
          storePath: context.storePath,
          userText: context.sessionCtx.commandText || context.sessionCtx.agentText,
          resolvedVerboseLevel: context.resolvedVerboseLevel,
          resolvedBlockStreamingBreak: context.resolvedBlockStreamingBreak,
          preflightCompactionApplied: context.preflightCompactionApplied,
        });
        await completion?.complete();
        if (!diagnostics) {
          return prepared.value;
        }
        return prepared.value
          ? [...(Array.isArray(prepared.value) ? prepared.value : [prepared.value]), diagnostics]
          : diagnostics;
      }
      return completeReplyAgentRun({ context: current, accounting, prepared });
    },
  );
}
