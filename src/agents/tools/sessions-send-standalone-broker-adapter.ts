import { z } from "zod";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createA2ATaskAcceptedEvent, createA2ATaskCreatedEvent } from "../a2a/events.js";
import { createA2ATaskEventLogSink, loadA2ATaskRecordFromEventLog } from "../a2a/log.js";
import {
  A2A_BROKER_ADAPTER_PLUGIN_ID,
  A2ABrokerClientError,
  buildBrokerCreateTaskRequestFromOpenClaw,
  createA2ABrokerClient,
  type A2ABrokerPartyRef,
  type A2ABrokerTaskRecord,
  type A2ABrokerTaskSseEvent,
} from "../a2a/standalone-broker-client.js";
import {
  isBrokerTaskTerminal,
  isBrokerTimeoutCode,
  isTerminalExecutionStatus,
  mapBrokerErrorToTaskError,
  mapBrokerStatusToDeliveryStatus,
  mapBrokerStatusToExecutionStatus,
  toEpochMs,
} from "../a2a/type-mapping.js";
import {
  applyA2ATaskProtocolCancel,
  applyA2ATaskProtocolUpdate,
  buildA2ATaskEnvelopeFromExchange,
  loadA2ATaskProtocolStatusById,
  type A2AExchangeRequest,
  type A2ATaskCancelResult,
  type A2ATaskCancelTarget,
  type A2ATaskProtocolStatus,
  type A2ATaskRecord,
} from "./sessions-send-broker.js";
import type {
  SessionsSendA2AAdapter,
  SessionsSendA2ATaskSubscriptionResult,
} from "./sessions-send-openclaw-adapter.js";

const defaultStandaloneBrokerAdapterDeps = {
  createClient: createA2ABrokerClient,
};

let standaloneBrokerAdapterDeps = defaultStandaloneBrokerAdapterDeps;

type StandaloneBrokerClient = ReturnType<typeof createA2ABrokerClient>;

const BROKER_PROTOCOL_ERROR_CODES = {
  malformedResponse: "broker_malformed_response",
  taskNotFound: "broker_task_not_found",
  authOrConfig: "broker_auth_or_config_error",
  transientFetch: "broker_transient_fetch_error",
  timeout: "broker_timeout",
  requestFailed: "broker_request_failed",
  remoteTaskFailed: "remote_task_failed",
} as const;

type StandaloneBrokerPluginConfig = {
  enabled: boolean;
  explicitlyActivated: boolean;
  baseUrl?: string;
  edgeSecret?: string;
  requester?: A2ABrokerPartyRef;
};

function resolveStandaloneBrokerPluginConfig(
  config?: OpenClawConfig,
): StandaloneBrokerPluginConfig {
  const plugins = config?.plugins;
  const entry = plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID];
  const pluginConfig = entry?.config;
  const allow = Array.isArray(plugins?.allow) ? plugins.allow : [];
  const deny = Array.isArray(plugins?.deny) ? plugins.deny : [];
  const allowlisted = allow.includes(A2A_BROKER_ADAPTER_PLUGIN_ID);
  const allowlistBlocked = allow.length > 0 && !allowlisted;
  const explicitlyEnabled = entry?.enabled === true;
  const disabled =
    plugins?.enabled === false ||
    deny.includes(A2A_BROKER_ADAPTER_PLUGIN_ID) ||
    entry?.enabled === false ||
    allowlistBlocked;

  return {
    enabled: !disabled,
    explicitlyActivated: !disabled && (explicitlyEnabled || allowlisted),
    baseUrl: readOptionalString(pluginConfig?.baseUrl),
    edgeSecret: readOptionalString(pluginConfig?.edgeSecret),
    requester: resolveRequester(pluginConfig?.requester),
  };
}

export function shouldUseStandaloneBrokerSessionsSendAdapter(cfg?: OpenClawConfig): boolean {
  const pluginConfig = resolveStandaloneBrokerPluginConfig(cfg);
  return pluginConfig.enabled && pluginConfig.explicitlyActivated && Boolean(pluginConfig.baseUrl);
}

