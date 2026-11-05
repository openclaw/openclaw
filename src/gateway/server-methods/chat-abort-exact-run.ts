import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { getSessionControllerSourceIdentity } from "../../sessions/session-controller.identity.js";
import { captureSessionControllerEffects } from "../../sessions/session-controller.lifecycle-work.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
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
import { notifySessionRunStopped } from "../../sessions/session-run-stopped.js";
import { abortChatRunById, createChatAbortSignalReason, type ChatAbortOps } from "../chat-abort.js";
import { resolveChatAbortTargetRejection } from "./chat-abort-authorization.js";
import { abortControlledSubagents } from "./chat-abort-descendants.js";
import type { ChatAbortSessionSnapshot } from "./chat-aborted-partial.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

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
  userInitiated?: boolean;
  lifecycleRevision?: string;
  assertCurrent?: () => void;
  hookContext: Omit<SessionStopHookContext, "sessionKey" | "sessionId">;
  /** Runs once the parent cancellation result is known. */
  afterParent?: () => void;
  /** Runs after the chat abort is prepared, before it commits. */
  onAbortPrepared?: () => (() => void) | void;
  /**
   * Explicit authorized chat Stop: announce the stopped run right before its cancellation
   * commits. Absent for non-chat callers such as realtime talk, which keep their own Stop
   * contract.
   */
  stoppedSession?: { agentId?: string; sessionKey: string };
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
      reason: createChatAbortSignalReason("rpc", params.userInitiated),
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
          onAbortPrepared: () => {
            // Announce before the run commits cancellation, so consumers act before its own
            // completion arrives. The notification never fails Stop.
            if (params.stoppedSession) {
              notifySessionRunStopped({
                source: "client-run",
                sessions: [params.stoppedSession],
                runIds: [runId],
              });
            }
            return params.onAbortPrepared?.();
          },
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

/** Stop the exact retained producer after its RPC retires, without widening to its mailbox. */
export async function stopRetainedRun(params: {
  session: Extract<ChatAbortSessionSnapshot, { ok: true }>["value"];
  sessionKey: string;
  aliases: string[];
  agentId: string;
  runId: string;
  resolveGatewayContext: ReturnType<typeof getGatewayContextResolver>;
  authorizeRunTarget: (
    target: Parameters<typeof resolveChatAbortTargetRejection>[0]["target"],
  ) => boolean;
  assertCurrent: () => void;
  hookContext: SessionStopHookContext;
}) {
  const { session, runId, resolveGatewayContext } = params;
  const effects = session.entry?.sessionId
    ? captureSessionControllerEffects({
        target: captureSessionTarget({
          storeScope: session.storePath,
          sessionKey: params.sessionKey,
          aliases: params.aliases,
          agentId: params.agentId,
          incarnation: session.entry.sessionId,
        }),
        requiredSessionId: session.entry.sessionId,
        resolveGatewayContext,
      }).filter((effect) => effect.run?.runId === runId && effect.run.abortAuthority)
    : [];
  for (const { run } of effects) {
    if (run && !params.authorizeRunTarget({ ...run, ...run.abortAuthority })) {
      return undefined;
    }
  }
  return await stopSession({
    source: "client-run",
    capture: captureSessionControllerStop({ effects, resolveGatewayContext }),
    assertCurrent: params.assertCurrent,
    hookContext: params.hookContext,
  }).completed;
}

/** The same exact-run authorization and command Stop policy also owns retired producers. */
export function createExactRunStopControls(params: {
  authorization: Omit<Parameters<typeof resolveChatAbortTargetRejection>[0], "target">;
  assertCurrent: () => void;
  hookContext: SessionStopHookContext;
  respond: GatewayRequestHandlerOptions["respond"];
}) {
  return {
    stopWithoutCapturedRun: (reason?: string, afterParent?: () => void) =>
      stopSession({
        source: "client-run",
        capture: captureSessionControllerStop({}),
        assertCurrent: params.assertCurrent,
        reason,
        hookContext: params.hookContext,
        afterParent,
      }).completed,
    authorizeRunTarget: (
      target: Parameters<typeof resolveChatAbortTargetRejection>[0]["target"],
    ) => {
      const rejection = resolveChatAbortTargetRejection({ ...params.authorization, target });
      if (rejection) {
        respondError(params.respond, ErrorCodes.INVALID_REQUEST, rejection);
      }
      return rejection === undefined;
    },
  };
}
