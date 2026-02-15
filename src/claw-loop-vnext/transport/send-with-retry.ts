import type { LoopEvent } from "../types.js";
import type { LoopTransport, SendMessageRequest, SendMessageResult } from "./types.js";

export type SendWithRetryParams = {
  primary: LoopTransport;
  fallback?: LoopTransport;
  request: SendMessageRequest;
  maxRetries: number;
  onEvent: (event: LoopEvent) => Promise<void>;
};

export async function sendWithRetry(params: SendWithRetryParams): Promise<SendMessageResult> {
  const { primary, fallback, request, maxRetries, onEvent } = params;

  for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt += 1) {
    await onEvent({
      at: new Date().toISOString(),
      goalId: request.goalId,
      type: "message_send_attempt",
      data: { attempt, transport: primary.kind, idempotencyKey: request.idempotencyKey },
    });

    const primaryResult = await primary.sendMessage(request);
    if (primaryResult.delivered) {
      await onEvent({
        at: new Date().toISOString(),
        goalId: request.goalId,
        type: "message_send_ack",
        data: { transport: primary.kind, ackId: primaryResult.ackId, attempt },
      });
      return primaryResult;
    }

    await onEvent({
      at: new Date().toISOString(),
      goalId: request.goalId,
      type: "message_send_failed",
      data: { transport: primary.kind, reason: primaryResult.reason, attempt },
    });
  }

  if (!fallback) {
    return {
      delivered: false,
      transport: primary.kind,
      outputText: "",
      reason: "primary transport failed and no fallback is configured",
    };
  }

  await onEvent({
    at: new Date().toISOString(),
    goalId: request.goalId,
    type: "transport_fallback",
    data: { from: primary.kind, to: fallback.kind },
  });

  return fallback.sendMessage(request);
}