export function createStandaloneBrokerSessionsSendA2AAdapter(params: {
  config: OpenClawConfig;
}): SessionsSendA2AAdapter {
  const client = createConfiguredBrokerClient(params.config);

  return {
    async runTaskRequest({ request, taskId }) {
      const brokerTask = await client.createTask(
        buildBrokerCreateTaskRequestFromOpenClaw({
          ...(taskId ? { taskId } : {}),
          ...(request.waitRunId ? { waitRunId: request.waitRunId } : {}),
          ...(request.correlationId ? { correlationId: request.correlationId } : {}),
          ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
          ...(request.requester?.sessionKey
            ? { requesterSessionKey: request.requester.sessionKey }
            : {}),
          ...(request.requester?.channel ? { requesterChannel: request.requester.channel } : {}),
          targetSessionKey: request.target.sessionKey,
          targetDisplayKey: request.target.displayKey,
          originalMessage: request.originalMessage,
          ...(request.roundOneReply ? { roundOneReply: request.roundOneReply } : {}),
          ...(request.cancelTarget ? { cancelTarget: request.cancelTarget } : {}),
          announceTimeoutMs: request.announceTimeoutMs,
          maxPingPongTurns: request.maxPingPongTurns,
        }),
      );

      await seedStandaloneBrokerTaskEventLog({
        request,
        brokerTask,
      });
      await reconcileStandaloneBrokerA2ATaskWithClient({
        client,
        sessionKey: request.target.sessionKey,
        taskId: brokerTask.id,
        brokerTask,
      });

      return (
        (await loadA2ATaskRecordFromEventLog({
          sessionKey: request.target.sessionKey,
          taskId: brokerTask.id,
        })) ?? mapBrokerTaskRecordToOpenClawTaskRecord({ request, taskId, brokerTask })
      );
    },

    reconcileTaskStatus({ sessionKey, taskId }) {
      return reconcileStandaloneBrokerA2ATaskWithClient({
        client,
        sessionKey,
        taskId,
      });
    },

    subscribeTaskStatus({ sessionKey, taskId, signal }) {
      return subscribeStandaloneBrokerA2ATaskWithClient({
        client,
        sessionKey,
        taskId,
        ...(signal ? { signal } : {}),
      });
    },

    cancelTask({ sessionKey, taskId, reason }) {
      return cancelStandaloneBrokerA2ATaskWithClient({
        client,
        sessionKey,
        taskId,
        reason,
      });
    },
  };
}

export async function reconcileStandaloneBrokerA2ATask(params: {
  config: OpenClawConfig;
  sessionKey: string;
  taskId: string;
}): Promise<A2ATaskProtocolStatus | undefined> {
  const client = createConfiguredBrokerClient(params.config);
  return reconcileStandaloneBrokerA2ATaskWithClient({
    client,
    sessionKey: params.sessionKey,
    taskId: params.taskId,
  });
}

export async function cancelStandaloneBrokerA2ATask(params: {
  config: OpenClawConfig;
  sessionKey: string;
  taskId: string;
  reason?: string;
}): Promise<A2ATaskCancelResult | undefined> {
  const client = createConfiguredBrokerClient(params.config);
  return cancelStandaloneBrokerA2ATaskWithClient(
    params.sessionKey,
    params.taskId,
    params.reason,
    client,
  );
}

export type SubscribeStandaloneBrokerA2ATaskResult = SessionsSendA2ATaskSubscriptionResult & {
  eventsSeen: number;
};

/**
 * Drives reconcile by consuming the broker's SSE event stream instead of
 * polling getTask on a fixed cadence. Each event triggers a single reconcile
 * call (which fetches a full broker task snapshot to fill in fields the SSE
 * projection does not carry, like claimedAt/completedAt).
 *
 * Returns when the stream emits a terminal event, when the stream ends, or
 * when the abort signal fires.
 */
export async function subscribeStandaloneBrokerA2ATask(params: {
  config: OpenClawConfig;
  sessionKey: string;
  taskId: string;
  signal?: AbortSignal;
  onEvent?: (event: A2ABrokerTaskSseEvent) => void;
  onStatus?: (status: A2ATaskProtocolStatus | undefined) => void;
}): Promise<SubscribeStandaloneBrokerA2ATaskResult> {
  const client = createConfiguredBrokerClient(params.config);
  return subscribeStandaloneBrokerA2ATaskWithClient({
    client,
    sessionKey: params.sessionKey,
    taskId: params.taskId,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
    ...(params.onStatus ? { onStatus: params.onStatus } : {}),
  });
}

