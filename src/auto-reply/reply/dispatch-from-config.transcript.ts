import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { recordDeliveredCommandExchange } from "../../config/sessions/command-transcript.js";
import type { SessionTranscriptDeliveryMirror } from "../../config/sessions/transcript-mirror.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

type TranscriptMirror = NonNullable<ReplyPayloadMetadata["sourceReplyTranscriptMirror"]> & {
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
  storePath?: string;
  preferText?: boolean;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  commandText?: string;
  commandId?: string;
};

export function scopeCommandTranscriptId(
  messageId: string | undefined,
  context: { channelId?: string; accountId?: string; conversationId?: string },
): string | undefined {
  return messageId
    ? JSON.stringify([
        context.channelId ?? "",
        context.accountId ?? "",
        context.conversationId ?? "",
        messageId,
      ])
    : undefined;
}

function transcriptMirrorExpectations(mirror: TranscriptMirror) {
  return {
    ...(mirror.expectedSessionId ? { expectedSessionId: mirror.expectedSessionId } : {}),
    ...(mirror.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: mirror.expectedLifecycleRevision }
      : {}),
    ...(mirror.expectedWriterRunId !== undefined
      ? { expectedWriterRunId: mirror.expectedWriterRunId }
      : {}),
  };
}

export async function mirrorDeliveredReplyToTranscript(params: {
  metadata?: TranscriptMirror;
  cfg: OpenClawConfig;
}): Promise<void> {
  const mirror = params.metadata;
  if (!mirror || mirror.transcriptOwner) {
    return;
  }
  try {
    if (mirror.commandText && mirror.commandId && mirror.text) {
      await recordDeliveredCommandExchange({
        sessionKey: mirror.sessionKey,
        agentId: mirror.agentId,
        ...transcriptMirrorExpectations(mirror),
        storePath: mirror.storePath,
        config: params.cfg,
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        commandText: mirror.commandText,
        commandId: mirror.commandId,
        replyText: mirror.text,
        replyId: mirror.idempotencyKey ?? mirror.text,
      });
      return;
    }
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: mirror.sessionKey,
      agentId: mirror.agentId,
      ...transcriptMirrorExpectations(mirror),
      text: mirror.text,
      mediaUrls: mirror.preferText && mirror.text ? undefined : mirror.mediaUrls,
      idempotencyKey: mirror.idempotencyKey,
      ...(mirror.deliveryMirror ? { deliveryMirror: mirror.deliveryMirror } : {}),
      ...(mirror.storePath ? { storePath: mirror.storePath } : {}),
      updateMode: "inline",
      config: params.cfg,
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: transcript mirror skipped: ${result.reason}`);
    }
  } catch (error) {
    logVerbose(
      `dispatch-from-config: transcript mirror failed after delivery: ${formatErrorMessage(error)}`,
    );
  }
}

export function transcriptMirrorForDeliveredPayload(
  metadata: TranscriptMirror,
  payload: ReplyPayload,
): TranscriptMirror | undefined {
  const sendable = resolveSendableOutboundReplyParts(payload);
  if (!sendable.text && sendable.mediaUrls.length === 0) {
    return undefined;
  }
  return {
    ...metadata,
    text: sendable.text,
    mediaUrls: sendable.mediaUrls.length > 0 ? sendable.mediaUrls : undefined,
  };
}

export function captureDeliveredTranscriptMirror(params: {
  dispatcher: ReplyDispatcher;
  metadata?: TranscriptMirror;
  captureToken?: object;
  kind?: "block" | "final";
}): () => TranscriptMirror | undefined {
  if (!params.metadata || !params.dispatcher.appendBeforeDeliver) {
    return () => (params.metadata?.transcriptOwner ? undefined : params.metadata);
  }
  const metadata = params.metadata;
  let deliveredMetadata: TranscriptMirror | undefined;
  let observedFinal = false;
  const { idempotencyKey, sessionKey } = metadata;
  params.dispatcher.appendBeforeDeliver((payload, info) => {
    if (info.kind !== (params.kind ?? "final")) {
      return payload;
    }
    const payloadMetadata = getReplyPayloadMetadata(payload);
    if (payloadMetadata?.finalDeliveryCapture !== params.captureToken) {
      return payload;
    }
    observedFinal = true;
    const payloadMirror = payloadMetadata?.sourceReplyTranscriptMirror;
    if (
      payloadMirror &&
      payloadMirror.idempotencyKey === idempotencyKey &&
      payloadMirror.sessionKey === sessionKey
    ) {
      deliveredMetadata = transcriptMirrorForDeliveredPayload(
        {
          ...payloadMirror,
          ...transcriptMirrorExpectations(metadata),
          storePath: metadata.storePath,
        },
        payload,
      );
    } else if (
      !payloadMirror &&
      !metadata.transcriptOwner &&
      (!idempotencyKey || metadata.deliveryMirror || metadata.commandId)
    ) {
      deliveredMetadata = transcriptMirrorForDeliveredPayload(metadata, payload);
    }
    return payload;
  });
  return () =>
    observedFinal ? deliveredMetadata : metadata.transcriptOwner ? undefined : metadata;
}
