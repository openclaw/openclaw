import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  trackSessionControllerSourceWork,
  type SessionControllerInput,
  type SessionControllerSourceAdapter,
} from "../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveChatAbortStopReason } from "../chat-abort.js";
import type { AgentTurnContext } from "./types.js";

/** Retain the exact request while routing has not yet selected a physical session. */
export function createAgentTurnPreparationSource(params: {
  runId: string;
  context: AgentTurnContext;
  controllerInput?: SessionControllerInput;
  requester: SessionControllerSourceAdapter["requester"];
  assertAdmissionCurrent?: () => void;
  onCancelled: (target: { agentId?: string; sessionKey?: string; stopReason: string }) => void;
}) {
  const work = createDeferredCore();
  const preparation: { agentId?: string } = {};
  let input = params.controllerInput;
  let requestedSessionKey: string | undefined;
  let retained = false;
  let transferred = false;
  const publishCancellation = () => {
    if (input) {
      const target = input.target;
      const stopReason = resolveChatAbortStopReason(input.abortSignal);
      // Preserve an exact RPC request's alias, but never a key discarded by rerouting.
      const sessionKey =
        stopReason === "rpc" &&
        requestedSessionKey &&
        (!target || target.aliases.includes(requestedSessionKey))
          ? requestedSessionKey
          : (target?.sessionKey ?? requestedSessionKey);
      params.onCancelled({
        agentId: target?.agentId ?? preparation.agentId,
        sessionKey,
        stopReason,
      });
    }
  };
  const settle = () => {
    input?.abortSignal.removeEventListener("abort", publishCancellation);
    work.resolve();
  };
  return {
    get input() {
      return input;
    },
    work: work.promise,
    assertCurrent(this: void) {
      input?.abortSignal.throwIfAborted();
    },
    reserve(sessionKey?: string, agentId?: string) {
      requestedSessionKey = sessionKey ?? requestedSessionKey;
      preparation.agentId = agentId ?? preparation.agentId;
      if (!input) {
        // This is only an opaque routing mailbox, never a session execution target.
        input = reserveSessionControllerSource(`agent-request:${params.runId}`, {
          protocolRunId: params.runId,
          sourceTurnId: params.runId,
          policy: { mode: "followup" },
          adapter: {
            preparation,
            requester: params.requester,
            authority: { assertCurrent: () => params.assertAdmissionCurrent?.() },
          },
        });
        bindGatewayContextResolver(input, params.context.resolveGatewayContext);
      }
      if (!retained) {
        retained = true;
        trackSessionControllerSourceWork(input, work.promise);
        input.abortSignal.addEventListener("abort", publishCancellation, { once: true });
        if (input.abortSignal.aborted) {
          publishCancellation();
        }
      }
      input.abortSignal.throwIfAborted();
    },
    settle,
    transfer() {
      transferred = true;
      settle();
    },
    [Symbol.dispose]() {
      // Supplied inputs keep their original producer's cleanup owner until adoption.
      if (input && !params.controllerInput && (!transferred || !input.target)) {
        retireSessionControllerInput(input);
      }
      settle();
    },
  };
}