async function subscribeStandaloneBrokerA2ATaskWithClient(params: {
  client: StandaloneBrokerClient;
  sessionKey: string;
  taskId: string;
  signal?: AbortSignal;
  onEvent?: (event: A2ABrokerTaskSseEvent) => void;
  onStatus?: (status: A2ATaskProtocolStatus | undefined) => void;
}): Promise<SubscribeStandaloneBrokerA2ATaskResult> {
  let eventsSeen = 0;
  let lastStatus: A2ATaskProtocolStatus | undefined;
  let endedReason: SubscribeStandaloneBrokerA2ATaskResult["endedReason"] = "stream_ended";

  try {
    for await (const event of params.client.streamTaskEvents(
      params.taskId,
      params.signal ? { signal: params.signal } : {},
    )) {
      eventsSeen += 1;
      params.onEvent?.(event);
      lastStatus = await reconcileStandaloneBrokerA2ATaskWithClient({
        client: params.client,
        sessionKey: params.sessionKey,
        taskId: params.taskId,
      });
      params.onStatus?.(lastStatus);
      if (event.data.final) {
        endedReason = "terminal";
        break;
      }
      if (params.signal?.aborted) {
        endedReason = "aborted";
        break;
      }
    }
  } catch (error) {
    if (params.signal?.aborted) {
      endedReason = "aborted";
    } else {
      throw error;
    }
  }

  return {
    finalStatus: lastStatus,
    eventsSeen,
    endedReason,
  };
}

async function cancelStandaloneBrokerA2ATaskWithClient(
  sessionKey: string,
  taskId: string,
  reason: string | undefined,
  client: StandaloneBrokerClient,
): Promise<A2ATaskCancelResult | undefined>;
async function cancelStandaloneBrokerA2ATaskWithClient(params: {
  client: StandaloneBrokerClient;
  sessionKey: string;
  taskId: string;
  reason?: string;
}): Promise<A2ATaskCancelResult | undefined>;
async function cancelStandaloneBrokerA2ATaskWithClient(
  sessionKeyOrParams:
    | string
    | {
        client: StandaloneBrokerClient;
        sessionKey: string;
        taskId: string;
        reason?: string;
      },
  taskIdArg?: string,
  reasonArg?: string,
  clientArg?: StandaloneBrokerClient,
): Promise<A2ATaskCancelResult | undefined> {
  const params =
    typeof sessionKeyOrParams === "string"
      ? {
          sessionKey: sessionKeyOrParams,
          taskId: taskIdArg ?? "",
          reason: reasonArg,
          client: clientArg as StandaloneBrokerClient,
        }
      : sessionKeyOrParams;

  const existing = await loadA2ATaskRecordFromEventLog({
    sessionKey: params.sessionKey,
    taskId: params.taskId,
  });
  if (!existing) {
    return undefined;
  }

  return applyA2ATaskProtocolCancel({
    sessionKey: params.sessionKey,
    cancel: {
      method: "a2a.task.cancel",
      taskId: params.taskId,
      correlationId: existing.envelope.trace?.correlationId,
      parentRunId: existing.envelope.trace?.parentRunId,
      reason: params.reason,
    },
    runtime: {
      async abortTask() {
        try {
          await params.client.cancelTask(
            params.taskId,
            params.reason ? { reason: params.reason } : {},
          );
          return {
            attempted: true,
            aborted: true,
            status: "aborted",
          } as const;
        } catch (error) {
          return {
            attempted: true,
            aborted: false,
            status: "error",
            errorMessage: formatErrorMessage(error),
          } as const;
        }
      },
      warn: () => {},
    },
  });
}

