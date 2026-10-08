import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { getGroupThreadDispatchContext } from "../../auto-reply/group-thread-context.js";
import {
  isReplyPayloadTargetSuppressed,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeDeliverableOutboundChannel } from "../../infra/outbound/channel-resolution.js";
import {
  type DurableFinalDeliveryRequirement,
  resolveOutboundDurableFinalDeliverySupport,
} from "../../infra/outbound/deliver.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { deriveDurableFinalDeliveryRequirements } from "../message/capabilities.js";
import {
  sendDurableMessageBatchCore,
  sendStructuredDurableMessageBatchCore,
} from "../message/send.js";
import {
  createChannelDeliveryResultFromReceipt,
  createChannelPartialDeliveryError,
} from "./delivery-result.js";
import { withDurableDeliveryRuntime } from "./durable-delivery-runtime.js";
import type {
  ChannelDeliveryInfo,
  ChannelDeliveryResult,
  ChannelTurnDurableDeliveryOptions,
} from "./types.js";

export type DurableInboundReplyDeliveryOptions = ChannelTurnDurableDeliveryOptions & {
  /** Optional: validate the admitted sender and pin its resolved credential before a registry handoff. */
  prepareRuntimeHandoff?: (cfg: OpenClawConfig) => OpenClawConfig;
};

export type DurableInboundReplyDeliveryParams = DurableInboundReplyDeliveryOptions & {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  ctxPayload: FinalizedMsgContext;
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
  runId?: string;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
};

export type StructuredDurableInboundReplyDeliveryParams = Omit<
  DurableInboundReplyDeliveryParams,
  "payload"
> & { plan: OutboundPayloadPlan };

type DurableInboundReplyDeliveryResult =
  | { status: "not_applicable"; reason: "non_final" }
  | {
      status: "unsupported";
      reason:
        | "missing_channel"
        | "missing_target"
        | "missing_outbound_handler"
        | "capability_mismatch";
      capability?: DurableFinalDeliveryRequirement;
    }
  | { status: "handled_visible"; delivery: ChannelDeliveryResult }
  | { status: "handled_no_send"; reason: "no_visible_result"; delivery: ChannelDeliveryResult }
  | { status: "failed"; error: unknown; sentBeforeError?: true };

function resolveDurableInboundReplyToId(
  params: Pick<DurableInboundReplyDeliveryParams, "ctxPayload" | "payload" | "replyToId">,
): string | null | undefined {
  if (isReplyPayloadTargetSuppressed(params.payload)) {
    return null;
  }
  // Explicit null means "do not reply to a source message"; do not fall back to context ids.
  if (params.replyToId === null || params.payload.replyToId === null) {
    return null;
  }
  return (
    normalizeOptionalString(params.replyToId) ??
    normalizeOptionalString(params.payload.replyToId) ??
    normalizeOptionalString(params.ctxPayload.ReplyToIdFull) ??
    normalizeOptionalString(params.ctxPayload.ReplyToId)
  );
}

function resolveDurableSuppression(
  send: Extract<Awaited<ReturnType<typeof sendDurableMessageBatchCore>>, { status: "suppressed" }>,
): NonNullable<ChannelDeliveryResult["suppression"]> {
  const hookEffect = send.payloadOutcomes?.find(
    (outcome) => outcome.status === "suppressed",
  )?.hookEffect;
  return {
    reason: send.reason,
    ...(hookEffect?.cancelReason ? { cancelReason: hookEffect.cancelReason } : {}),
    ...(hookEffect?.metadata ? { metadata: hookEffect.metadata } : {}),
  };
}

export function isDurableInboundReplyDeliveryHandled(
  result: DurableInboundReplyDeliveryResult,
): result is Extract<
  DurableInboundReplyDeliveryResult,
  { status: "handled_visible" | "handled_no_send" }
> {
  return result.status === "handled_visible" || result.status === "handled_no_send";
}

export function throwIfDurableInboundReplyDeliveryFailed(
  result: DurableInboundReplyDeliveryResult,
): void {
  if (result.status === "failed") {
    throw result.error;
  }
}

export async function deliverInboundReplyWithMessageSendContextCore(
  params: DurableInboundReplyDeliveryParams,
): Promise<DurableInboundReplyDeliveryResult> {
  return await deliverInboundReplyWithMessageSendContext(params, sendDurableMessageBatchCore);
}

/** Delivers a prepared final reply through the same durable owner without parsing its text. */
export async function deliverStructuredInboundReplyWithMessageSendContextCore(
  params: StructuredDurableInboundReplyDeliveryParams,
): Promise<DurableInboundReplyDeliveryResult> {
  const { plan, ...context } = params;
  return await deliverInboundReplyWithMessageSendContext(
    { ...context, payload: plan.payload },
    ({ payloads: _payloads, ...sendParams }) =>
      sendStructuredDurableMessageBatchCore({ ...sendParams, plan: [plan] }),
  );
}

