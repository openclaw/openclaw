import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  pluginEnvelopeHas,
  projectEmbeddedMessageDeliveryFact,
  projectPluginMessageDeliveryFact,
} from "../../agents/embedded-agent-message-delivery.js";
import { isMessagingToolDeliveryAction } from "../../agents/embedded-agent-messaging.js";
import { throwIfAborted } from "./abort.js";
import {
  resolveMessageActionOutcome,
  type MessageActionResult,
  type ResolvedActionContext,
} from "./message-action-contracts.js";
import { isDeliveredCurrentSourceReplyAsync } from "./source-reply-mirror.js";

export function hasAcceptedMessageActionResult(
  result: MessageActionResult,
  acceptOwnerConfirmedMutation = false,
): boolean {
  if (
    result.kind === "broadcast" ||
    result.dryRun ||
    !isMessagingToolDeliveryAction("message", { action: result.action })
  ) {
    return false;
  }
  const values = [result.payload, result.toolResult];
  const envelopes = values.map(projectPluginMessageDeliveryFact);
  const delivery = projectEmbeddedMessageDeliveryFact(result, true);
  if (
    delivery?.status === "dryRun" ||
    envelopes.some((envelope) => envelope?.status === "dryRun")
  ) {
    return false;
  }
  if (!resolveMessageActionOutcome(result).ok) {
    return delivery?.partialDelivery || envelopes.some((envelope) => envelope?.partialDelivery);
  }
  if (
    values.some((value) => pluginEnvelopeHas(value, "failure")) ||
    envelopes.some(
      (envelope) => envelope && (envelope.status !== "settled" || envelope.partialDelivery),
    ) ||
    (result.handledBy === "plugin" && !pluginEnvelopeHas(result.payload, "ok"))
  ) {
    return false;
  }
  const ownerConfirmedMutation =
    acceptOwnerConfirmedMutation &&
    result.kind === "action" &&
    result.handledBy === "plugin" &&
    pluginEnvelopeHas(result.payload, "ok");
  return (
    delivery?.status === "settled" &&
    !delivery.partialDelivery &&
    ((result.kind === "send" &&
      result.handledBy === "core" &&
      result.sendResult?.deliveryStatus === "sent") ||
      (delivery.primaryPlatformMessageId &&
        delivery.primaryPlatformMessageId.toLowerCase() !== "unknown") ||
      ownerConfirmedMutation)
  );
}

export async function annotateSourceDelivery<T extends MessageActionResult>(
  result: T,
  ctx: ResolvedActionContext,
  replyToIsExplicit: boolean,
): Promise<T> {
  // Current-source identity comes from the authorized route and delivery receipt,
  // not the reply mode; automatic runs also use this marker to avoid false fallbacks.
  const authorization = ctx.input.messageActionAuthorization;
  if (result.kind === "broadcast" || !authorization?.toolContext) {
    return result;
  }
  const mirrorParams = {
    action: result.action,
    channel: ctx.channel,
    actionParams: ctx.params,
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    currentAccountId: authorization.requesterAccountId ?? ctx.input.defaultAccountId,
    sessionKey: ctx.input.sessionKey,
    sessionId: ctx.input.sessionId,
    agentId: ctx.agentId,
    toolContext: authorization.toolContext,
    deliveredPayload: result.payload,
    replyToIsExplicit,
  };
  let matches: boolean;
  try {
    throwIfAborted(ctx.abortSignal);
    ctx.input.assertDirectAdapterHandoff?.();
    matches = await isDeliveredCurrentSourceReplyAsync(mirrorParams);
    throwIfAborted(ctx.abortSignal);
    ctx.input.assertDirectAdapterHandoff?.();
  } catch (error) {
    // Optional annotation cannot erase accepted delivery or known partial progress.
    // Keep the original result and error without adding an unproven source route.
    if (hasAcceptedMessageActionResult(result, authorization.scheduled !== undefined)) {
      return result;
    }
    throw error;
  }
  if (!matches) {
    return result;
  }
  const payload = asOptionalRecord(result.payload);
  const details = asOptionalRecord(result.toolResult?.details);
  return {
    ...result,
    payload: payload ? { ...payload, sourceReplyRoute: "current-source" } : result.payload,
    ...(result.toolResult
      ? {
          toolResult: {
            ...result.toolResult,
            details: { ...details, sourceReplyRoute: "current-source" },
          },
        }
      : {}),
    // SAFETY: preserve the concrete result variant while adding route metadata to its payloads.
  } as T;
}