async function reconcileStandaloneBrokerA2ATaskWithClient(params: {
  client: StandaloneBrokerClient;
  sessionKey: string;
  taskId: string;
  brokerTask?: A2ABrokerTaskRecord;
}): Promise<A2ATaskProtocolStatus | undefined> {
  const existing = await loadA2ATaskRecordFromEventLog({
    sessionKey: params.sessionKey,
    taskId: params.taskId,
  });
  if (!existing) {
    return undefined;
  }

  if (isTerminalExecutionStatus(existing.execution.status) && !params.brokerTask) {
    return loadA2ATaskProtocolStatusById({
      sessionKey: params.sessionKey,
      taskId: params.taskId,
    });
  }

  let brokerTask = params.brokerTask;
  try {
    brokerTask ??= await params.client.getTask(params.taskId);
  } catch (error) {
    if (isTerminalExecutionStatus(existing.execution.status)) {
      return loadA2ATaskProtocolStatusById({
        sessionKey: params.sessionKey,
        taskId: params.taskId,
      });
    }

    const brokerError = classifyBrokerSyncError(error);
    if (
      existing.execution.status === "waiting_external" &&
      existing.execution.errorCode === brokerError.code &&
      existing.execution.errorMessage === brokerError.message
    ) {
      return loadA2ATaskProtocolStatusById({
        sessionKey: params.sessionKey,
        taskId: params.taskId,
      });
    }

    await applyA2ATaskProtocolUpdate({
      sessionKey: params.sessionKey,
      update: {
        method: "a2a.task.update",
        taskId: params.taskId,
        correlationId: existing.envelope.trace?.correlationId,
        parentRunId: existing.envelope.trace?.parentRunId,
        executionStatus: "waiting_external",
        error: {
          code: brokerError.code,
          message: brokerError.message,
        },
      },
    });

    return loadA2ATaskProtocolStatusById({
      sessionKey: params.sessionKey,
      taskId: params.taskId,
    });
  }

  const brokerUpdatedAt = toEpochMs(
    brokerTask.completedAt ?? brokerTask.updatedAt ?? brokerTask.claimedAt ?? brokerTask.createdAt,
  );
  const currentUpdatedAt = Math.max(
    existing.execution.completedAt ?? 0,
    existing.execution.updatedAt ?? 0,
    existing.execution.heartbeatAt ?? 0,
    existing.delivery.updatedAt ?? 0,
  );
  const mappedStatus = mapBrokerStatusToExecutionStatus({
    brokerStatus: brokerTask.status,
    brokerErrorCode: brokerTask.error?.code,
  });

  if (
    existing.execution.status === mappedStatus &&
    currentUpdatedAt >= brokerUpdatedAt &&
    (!isBrokerTaskTerminal(
      brokerTask.status as import("../a2a/type-mapping.js").BrokerTaskStatus,
    ) ||
      existing.delivery.status === mapBrokerStatusToDeliveryStatus(brokerTask.status))
  ) {
    return loadA2ATaskProtocolStatusById({
      sessionKey: params.sessionKey,
      taskId: params.taskId,
    });
  }

  const trace = {
    correlationId: existing.envelope.trace?.correlationId,
    parentRunId: existing.envelope.trace?.parentRunId,
  };
  const taskResult = buildTaskResult(brokerTask);
  const completedAt = toEpochMs(brokerTask.completedAt ?? brokerTask.updatedAt);
  const claimedAt = toEpochMs(brokerTask.claimedAt ?? brokerTask.updatedAt);

  if (brokerTask.status === "queued") {
    await applyA2ATaskProtocolUpdate({
      sessionKey: params.sessionKey,
      update: {
        method: "a2a.task.update",
        taskId: params.taskId,
        ...trace,
        executionStatus: "accepted",
        at: brokerUpdatedAt,
      },
    });
  }

  if (brokerTask.status === "claimed") {
    if ((existing.execution.heartbeatAt ?? 0) < claimedAt) {
      await applyA2ATaskProtocolUpdate({
        sessionKey: params.sessionKey,
        update: {
          method: "a2a.task.update",
          taskId: params.taskId,
          ...trace,
          executionStatus: "accepted",
          heartbeat: true,
          at: claimedAt,
        },
      });
    }
  }

  if (brokerTask.status === "running") {
    if (
      existing.execution.status !== "running" ||
      (existing.execution.startedAt ?? 0) < claimedAt
    ) {
      await applyA2ATaskProtocolUpdate({
        sessionKey: params.sessionKey,
        update: {
          method: "a2a.task.update",
          taskId: params.taskId,
          ...trace,
          executionStatus: "running",
          at: claimedAt,
        },
      });
    }
    if ((existing.execution.heartbeatAt ?? 0) < brokerUpdatedAt) {
      await applyA2ATaskProtocolUpdate({
        sessionKey: params.sessionKey,
        update: {
          method: "a2a.task.update",
          taskId: params.taskId,
          ...trace,
          heartbeat: true,
          at: brokerUpdatedAt,
        },
      });
    }
  }

  if (brokerTask.status === "succeeded") {
    await applyA2ATaskProtocolUpdate({
      sessionKey: params.sessionKey,
      update: {
        method: "a2a.task.update",
        taskId: params.taskId,
        ...trace,
        executionStatus: "completed",
        ...(taskResult?.summary ? { summary: taskResult.summary } : {}),
        ...(taskResult?.output !== undefined ? { output: taskResult.output } : {}),
        at: completedAt,
      },
    });
    await applyA2ATaskProtocolUpdate({
      sessionKey: params.sessionKey,
      update: {
        method: "a2a.task.update",
        taskId: params.taskId,
        ...trace,
        deliveryStatus: "skipped",
        at: brokerUpdatedAt,
      },
    });
  }

  if (brokerTask.status === "failed") {
    const executionStatus = isBrokerTimeoutCode(brokerTask.error?.code) ? "timed_out" : "failed";
    await applyA2ATaskProtocolUpdate({
      sessionKey: params.sessionKey,
      update: {
        method: "a2a.task.update",
        taskId: params.taskId,
        ...trace,
        executionStatus,
        error: {
          code:
            mapBrokerErrorToTaskError({
              brokerErrorCode: brokerTask.error?.code,
              brokerStatus: brokerTask.status,
            })?.code ?? BROKER_PROTOCOL_ERROR_CODES.remoteTaskFailed,
          ...(brokerTask.error?.message ? { message: brokerTask.error.message } : {}),
        },
        at: completedAt,
      },
    });
    await applyA2ATaskProtocolUpdate({
      sessionKey: params.sessionKey,
      update: {
        method: "a2a.task.update",
        taskId: params.taskId,
        ...trace,
        deliveryStatus: "skipped",
        at: brokerUpdatedAt,
      },
    });
  }

  if (brokerTask.status === "canceled") {
    await applyA2ATaskProtocolCancel({
      sessionKey: params.sessionKey,
      cancel: {
        method: "a2a.task.cancel",
        taskId: params.taskId,
        ...trace,
        reason: brokerTask.error?.message ?? brokerTask.result?.note,
        at: completedAt,
      },
    });
    await applyA2ATaskProtocolUpdate({
      sessionKey: params.sessionKey,
      update: {
        method: "a2a.task.update",
        taskId: params.taskId,
        ...trace,
        deliveryStatus: "skipped",
        at: brokerUpdatedAt,
      },
    });
  }

  return loadA2ATaskProtocolStatusById({
    sessionKey: params.sessionKey,
    taskId: params.taskId,
  });
}

