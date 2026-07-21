import type { ReplyPayload } from "../../auto-reply/types.js";
import type { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

type MessageSendingHookResult = {
  cancelled: boolean;
  cancelReason?: string;
  hookMetadata?: Record<string, unknown>;
  contentRewritten: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
};

/** Runs the canonical final message policy pass before channel-owned preparation. */
export async function runMessageSendingHookForPayload(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  enabled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
  to: string;
  channel: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  sessionKey?: string;
}): Promise<MessageSendingHookResult> {
  if (!params.enabled) {
    return {
      cancelled: false,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
  try {
    const sendingResult = await params.hookRunner!.runMessageSending(
      {
        to: params.to,
        content: params.payloadSummary.hookContent ?? params.payloadSummary.text,
        replyToId: params.replyToId ?? undefined,
        threadId: params.threadId ?? undefined,
        metadata: {
          channel: params.channel,
          accountId: params.accountId,
          mediaUrls: params.payloadSummary.mediaUrls,
        },
      },
      {
        channelId: params.channel,
        accountId: params.accountId,
        conversationId: params.to,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      },
    );
    if (sendingResult?.cancel) {
      return {
        cancelled: true,
        ...(sendingResult.cancelReason ? { cancelReason: sendingResult.cancelReason } : {}),
        ...(sendingResult.metadata ? { hookMetadata: sendingResult.metadata } : {}),
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (sendingResult?.content == null) {
      return {
        cancelled: false,
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (params.payloadSummary.hookContent && !params.payloadSummary.text) {
      const spokenText = sendingResult.content;
      return {
        cancelled: false,
        contentRewritten: true,
        payload: { ...params.payload, spokenText },
        payloadSummary: { ...params.payloadSummary, hookContent: spokenText },
      };
    }
    const payload = { ...params.payload, text: sendingResult.content };
    return {
      cancelled: false,
      contentRewritten: true,
      payload,
      payloadSummary: { ...params.payloadSummary, text: sendingResult.content },
    };
  } catch {
    // Modifying plugin failures are non-blocking; native delivery keeps the prior payload.
    return {
      cancelled: false,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
}
