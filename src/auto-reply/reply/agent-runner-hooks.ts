import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { AgentRunLoopResult } from "./agent-runner-execution.js";
import { runAgentTurnWithFallback } from "./agent-runner-execution.js";

/** Hard safety cap against infinite loops from buggy plugins. */
const HOOK_REINJECT_SAFETY_CAP = 5;

type RunAgentTurnParams = Parameters<typeof runAgentTurnWithFallback>[0];

export type AfterAgentCompleteHookContext = {
  /** Channel type, e.g. "slack", "discord". */
  channelId: string;
  /** Account-scoped channel key. */
  channelKey: string;
  /** Conversation target (e.g. group ID, DM address). */
  conversationId?: string;
  /** Account id for multi-account channels (e.g. "conor", "default"). */
  accountId?: string;
  agentId: string;
  /** Factory to recreate the block reply pipeline on reinject iterations. */
  recreateBlockPipeline?: () => RunAgentTurnParams["blockReplyPipeline"];
};

/**
 * Wrap runAgentTurnWithFallback with the after_agent_complete hook loop.
 *
 * After each successful agent run, fires the after_agent_complete hook.
 * Plugins can return `reinject: true` with `injectContext` to re-run
 * the agent with updated context, or `suppress: true` to drop the response.
 * The plugin owns retry budgeting; core only enforces HOOK_REINJECT_SAFETY_CAP.
 */
export async function runAgentTurnWithHooks(
  params: RunAgentTurnParams,
  hookCtx: AfterAgentCompleteHookContext,
): Promise<AgentRunLoopResult> {
  const hookRunner = getGlobalHookRunner();

  // Fast path: no hooks registered, skip the loop overhead.
  if (!hookRunner?.hasHooks("after_agent_complete")) {
    return runAgentTurnWithFallback(params);
  }

  let effectiveCommandBody = params.commandBody;
  let blockReplyPipeline = params.blockReplyPipeline;
  const processingStartedAt = Date.now();

  for (let attempt = 0; attempt <= HOOK_REINJECT_SAFETY_CAP; attempt++) {
    const outcome = await runAgentTurnWithFallback({
      ...params,
      commandBody: effectiveCommandBody,
      blockReplyPipeline,
    });

    // Early terminations (errors, session resets) bypass the hook.
    if (outcome.kind === "final") {
      return outcome;
    }

    const responseText =
      outcome.runResult.payloads
        ?.map((p) => p.text)
        .filter(Boolean)
        .join("\n") ?? "";

    const hookResult = await hookRunner.runAfterAgentComplete(
      {
        sessionKey: params.sessionKey ?? "",
        channelId: hookCtx.channelId,
        channelKey: hookCtx.channelKey,
        conversationId: hookCtx.conversationId,
        agentId: hookCtx.agentId,
        response: responseText,
        processingStartedAt,
      },
      {
        agentId: hookCtx.agentId,
        sessionKey: params.sessionKey,
        channelId: hookCtx.channelId,
        conversationId: hookCtx.conversationId,
        accountId: hookCtx.accountId,
      },
    );

    // No hook result or no reinject/suppress: return normally.
    if (!hookResult?.reinject && !hookResult?.suppress) {
      return outcome;
    }

    if (hookResult.suppress) {
      return { kind: "final", payload: { text: undefined } };
    }

    // Last attempt: return whatever we have rather than looping again.
    if (attempt === HOOK_REINJECT_SAFETY_CAP) {
      return outcome;
    }

    // Reinject: update context and loop.
    if (hookResult.injectContext) {
      effectiveCommandBody = `${effectiveCommandBody}\n\n${hookResult.injectContext}`;
    }

    // Recreate block reply pipeline for the next iteration if available.
    if (hookCtx.recreateBlockPipeline) {
      blockReplyPipeline?.stop();
      blockReplyPipeline = hookCtx.recreateBlockPipeline();
    }
  }

  // Unreachable, but satisfies the type checker.
  return runAgentTurnWithFallback(params);
}