async function seedStandaloneBrokerTaskEventLog(params: {
  request: A2AExchangeRequest;
  brokerTask: A2ABrokerTaskRecord;
}): Promise<void> {
  const existing = await loadA2ATaskRecordFromEventLog({
    sessionKey: params.request.target.sessionKey,
    taskId: params.brokerTask.id,
  });
  if (existing) {
    return;
  }

  const record = mapBrokerTaskRecordToOpenClawTaskRecord({
    request: params.request,
    taskId: params.request.waitRunId,
    brokerTask: params.brokerTask,
  });
  const sink = createA2ATaskEventLogSink({
    sessionKey: params.request.target.sessionKey,
    taskId: params.brokerTask.id,
  });
  await sink.append(
    createA2ATaskCreatedEvent({
      envelope: record.envelope,
      at: record.execution.createdAt,
    }),
  );
  await sink.append(
    createA2ATaskAcceptedEvent({
      taskId: record.taskId,
      at: record.execution.acceptedAt ?? record.execution.createdAt,
    }),
  );
}

function createConfiguredBrokerClient(config: OpenClawConfig): StandaloneBrokerClient {
  const pluginConfig = resolveStandaloneBrokerPluginConfig(config);
  if (!pluginConfig.enabled) {
    throw new Error(
      "Standalone A2A broker adapter is disabled; falling back requires shouldUseStandaloneBrokerSessionsSendAdapter() to gate selection",
    );
  }
  if (!pluginConfig.baseUrl) {
    throw new Error(
      "Standalone A2A broker adapter requires plugins.entries.a2a-broker-adapter.config.baseUrl",
    );
  }

  return standaloneBrokerAdapterDeps.createClient({
    baseUrl: pluginConfig.baseUrl,
    ...(pluginConfig.edgeSecret ? { edgeSecret: pluginConfig.edgeSecret } : {}),
    ...(pluginConfig.requester ? { requester: pluginConfig.requester } : {}),
  });
}

