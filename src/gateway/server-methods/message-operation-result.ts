import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { isChannelPartialDeliveryError } from "../../channels/turn/partial-delivery-error.js";
import { OutboundHandoffRejectedError } from "../../infra/outbound/deliver-handoff.js";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import { mirrorDeliveredSourceReplyToTranscript } from "../../infra/outbound/source-reply-mirror.js";
import { LocalMediaAccessError } from "../../media/local-media-access.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayInflightResult } from "./inflight.js";
import type { GatewayRequestContext } from "./types.js";

export function buildGatewayDeliveryPayload(params: {
  runId: string;
  channel: string;
  result: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    runId: params.runId,
    messageId: params.result.messageId,
    channel: params.channel,
  };
  const optionalKeys = ["chatId", "channelId", "toJid", "conversationId", "pollId"] as const;
  for (const key of optionalKeys) {
    if (key in params.result) {
      payload[key] = params.result[key];
    }
  }
  return payload;
}

export function createGatewayInflightResult(params: {
  context: GatewayRequestContext;
  dedupeKey: string | undefined;
  channel: string;
  result: Pick<GatewayInflightResult, "ok" | "payload" | "error">;
  meta?: Record<string, unknown>;
}): GatewayInflightResult {
  if (params.dedupeKey !== undefined) {
    params.context.dedupe.set(params.dedupeKey, { ts: Date.now(), ...params.result });
  }
  return {
    ...params.result,
    meta: { channel: params.channel, ...params.meta },
  };
}

export function createGatewayInflightSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string | undefined;
  payload: unknown;
  channel: string;
}): GatewayInflightResult {
  return createGatewayInflightResult({ ...params, result: { ok: true, payload: params.payload } });
}

export function createGatewayInflightFailure(
  params: {
    context: GatewayRequestContext;
    dedupeKey: string | undefined;
    channel: string;
    err: unknown;
  },
  isAuthorized: () => boolean,
): GatewayInflightResult {
  if (!isChannelPartialDeliveryError(params.err) && !isAuthorized()) {
    return createGatewayInflightAuthorityFailure(params);
  }
  // Preserve ingress-policy errors only when delivery has no accepted effect or queue custody.
  const unsentError =
    params.err instanceof OutboundDeliveryError &&
    !params.err.sentBeforeError &&
    params.err.queueCustody !== "held"
      ? params.err.cause
      : params.err;
  const authorizationError =
    unsentError instanceof OutboundHandoffRejectedError ? unsentError.cause : unsentError;
  if (authorizationError instanceof SessionMutationAuthorizationChangedError) {
    return createGatewayInflightResult({
      ...params,
      result: { ok: false, error: authorizationError.error },
    });
  }
  // A local media path refused by the allowlist fails before any provider send.
  // Report it as a validation error: UNAVAILABLE reads as "may have been sent",
  // which keeps a terminal reply's delivery intent pending and makes every later
  // send in the turn (a corrected path, or plain text) return delivery_ambiguous.
  const provedUnsent = unsentError !== params.err || params.err instanceof LocalMediaAccessError;
  const mediaRejection = provedUnsent ? findLocalMediaAccessError(unsentError) : undefined;
  if (mediaRejection) {
    return createGatewayInflightResult({
      ...params,
      result: {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, mediaRejection.message),
      },
      meta: { error: formatForLog(params.err) },
    });
  }
  // A channel partial-delivery error carries the receipt of the part that was
  // already delivered (e.g. a caption sent before the media upload failed).
  // Preserve it on the structured error and mark the result non-retryable so
  // the agent does not resend an already-visible message; `String(err)` alone
  // would drop the receipt and invite a duplicate delivery on retry.
  const partialDelivery = isChannelPartialDeliveryError(params.err)
    ? params.err.deliveryResult
    : undefined;
  const queuedDelivery =
    !partialDelivery &&
    params.err instanceof OutboundDeliveryError &&
    params.err.queueCustody === "held";
  const error = errorShape(
    ErrorCodes.UNAVAILABLE,
    String(params.err),
    partialDelivery
      ? { details: { partialDelivery }, retryable: false }
      : queuedDelivery
        ? { details: { code: GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED } }
        : undefined,
  );
  return createGatewayInflightResult({
    ...params,
    result: { ok: false, error },
    meta: { error: formatForLog(params.err) },
  });
}

export function createGatewayInflightAuthorityFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string | undefined;
  channel: string;
}): GatewayInflightResult {
  return createGatewayInflightResult({
    ...params,
    result: {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime authority is no longer active"),
    },
  });
}

const sourceReplyTranscriptMirrorQueue = new KeyedAsyncQueue();

export function scheduleDeliveredSourceReplyTranscriptMirror(params: {
  context: GatewayRequestContext;
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0];
}): Promise<void> {
  // Missing session keys serialize together so global mirrors preserve delivery order.
  const queueKey = params.mirror.sessionKey?.trim() || "__global__";
  // Queue per session so current-conversation source replies are visible before
  // a following turn can read the transcript.
  return sourceReplyTranscriptMirrorQueue.enqueue(queueKey, async () => {
    try {
      const mirrored = await mirrorDeliveredSourceReplyToTranscript(params.mirror);
      if (!mirrored && params.mirror.sourceReplyFinal === true) {
        params.context.logGateway?.warn?.(
          "Terminal source reply receipt was not mirrored; restart recovery is fail-closed.",
          {
            channel: params.mirror.channel,
            sessionKey: params.mirror.sessionKey,
          },
        );
      }
    } catch (err) {
      params.context.logGateway?.warn?.("Source reply transcript mirror failed after delivery.", {
        error: formatForLog(err),
        channel: params.mirror.channel,
        sessionKey: params.mirror.sessionKey,
      });
    }
  });
}

function findLocalMediaAccessError(error: unknown): LocalMediaAccessError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof LocalMediaAccessError) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}
