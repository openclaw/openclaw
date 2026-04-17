import { createA2ATaskEventLogSink } from "../a2a/log.js";
import {
  __testing as openClawA2ATesting,
  createOpenClawA2ABrokerRuntime,
} from "../a2a/openclaw-runtime.js";
import {
  applyA2ATaskProtocolCancel,
  buildA2ATaskEnvelopeFromExchange,
  buildA2ATaskRequestFromExchange,
  loadA2ATaskProtocolStatusById,
  runA2ATaskRequest,
  type A2ABrokerRuntime,
  type A2AExchangeRequest,
  type A2ATaskCancelResult,
  type A2ATaskEventSink,
  type A2ATaskProtocolStatus,
  type A2ATaskRecord,
} from "./sessions-send-broker.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-helpers.js";

const defaultSessionsSendOpenClawHelpers = {
  createEventSink(params: { targetSessionKey: string; taskId: string }): A2ATaskEventSink {
    return createA2ATaskEventLogSink({
      sessionKey: params.targetSessionKey,
      taskId: params.taskId,
    });
  },
};

let sessionsSendOpenClawHelpers = defaultSessionsSendOpenClawHelpers;

export type SessionsSendA2AAdapter = {
  runTaskRequest(params: { request: A2AExchangeRequest; taskId?: string }): Promise<A2ATaskRecord>;
  reconcileTaskStatus?(params: {
    sessionKey: string;
    taskId: string;
  }): Promise<A2ATaskProtocolStatus | undefined>;
  cancelTask?(params: {
    sessionKey: string;
    taskId: string;
    reason?: string;
  }): Promise<A2ATaskCancelResult | undefined>;
};

export function createOpenClawSessionsSendA2AAdapter(params?: {
  runtime?: A2ABrokerRuntime;
}): SessionsSendA2AAdapter {
  const runtime = params?.runtime ?? createOpenClawA2ABrokerRuntime();
  return {
    async runTaskRequest({ request, taskId }) {
      const taskRequest = buildA2ATaskRequestFromExchange({
        request,
        taskId,
      });
      const envelope = buildA2ATaskEnvelopeFromExchange({
        request,
        taskId,
      });
      const result = await runA2ATaskRequest({
        request: taskRequest,
        eventSink: sessionsSendOpenClawHelpers.createEventSink({
          targetSessionKey: request.target.sessionKey,
          taskId: envelope.taskId,
        }),
        runtime,
        buildReplyContext: buildAgentToAgentReplyContext,
        buildAnnounceContext: buildAgentToAgentAnnounceContext,
        isReplySkip,
        isAnnounceSkip,
      });
      return result.record;
    },

    reconcileTaskStatus({ sessionKey, taskId }) {
      return loadA2ATaskProtocolStatusById({
        sessionKey,
        taskId,
      });
    },

    cancelTask({ sessionKey, taskId, reason }) {
      return applyA2ATaskProtocolCancel({
        sessionKey,
        cancel: {
          method: "a2a.task.cancel",
          taskId,
          reason,
        },
        runtime,
      });
    },
  };
}

export { createOpenClawA2ABrokerRuntime };

export const __testing = {
  ...openClawA2ATesting,
  setHelpersForTest(overrides?: Partial<typeof defaultSessionsSendOpenClawHelpers>) {
    sessionsSendOpenClawHelpers = overrides
      ? {
          ...defaultSessionsSendOpenClawHelpers,
          ...overrides,
        }
      : defaultSessionsSendOpenClawHelpers;
  },
};