export function mapBrokerTaskRecordToOpenClawTaskRecord(params: {
  request: A2AExchangeRequest;
  taskId?: string;
  brokerTask: A2ABrokerTaskRecord;
}): A2ATaskRecord {
  const { request, brokerTask } = params;
  const payload = readBrokerTaskPayload(brokerTask);
  const normalizedRequest: A2AExchangeRequest = {
    requester: payload.requesterSessionKey
      ? {
          sessionKey: payload.requesterSessionKey,
          displayKey: request.requester?.displayKey ?? payload.requesterSessionKey,
          channel: request.requester?.channel ?? payload.requesterChannel,
        }
      : request.requester,
    target: {
      sessionKey: payload.targetSessionKey ?? request.target.sessionKey,
      displayKey: payload.targetDisplayKey ?? request.target.displayKey,
      ...(request.target.channel ? { channel: request.target.channel } : {}),
    },
    originalMessage: request.originalMessage,
    announceTimeoutMs: request.announceTimeoutMs,
    maxPingPongTurns: request.maxPingPongTurns,
    roundOneReply: request.roundOneReply,
    waitRunId: payload.waitRunId ?? request.waitRunId ?? params.taskId,
    correlationId: payload.correlationId ?? request.correlationId ?? params.taskId,
    parentRunId: payload.parentRunId ?? request.parentRunId ?? request.waitRunId ?? params.taskId,
    cancelTarget: payload.cancelTarget ?? request.cancelTarget,
  };
  const envelope = buildA2ATaskEnvelopeFromExchange({
    request: normalizedRequest,
    taskId: brokerTask.id,
    correlationId: normalizedRequest.correlationId,
  });
  const taskResult = buildTaskResult(brokerTask);
  return {
    taskId: brokerTask.id,
    envelope: {
      ...envelope,
      taskId: brokerTask.id,
      runtime: {
        ...envelope.runtime,
        cancelTarget: normalizedRequest.cancelTarget ??
          envelope.runtime?.cancelTarget ?? {
            kind: "session_run",
            sessionKey: normalizedRequest.target.sessionKey,
            ...(normalizedRequest.waitRunId ? { runId: normalizedRequest.waitRunId } : {}),
          },
      },
    },
    execution: {
      status: mapBrokerStatusToExecutionStatus({
        brokerStatus: brokerTask.status,
        brokerErrorCode: brokerTask.error?.code,
      }),
      createdAt: toEpochMs(brokerTask.createdAt),
      acceptedAt: toEpochMs(brokerTask.createdAt),
      ...(brokerTask.claimedAt ? { startedAt: toEpochMs(brokerTask.claimedAt) } : {}),
      updatedAt: toEpochMs(brokerTask.updatedAt),
      ...(brokerTask.completedAt ? { completedAt: toEpochMs(brokerTask.completedAt) } : {}),
      ...(() => {
        const e = mapBrokerErrorToTaskError({
          brokerErrorCode: brokerTask.error?.code,
          brokerStatus: brokerTask.status,
        });
        return e ? { errorCode: e.code } : {};
      })(),
      ...(brokerTask.error?.message ? { errorMessage: brokerTask.error.message } : {}),
    },
    delivery: {
      status: mapBrokerStatusToDeliveryStatus(brokerTask.status),
      mode: "announce",
      updatedAt: toEpochMs(brokerTask.updatedAt),
    },
    ...(taskResult ? { result: taskResult } : {}),
  };
}

