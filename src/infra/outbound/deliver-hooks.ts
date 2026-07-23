// Applies outbound hooks and shapes stable delivery outcomes/errors.
import { runReplyPayloadSendingHook } from "../../auto-reply/reply/reply-payload-sending-hook.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../../hooks/message-hook-mappers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { formatErrorMessage } from "../errors.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryFailureStage,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
  type OutboundPayloadDeliverySuppressionReason,
} from "./deliver-types.js";
import type { QueuedReplyPayloadSendingHook } from "./delivery-queue.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import type { OutboundChannel } from "./targets.js";

const log = createSubsystemLogger("outbound/deliver");

type MessageSentEvent = {
  success: boolean;
  content: string;
  error?: string;
  messageId?: string;
};

/**
 * Best-effort session identifier for delivery telemetry only. Falls back to
 * `policyKey` as a last resort so diagnostic emission still has a stable
 * string when neither mirror nor canonical key are available. **Do not use
 * this value for hook-context correlation** — use `sessionKeyForInternalHooks`
 * (mirror.sessionKey ?? session.key, no policyKey fallback) instead, so we
 * never accidentally hand the policy key to plugins that expect the canonical
 * session key.
 */
export function createMessageSentEmitter(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
}): { emitMessageSent: (event: MessageSentEvent) => void; hasMessageSentHooks: boolean } {
  const hasMessageSentHooks = params.hookRunner?.hasHooks("message_sent") ?? false;
  const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
  const emitMessageSent = (event: MessageSentEvent) => {
    if (!hasMessageSentHooks && !canEmitInternalHook) {
      return;
    }
    const canonical = buildCanonicalSentMessageHookContext({
      to: params.to,
      content: event.content,
      success: event.success,
      error: event.error,
      channelId: params.channel,
      accountId: params.accountId ?? undefined,
      conversationId: params.to,
      // Mirror the canonical outbound session key into the `message_sent`
      // hook context so plugins that observe both `message_sending` and
      // `message_sent` see the same `sessionKey` (and so it matches the
      // value the internal `message:sent` hook fires with). The value is
      // already computed for the internal hook below; reusing it here
      // keeps the contract documented in `PluginHookMessageContext`
      // honest for both outbound delivery hooks.
      sessionKey: params.sessionKeyForInternalHooks,
      messageId: event.messageId,
      isGroup: params.mirrorIsGroup,
      groupId: params.mirrorGroupId,
    });
    if (hasMessageSentHooks) {
      fireAndForgetHook(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
        "deliverOutboundPayloads: message_sent plugin hook failed",
        (message) => {
          log.warn(message);
        },
      );
    }
    if (!canEmitInternalHook) {
      return;
    }
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "sent",
          params.sessionKeyForInternalHooks!,
          toInternalMessageSentContext(canonical),
        ),
      ),
      "deliverOutboundPayloads: message:sent internal hook failed",
      (message) => {
        log.warn(message);
      },
    );
  };
  return { emitMessageSent, hasMessageSentHooks };
}

export async function applyMessageSendingHook(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  enabled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
  to: string;
  channel: Exclude<OutboundChannel, "none">;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  sessionKey?: string;
}): Promise<{
  cancelled: boolean;
  cancelReason?: string;
  hookMetadata?: Record<string, unknown>;
  contentRewritten: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
}> {
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
        accountId: params.accountId ?? undefined,
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
        payload: {
          ...params.payload,
          spokenText,
        },
        payloadSummary: {
          ...params.payloadSummary,
          hookContent: spokenText,
        },
      };
    }
    const payload = {
      ...params.payload,
      text: sendingResult.content,
    };
    return {
      cancelled: false,
      contentRewritten: true,
      payload,
      payloadSummary: {
        ...params.payloadSummary,
        text: sendingResult.content,
      },
    };
  } catch {
    // Don't block delivery on hook failure.
    return {
      cancelled: false,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
}

export async function applyReplyPayloadSendingHook(params: {
  hook: QueuedReplyPayloadSendingHook | undefined;
  payload: ReplyPayload;
}): Promise<{
  cancelled: boolean;
  payload: ReplyPayload;
  changed: boolean;
}> {
  if (!params.hook) {
    return { cancelled: false, payload: params.payload, changed: false };
  }
  const nextPayload = await runReplyPayloadSendingHook({
    payload: params.payload,
    kind: params.hook.kind,
    ...(params.hook.channel ? { channel: params.hook.channel } : {}),
    ...(params.hook.sessionKey ? { sessionKey: params.hook.sessionKey } : {}),
    ...(params.hook.runId ? { runId: params.hook.runId } : {}),
    context: params.hook.context,
  });
  if (!nextPayload) {
    return { cancelled: true, payload: params.payload, changed: false };
  }
  return {
    cancelled: false,
    payload: nextPayload,
    changed: nextPayload !== params.payload,
  };
}

export function toOutboundDeliveryError(params: {
  error: unknown;
  results: readonly OutboundDeliveryResult[];
  payloadOutcomes: readonly OutboundPayloadDeliveryOutcome[];
  stage: OutboundDeliveryFailureStage;
}): OutboundDeliveryError {
  if (params.error instanceof OutboundDeliveryError) {
    return params.error;
  }
  return new OutboundDeliveryError(formatErrorMessage(params.error), {
    cause: params.error,
    results: params.results,
    payloadOutcomes: params.payloadOutcomes,
    stage: params.stage,
  });
}

export function suppressedPayloadOutcome(params: {
  index: number;
  reason: OutboundPayloadDeliverySuppressionReason;
  hookEffect?: {
    cancelReason?: string;
    metadata?: Record<string, unknown>;
  };
}): OutboundPayloadDeliveryOutcome {
  return {
    index: params.index,
    status: "suppressed",
    reason: params.reason,
    ...(params.hookEffect ? { hookEffect: params.hookEffect } : {}),
  };
}

/** Adds directive-derived media to the queue copy before spool custody. */
