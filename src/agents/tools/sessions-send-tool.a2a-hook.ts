import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  buildAgentToAgentMessageContext,
  resolvePingPongTurns,
} from "./sessions-send-a2a-helpers.js";
import type {
  DelegatedTaskCancelResult,
  DelegatedTaskHook,
  DelegatedTaskParams,
  DelegatedTaskStatus,
} from "./sessions-send-delegated-task.js";
import {
  cancelSessionsSendA2ATask,
  reconcileSessionsSendA2ATask,
  runSessionsSendA2AFlow,
} from "./sessions-send-tool.a2a.js";

const log = createSubsystemLogger("agents/sessions-send-a2a-hook");

function mapProtocolStatusToDelegated(
  status:
    | {
        executionStatus: string;
        deliveryStatus: string;
        taskId: string;
        summary?: string;
        error?: { code: string; message?: string };
        updatedAt: number;
        hasHeartbeat: boolean;
      }
    | undefined,
): DelegatedTaskStatus | undefined {
  if (!status) {
    return undefined;
  }
  return {
    taskId: status.taskId,
    executionStatus: status.executionStatus,
    deliveryStatus: status.deliveryStatus,
    summary: status.summary,
    error: status.error,
    updatedAt: status.updatedAt,
    hasHeartbeat: status.hasHeartbeat,
  };
}

function mapCancelResultToDelegated(
  result:
    | {
        executionStatus: string;
        deliveryStatus: string;
        taskId: string;
        summary?: string;
        error?: { code: string; message?: string };
        updatedAt: number;
        hasHeartbeat: boolean;
        abortStatus?: string;
      }
    | undefined,
): DelegatedTaskCancelResult | undefined {
  if (!result) {
    return undefined;
  }
  return {
    taskId: result.taskId,
    executionStatus: result.executionStatus,
    deliveryStatus: result.deliveryStatus,
    summary: result.summary,
    error: result.error,
    updatedAt: result.updatedAt,
    hasHeartbeat: result.hasHeartbeat,
    abortStatus: result.abortStatus,
  };
}

export function createA2ADelegatedTaskHook(): DelegatedTaskHook {
  return {
    buildContext(params) {
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
        followTaskStream: true,
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

    async reconcileTaskStatus(params) {
      const status = await reconcileSessionsSendA2ATask({
        sessionKey: params.sessionKey,
        taskId: params.taskId,
        config: params.config,
      });
      return mapProtocolStatusToDelegated(status);
    },

    async cancelTask(params) {
      const result = await cancelSessionsSendA2ATask({
        sessionKey: params.sessionKey,
        taskId: params.taskId,
        reason: params.reason,
        config: params.config,
      });
      return mapCancelResultToDelegated(result);
    },
  };
}
