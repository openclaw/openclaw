import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { isTerminalExecutionStatus } from "../a2a/status.js";
import {
  buildA2ATaskEnvelopeFromExchange,
  loadA2ATaskProtocolStatusById,
  type A2AExchangeRequest,
  type A2ATaskCancelTarget,
  type A2ATaskProtocolStatus,
  type A2ATaskRecord,
} from "./sessions-send-broker.js";
import {
  __testing as openClawA2ATesting,
  createOpenClawSessionsSendA2AAdapter,
  type SessionsSendA2AAdapter,
  type SessionsSendA2ATaskSubscriptionResult,
} from "./sessions-send-openclaw-adapter.js";
import {
  createStandaloneBrokerSessionsSendA2AAdapter,
  shouldUseStandaloneBrokerSessionsSendAdapter,
} from "./sessions-send-standalone-broker-adapter.js";

const defaultSessionsSendA2ADeps = {
  createAdapter: (): SessionsSendA2AAdapter => createOpenClawSessionsSendA2AAdapter(),
  createBrokerAdapter: (config: OpenClawConfig): SessionsSendA2AAdapter =>
    createStandaloneBrokerSessionsSendA2AAdapter({ config }),
  shouldUseBrokerAdapter: (config?: OpenClawConfig): boolean =>
    shouldUseStandaloneBrokerSessionsSendAdapter(config),
};

let sessionsSendA2ADeps = defaultSessionsSendA2ADeps;

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
  correlationId?: string;
  parentRunId?: string;
  cancelTarget?: A2ATaskCancelTarget;
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
    correlationId: params.correlationId ?? params.waitRunId,
    parentRunId: params.parentRunId ?? params.waitRunId,
    cancelTarget:
      params.cancelTarget ??
      (params.targetSessionKey
        ? {
            kind: "session_run",
            sessionKey: params.targetSessionKey,
            ...(params.waitRunId ? { runId: params.waitRunId } : {}),
          }
        : undefined),
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
  correlationId?: string;
  parentRunId?: string;
  cancelTarget?: A2ATaskCancelTarget;
  config?: OpenClawConfig;
  followTaskStream?: boolean;
  followSignal?: AbortSignal;
}) {
  const exchangeRequest = buildSessionsSendA2AExchangeRequest(params);
  const adapter = selectSessionsSendA2AAdapter(params.config);
  const record = await adapter.runTaskRequest({
    request: exchangeRequest,
    taskId: params.waitRunId,
  });

  if (params.followTaskStream && adapter.subscribeTaskStatus && shouldFollowTaskStream(record)) {
    await followSessionsSendA2ATaskStreamWithFallback({
      adapter,
      sessionKey: exchangeRequest.target.sessionKey,
      taskId: record.taskId,
      ...(params.followSignal ? { signal: params.followSignal } : {}),
    });
  }

  return record;
}

export async function reconcileSessionsSendA2ATask(params: {
  sessionKey: string;
  taskId: string;
  config?: OpenClawConfig;
}) {
  const adapter = selectSessionsSendA2AAdapter(params.config);
  if (!adapter.reconcileTaskStatus) {
    return loadA2ATaskProtocolStatusById({
      sessionKey: params.sessionKey,
      taskId: params.taskId,
    });
  }
  return adapter.reconcileTaskStatus({
    sessionKey: params.sessionKey,
    taskId: params.taskId,
  });
}

export async function cancelSessionsSendA2ATask(params: {
  sessionKey: string;
  taskId: string;
  reason?: string;
  config?: OpenClawConfig;
}) {
  const adapter = selectSessionsSendA2AAdapter(params.config);
  if (!adapter.cancelTask) {
    return undefined;
  }
  return adapter.cancelTask({
    sessionKey: params.sessionKey,
    taskId: params.taskId,
    reason: params.reason,
  });
}

function selectSessionsSendA2AAdapter(config?: OpenClawConfig): SessionsSendA2AAdapter {
  return config && sessionsSendA2ADeps.shouldUseBrokerAdapter(config)
    ? sessionsSendA2ADeps.createBrokerAdapter(config)
    : sessionsSendA2ADeps.createAdapter();
}

async function followSessionsSendA2ATaskStreamWithFallback(params: {
  adapter: SessionsSendA2AAdapter;
  sessionKey: string;
  taskId: string;
  signal?: AbortSignal;
}) {
  try {
    const result = await params.adapter.subscribeTaskStatus?.({
      sessionKey: params.sessionKey,
      taskId: params.taskId,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (shouldFallbackToReconcile(result)) {
      await params.adapter.reconcileTaskStatus?.({
        sessionKey: params.sessionKey,
        taskId: params.taskId,
      });
    }
  } catch {
    await params.adapter.reconcileTaskStatus?.({
      sessionKey: params.sessionKey,
      taskId: params.taskId,
    });
  }
}

function shouldFollowTaskStream(record: A2ATaskRecord): boolean {
  return !isTerminalExecutionStatus(record.execution.status);
}

function shouldFallbackToReconcile(
  result: SessionsSendA2ATaskSubscriptionResult | undefined,
): boolean {
  return result?.endedReason !== "terminal" || !isTerminalProtocolStatus(result.finalStatus);
}

function isTerminalProtocolStatus(status: A2ATaskProtocolStatus | undefined): boolean {
  return isTerminalExecutionStatus(status?.executionStatus);
}

export const __testing = {
  ...openClawA2ATesting,
  setAdapterFactoryForTest(createAdapter?: typeof defaultSessionsSendA2ADeps.createAdapter) {
    sessionsSendA2ADeps = createAdapter
      ? {
          ...defaultSessionsSendA2ADeps,
          createAdapter,
        }
      : defaultSessionsSendA2ADeps;
  },
  setAdapterSelectionForTest(
    overrides?: Partial<
      Pick<typeof defaultSessionsSendA2ADeps, "createBrokerAdapter" | "shouldUseBrokerAdapter">
    >,
  ) {
    sessionsSendA2ADeps = overrides
      ? {
          ...defaultSessionsSendA2ADeps,
          ...overrides,
        }
      : defaultSessionsSendA2ADeps;
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
    correlationId?: string;
    parentRunId?: string;
    cancelTarget?: A2ATaskCancelTarget;
  }) {
    return buildA2ATaskEnvelopeFromExchange({
      request: buildSessionsSendA2AExchangeRequest(params),
      taskId: params.waitRunId,
    });
  },
};