function buildTaskResult(brokerTask: A2ABrokerTaskRecord): A2ATaskRecord["result"] | undefined {
  if (!brokerTask.result) {
    return undefined;
  }
  const output = buildTaskOutput(brokerTask);
  const summary = brokerTask.result.summary ?? brokerTask.result.note;
  if (!summary && output === undefined) {
    return undefined;
  }
  return {
    ...(summary ? { summary } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function buildTaskOutput(brokerTask: A2ABrokerTaskRecord): unknown {
  const result = brokerTask.result;
  if (!result) {
    return undefined;
  }

  const output: Record<string, unknown> = {
    ...(isPlainRecord(result.output) ? result.output : {}),
    ...(result.note ? { note: result.note } : {}),
    ...(result.artifactIds?.length ? { artifactIds: result.artifactIds } : {}),
    ...(result.validation ? { validation: result.validation } : {}),
    ...(result.apply ? { apply: result.apply } : {}),
    status: brokerTask.status,
  };

  return Object.keys(output).length > 0 ? output : undefined;
}

function classifyBrokerSyncError(error: unknown): { code: string; message: string } {
  if (error instanceof z.ZodError || (error instanceof Error && error.name === "ZodError")) {
    return {
      code: BROKER_PROTOCOL_ERROR_CODES.malformedResponse,
      message: formatErrorMessage(error),
    };
  }
  if (isTimeoutError(error)) {
    return {
      code: BROKER_PROTOCOL_ERROR_CODES.timeout,
      message: formatErrorMessage(error),
    };
  }
  if (error instanceof A2ABrokerClientError) {
    if (error.status === 404) {
      return {
        code: BROKER_PROTOCOL_ERROR_CODES.taskNotFound,
        message: error.message,
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        code: BROKER_PROTOCOL_ERROR_CODES.authOrConfig,
        message: error.message,
      };
    }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return {
        code: BROKER_PROTOCOL_ERROR_CODES.transientFetch,
        message: error.message,
      };
    }
    return {
      code: BROKER_PROTOCOL_ERROR_CODES.requestFailed,
      message: error.message,
    };
  }
  if (isTransientBrokerFetchError(error)) {
    return {
      code: BROKER_PROTOCOL_ERROR_CODES.transientFetch,
      message: formatErrorMessage(error),
    };
  }
  return {
    code: BROKER_PROTOCOL_ERROR_CODES.requestFailed,
    message: formatErrorMessage(error),
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const name = error.name.trim().toLowerCase();
  const message = error.message.trim().toLowerCase();
  return (
    name === "aborterror" ||
    name === "timeouterror" ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

function isTransientBrokerFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const name = error.name.trim().toLowerCase();
  const message = error.message.trim().toLowerCase();
  return (
    name === "typeerror" ||
    message.includes("fetch") ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("connection") ||
    message.includes("econn") ||
    message.includes("eai_")
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveRequester(value: unknown): A2ABrokerPartyRef | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = readOptionalString(record.id);
  if (!id) {
    return undefined;
  }
  const kind = readOptionalString(record.kind) as A2ABrokerPartyRef["kind"] | undefined;
  const role = readOptionalString(record.role) as A2ABrokerPartyRef["role"] | undefined;
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(role ? { role } : {}),
  };
}

type BrokerTaskPayload = {
  taskId?: string;
  waitRunId?: string;
  correlationId?: string;
  parentRunId?: string;
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey?: string;
  targetDisplayKey?: string;
  cancelTarget?: A2ATaskCancelTarget;
};

function readBrokerTaskPayload(brokerTask: A2ABrokerTaskRecord): BrokerTaskPayload {
  const payload = isPlainRecord(brokerTask.payload) ? brokerTask.payload : {};
  return {
    taskId: readOptionalString(payload.taskId),
    waitRunId: readOptionalString(payload.waitRunId),
    correlationId: readOptionalString(payload.correlationId),
    parentRunId: readOptionalString(payload.parentRunId),
    requesterSessionKey: readOptionalString(payload.requesterSessionKey),
    requesterChannel: readOptionalString(payload.requesterChannel),
    targetSessionKey: readOptionalString(payload.targetSessionKey),
    targetDisplayKey: readOptionalString(payload.targetDisplayKey),
    cancelTarget: readBrokerTaskCancelTarget(payload.cancelTarget),
  };
}

function readBrokerTaskCancelTarget(value: unknown): A2ATaskCancelTarget | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "session_run") {
    return undefined;
  }
  const sessionKey = readOptionalString(record.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const runId = readOptionalString(record.runId);
  return {
    kind: "session_run",
    sessionKey,
    ...(runId ? { runId } : {}),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const __testing = {
  setCreateClientForTest(createClient?: typeof createA2ABrokerClient) {
    standaloneBrokerAdapterDeps = createClient
      ? {
          ...defaultStandaloneBrokerAdapterDeps,
          createClient,
        }
      : defaultStandaloneBrokerAdapterDeps;
  },
};
