import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "../auto-reply/reply/get-reply-run-queue.js";
import type { RestartSentinelContinuation } from "../infra/restart-sentinel.js";
import type {
  QueuedSessionDelivery,
  QueuedSessionDeliveryPayload,
  SessionDeliveryRoute,
} from "../infra/session-delivery-queue.records.js";
import type { OutboundReplyPayload } from "../plugin-sdk/reply-payload.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";

export const RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS = 20;
export const RESTART_CONTINUATION_BUSY_RETRY_ERROR =
  "restart continuation deferred because previous run is still shutting down";

type QueuedAgentTurnSessionDelivery = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;

export function isRestartContinuationBusyPayload(payload: OutboundReplyPayload): boolean {
  return (
    typeof payload.text === "string" && payload.text.trim() === REPLY_RUN_STILL_SHUTTING_DOWN_TEXT
  );
}

export function isRestartContinuationBusyRetry(entry: QueuedSessionDelivery | null): boolean {
  return entry?.lastError === RESTART_CONTINUATION_BUSY_RETRY_ERROR;
}

export function resolveQueuedRestartContinuationMessageId(
  entry: QueuedAgentTurnSessionDelivery,
): string {
  if (isRestartContinuationBusyRetry(entry) && entry.retryCount > 0) {
    return `${entry.messageId}:retry:${entry.retryCount}`;
  }
  return entry.messageId;
}

const buildRestartContinuationMessageId = (params: {
  sessionKey: string;
  kind: RestartSentinelContinuation["kind"];
  revision: number;
}) => `restart-sentinel:${params.sessionKey}:${params.kind}:${params.revision}`;

export function buildQueuedRestartContinuation(params: {
  sessionKey: string;
  agentId?: string;
  continuation: RestartSentinelContinuation;
  route?: SessionDeliveryRoute;
  expectedSessionId?: string | undefined;
  revision: number;
  deliveryContext?: DeliveryContext;
  idempotencyKey?: string;
}): QueuedSessionDeliveryPayload {
  const idempotencyKey =
    params.idempotencyKey ??
    buildRestartContinuationMessageId({
      sessionKey: params.sessionKey,
      kind: params.continuation.kind,
      revision: params.revision,
    });
  if (params.continuation.kind === "systemEvent") {
    return {
      kind: "systemEvent",
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      text: params.continuation.text,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      idempotencyKey,
      maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
      completionRetention: "permanent",
    };
  }
  return {
    kind: "agentTurn",
    sessionKey: params.sessionKey,
    message: params.continuation.message,
    messageId: idempotencyKey,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
    completionRetention: "permanent",
    ...(params.route ? { route: params.route } : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    idempotencyKey,
  };
}
