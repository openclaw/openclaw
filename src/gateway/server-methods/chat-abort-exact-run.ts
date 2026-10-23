import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  captureSessionControllerStop,
  stopSession,
  type SessionStopHookContext,
} from "../../sessions/session-controller.stop.js";
import { abortChatRunById, type ChatAbortOps } from "../chat-abort.js";
import { abortControlledSubagents } from "./chat-abort-descendants.js";

type ExactClientRunStopResult = {
  aborted: boolean;
  descendants?: Awaited<ReturnType<typeof abortControlledSubagents>>;
  failure?: { error: unknown };
};

/**
 * Stops one exact Gateway RPC run through Stop source `client-run`: its source
 * input, its chat presentation, and that turn's controlled subagents.
 */
export async function stopExactClientRun(params: {
  ops: ChatAbortOps;
  cfg: OpenClawConfig;
  runId: string;
  active: RpcSourceRef;
  assertCurrent?: () => void;
  hookContext: Omit<SessionStopHookContext, "sessionKey" | "sessionId">;
  /** Runs once the parent cancellation result is known. */
  afterParent?: () => void;
  /** Runs after the chat abort is prepared, before it commits. */
  onAbortPrepared?: () => (() => void) | void;
}): Promise<ExactClientRunStopResult> {
  const { ops, runId, active } = params;
  // Capture the exact input before any await can select a successor.
  const capture = captureSessionControllerStop({ inputs: [active.input] });
  const { sessionKey, sessionId, agentId } = getRpcSourceIdentity(active);
  const result: ExactClientRunStopResult = { aborted: false };
  const assertCurrent = () => {
    params.assertCurrent?.();
    const replacement = getRpcSourceForGateway(runId, getGatewayContextResolver(active.input));
    if (replacement) {
      const identity = getRpcSourceIdentity(replacement);
      if (
        replacement !== active ||
        identity.sessionKey !== sessionKey ||
        identity.sessionId !== sessionId ||
        identity.agentId !== agentId
      ) {
        throw new Error("Run changed before cancellation; retry Stop.");
      }
    }
  };
  try {
    await stopSession({
      source: "client-run",
      capture,
      assertCurrent,
      reason: createAgentRunDirectAbortError(),
      hookContext: { ...params.hookContext, sessionKey, sessionId },
      afterParent: params.afterParent,
      continueChildStop: () => result.aborted,
      onCancelled: (target) => {
        if (target === active.input) {
          result.aborted = true;
        }
      },
      cancelInput: (_input, cancel) =>
        abortChatRunById(ops, {
          runId,
          sessionKey,
          expectedEntry: active,
          cancel,
          assertCurrent,
          stopReason: "rpc",
          onAbortPrepared: params.onAbortPrepared,
          onAbortCommitted: () => {
            result.aborted = true;
          },
        }).aborted,
      stopChildren: async (applyParentStop) => {
        result.descendants = await abortControlledSubagents({
          cfg: params.cfg,
          sessionKey,
          agentId,
          requesterTurnRunId: runId,
          sessionId,
          assertCurrent,
          beforeKill: applyParentStop,
          parentStopAccepted: () => result.aborted,
        });
        return {
          stopped: result.descendants?.killed ?? 0,
          failed: result.descendants?.status === "error" ? result.descendants.failed : 0,
        };
      },
    }).completed;
  } catch (error) {
    if (result.aborted && result.descendants?.status === "error") {
      result.descendants = {
        ...result.descendants,
        failed: result.descendants.failed + 1,
        error: `${result.descendants.error}; ${formatErrorMessage(error)}`,
      };
    } else {
      result.failure = { error };
    }
  }
  return result;
}