async function deliverInboundReplyWithMessageSendContext(
  input: DurableInboundReplyDeliveryParams,
  sendBatch: typeof sendDurableMessageBatchCore,
): Promise<DurableInboundReplyDeliveryResult> {
  if (input.info.kind !== "final") {
    return { status: "not_applicable", reason: "non_final" };
  }

  try {
    return await withDurableDeliveryRuntime(input, (cfg, assertCurrent) =>
      deliverAdmittedInboundReply({ ...input, cfg }, sendBatch, assertCurrent),
    );
  } catch (error) {
    return { status: "failed", error };
  }
}

async function deliverAdmittedInboundReply(
  input: DurableInboundReplyDeliveryParams,
  sendBatch: typeof sendDurableMessageBatchCore,
  assertCurrent?: () => void,
): Promise<DurableInboundReplyDeliveryResult> {
  const group = getGroupThreadDispatchContext();
  const params = group
    ? {
        ...input,
        agentId: group.ctx.AgentId ?? input.agentId,
        ctxPayload: group.ctx,
        runId: group.runState.runId,
        executionIdentityToken: group.runState.executionIdentityToken,
      }
    : input;
  const channel = normalizeDeliverableOutboundChannel(params.channel);
  const to =
    normalizeOptionalString(params.to) ??
    normalizeOptionalString(params.ctxPayload.OriginatingTo) ??
    normalizeOptionalString(params.ctxPayload.To);
  if (!channel) {
    return { status: "unsupported", reason: "missing_channel" };
  }
  if (!to) {
    return { status: "unsupported", reason: "missing_target" };
  }

  const replyToId = resolveDurableInboundReplyToId(params);
  const threadId = "threadId" in params ? params.threadId : params.ctxPayload.MessageThreadId;
  const requiredCapabilities =
    params.requiredCapabilities ??
    deriveDurableFinalDeliveryRequirements({
      payload: params.payload,
      replyToId,
      threadId,
      silent: params.silent,
    });
  const durability =
    requiredCapabilities.reconcileUnknownSend === true ? "required" : "best_effort";

  const support = await resolveOutboundDurableFinalDeliverySupport({
    cfg: params.cfg,
    agentId: params.agentId,
    channel,
    requirements: requiredCapabilities,
  });
  if (!support.ok) {
    return {
      status: "unsupported",
      reason: support.reason,
      ...(support.capability ? { capability: support.capability } : {}),
    };
  }

  const session = buildOutboundSessionContext({
    cfg: params.cfg,
    sessionKey: params.ctxPayload.SessionKey,
    policySessionKey: params.ctxPayload.RuntimePolicySessionKey,
    conversationType: params.ctxPayload.ChatType,
    agentId: params.agentId,
    requesterAccountId: params.accountId ?? params.ctxPayload.AccountId,
    requesterSenderId: params.ctxPayload.SenderId ?? params.ctxPayload.From,
    requesterSenderName: params.ctxPayload.SenderName,
    requesterSenderUsername: params.ctxPayload.SenderUsername,
    requesterSenderE164: params.ctxPayload.SenderE164,
  });
  assertCurrent?.();
  const send = await sendBatch({
    assertDirectAdapterHandoff: assertCurrent,
    cfg: params.cfg,
    channel,
    to,
    accountId: params.accountId,
    payloads: [params.payload],
    ...((params.runId ?? params.executionIdentityToken?.runId)
      ? { runId: params.runId ?? params.executionIdentityToken?.runId }
      : {}),
    ...(params.executionIdentityToken
      ? {
          executionIdentityToken: params.executionIdentityToken,
        }
      : {}),
    threadId,
    replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    deps: params.deps,
    mediaAccess: params.mediaAccess,
    silent: params.silent,
    durability,
    ...(requiredCapabilities.reconcileUnknownSend === true
      ? { requireUnknownSendReconciliation: true }
      : {}),
    session,
    gatewayClientScopes: params.ctxPayload.GatewayClientScopes ?? [],
  });
  if (send.status === "failed") {
    return { status: "failed" as const, error: send.error };
  }
  const content =
    send.status === "partial_failed"
      ? send.results
          .map((result) => result.meta?.visibleText)
          .filter((value): value is string => typeof value === "string")
          .join("")
      : undefined;
  const receiptDelivery = createChannelDeliveryResultFromReceipt({
    receipt: send.receipt,
    threadId: threadId == null ? undefined : String(threadId),
    ...(replyToId ? { replyToId } : {}),
    visibleReplySent: send.status !== "suppressed",
    ...(content ? { content } : {}),
    ...(send.deliveryIntent
      ? {
          deliveryIntent: {
            id: send.deliveryIntent.id,
            kind: "outbound_queue",
            queuePolicy: send.deliveryIntent.queuePolicy,
          },
        }
      : {}),
  });
  if (send.status === "partial_failed") {
    return {
      status: "failed" as const,
      error: createChannelPartialDeliveryError(send.error, {
        ...receiptDelivery,
        visibleReplySent: true,
      }),
      sentBeforeError: true,
    };
  }

  if (send.status === "suppressed") {
    return {
      status: "handled_no_send",
      reason: "no_visible_result",
      delivery: { ...receiptDelivery, suppression: resolveDurableSuppression(send) },
    };
  }
  return { status: "handled_visible", delivery: receiptDelivery };
}
