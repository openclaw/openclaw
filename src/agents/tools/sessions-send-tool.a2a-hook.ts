import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  buildAgentToAgentMessageContext,
  resolvePingPongTurns,
} from "./sessions-send-a2a-helpers.js";
import type {
  DelegatedTaskContextParams,
  DelegatedTaskHook,
  DelegatedTaskParams,
} from "./sessions-send-delegated-task.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const log = createSubsystemLogger("agents/sessions-send-a2a-hook");

export function createA2ADelegatedTaskHook(): DelegatedTaskHook {
  return {
    buildContext(params: DelegatedTaskContextParams) {
      return buildAgentToAgentMessageContext({
        requesterSessionKey: params.requesterSessionKey,
        requesterChannel: params.requesterChannel,
        targetSessionKey: params.displayKey,
      });
    },

    async start(params: DelegatedTaskParams) {
      const maxPingPongTurns = resolvePingPongTurns(params.config);
      await runSessionsSendA2AFlow({
        targetSessionKey: params.targetSessionKey,
        displayKey: params.displayKey,
        message: params.message,
        announceTimeoutMs: 30_000,
        maxPingPongTurns,
        requesterSessionKey: params.requesterSessionKey,
        requesterChannel: params.requesterChannel,
        roundOneReply: params.roundOneReply,
        waitRunId: params.waitRunId,
        config: params.config,
      });
    },

    onError({ error, task }) {
      log.warn("delegated task flow failed", {
        requesterSessionKey: task.requesterSessionKey,
        targetSessionKey: task.targetSessionKey,
        waitRunId: task.waitRunId,
        error: formatErrorMessage(error),
      });
    },
  };
}
