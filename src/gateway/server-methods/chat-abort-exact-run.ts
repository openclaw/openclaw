import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { getSessionControllerSourceIdentity } from "../../sessions/session-controller.identity.js";
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

/** Retain the physical source across asynchronous Stop metadata preparation. */
export function captureSourceAssertion(input: RpcSourceRef["input"], assertCurrent?: () => void) {
  const selected = getSessionControllerSourceIdentity(input);
  return () => {
    assertCurrent?.();
    const current = getSessionControllerSourceIdentity(input);
    if (
      current.sessionKey !== selected.sessionKey ||
      current.sessionId !== selected.sessionId ||
      current.agentId !== selected.agentId
    ) {
      throw new Error("Run changed before cancellation; retry Stop.");
    }
  };
}

/**
 * Stops one exact Gateway RPC run through Stop source `client-run`: its source
 * input, its chat presentation, and that turn's controlled subagents.
 */
export async function stopExactClientRun(params: {
  ops: ChatAbortOps;
  cfg: OpenClawConfig;
  runId: string;
  active: RpcSourceRef;
  lifecycleRevision?: string;
  assertCurrent?: () => void;
  hookContext: Omit<SessionStopHookContext, "sessionKey" | "sessionId">;
  /** Runs once the parent cancellation result is known. */
  afterParent?: () => void;
  /** Runs after the chat abort is prepared, before it commits. */
  onAbortPrepared?: () => (() => void) | void;
  /** Records only this captured run's committed cancellation. */
  onAborted?: () => void;
}): Promise<ExactClientRunStopResult> {
  const { ops, runId, active } = params;
  // Capture the exact input before any await can select a successor.
  const capture = captureSessionControllerStop({ inputs: [active.input] });
  const { sessionKey, sessionId, agentId } = getRpcSourceIdentity(active);
  const result: ExactClientRunStopResult = { aborted: false };
  const assertSource = captureSourceAssertion(active.input, params.assertCurrent);
  const markAborted = () => {
    if (!result.aborted) {
      result.aborted = true;
      params.onAborted?.();
    }
  };
  const assertCurrent = () => {
    assertSource();
    const replacement = getRpcSourceForGateway(runId, getGatewayContextResolver(active.input));
    if (replacement && replacement !== active) {
      throw new Error("Run changed before cancellation; retry Stop.");
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
          markAborted();
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
          onAbortCommitted: markAborted,
        }).aborted,
      stopChildren: async (applyParentStop) => {
        result.descendants = await abortControlledSubagents({
          cfg: params.cfg,
          sessionKey,
          agentId,
          requesterTurnRunId: runId,
          sessionId,
          lifecycleRevision: params.lifecycleRevision,
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
