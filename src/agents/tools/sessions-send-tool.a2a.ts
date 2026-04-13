import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { createA2ATaskEventLogSink } from "../a2a/log.js";
import {
  buildA2ATaskEnvelopeFromExchange,
  buildA2ATaskRequestFromExchange,
  runA2ATaskRequest,
  type A2AExchangeRequest,
  type A2ATaskEventSink,
} from "./sessions-send-broker.js";
import {
  buildAgentToAgentAnnounceContext,
  buildAgentToAgentReplyContext,
  isAnnounceSkip,
  isReplySkip,
} from "./sessions-send-helpers.js";
import {
  __testing as openClawA2ATesting,
  createOpenClawA2ABrokerRuntime,
} from "./sessions-send-openclaw-adapter.js";

const defaultSessionsSendA2AHelpers = {
  createEventSink(params: { targetSessionKey: string; taskId: string }): A2ATaskEventSink {
    return createA2ATaskEventLogSink({
      sessionKey: params.targetSessionKey,
      taskId: params.taskId,
    });
  },
};

let sessionsSendA2AHelpers = defaultSessionsSendA2AHelpers;

export function buildSessionsSendA2AExchangeRequest(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
}): A2AExchangeRequest {
  return {
    requester: params.requesterSessionKey
      ? {
          sessionKey: params.requesterSessionKey,
          displayKey: params.requesterSessionKey,
          channel: params.requesterChannel,
        }
      : undefined,
    target: {
      sessionKey: params.targetSessionKey,
      displayKey: params.displayKey,
    },
    originalMessage: params.message,
    announceTimeoutMs: params.announceTimeoutMs,
    maxPingPongTurns: params.maxPingPongTurns,
    roundOneReply: params.roundOneReply,
    waitRunId: params.waitRunId,
  };
}

export async function runSessionsSendA2AFlow(params: {
  targetSessionKey: string;
  displayKey: string;
  message: string;
  announceTimeoutMs: number;
  maxPingPongTurns: number;
  requesterSessionKey?: string;
  requesterChannel?: GatewayMessageChannel;
  roundOneReply?: string;
  waitRunId?: string;
}) {
  const exchangeRequest = buildSessionsSendA2AExchangeRequest(params);
  const taskRequest = buildA2ATaskRequestFromExchange({
    request: exchangeRequest,
    taskId: params.waitRunId,
  });
  const envelope = buildA2ATaskEnvelopeFromExchange({
    request: exchangeRequest,
    taskId: params.waitRunId,
  });
  const result = await runA2ATaskRequest({
    request: taskRequest,
    eventSink: sessionsSendA2AHelpers.createEventSink({
      targetSessionKey: params.targetSessionKey,
      taskId: envelope.taskId,
    }),
    runtime: createOpenClawA2ABrokerRuntime(),
    buildReplyContext: buildAgentToAgentReplyContext,
    buildAnnounceContext: buildAgentToAgentAnnounceContext,
    isReplySkip,
    isAnnounceSkip,
  });
  return result.record;
}

export const __testing = {
  ...openClawA2ATesting,
  setHelpersForTest(overrides?: Partial<typeof defaultSessionsSendA2AHelpers>) {
    sessionsSendA2AHelpers = overrides
      ? {
          ...defaultSessionsSendA2AHelpers,
          ...overrides,
        }
      : defaultSessionsSendA2AHelpers;
  },
  buildTaskEnvelopeForTest(params: {
    targetSessionKey: string;
    displayKey: string;
    message: string;
    announceTimeoutMs: number;
    maxPingPongTurns: number;
    requesterSessionKey?: string;
    requesterChannel?: GatewayMessageChannel;
    roundOneReply?: string;
    waitRunId?: string;
  }) {
    return buildA2ATaskEnvelopeFromExchange({
      request: buildSessionsSendA2AExchangeRequest(params),
      taskId: params.waitRunId,
    });
  },
};
