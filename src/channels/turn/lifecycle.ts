import type { ExecutionIdentityAdmissionToken as ExecutionToken } from "../../audit/execution-identity-admission.js";
import { dispatchInboundMessageWithRoutedChannelDispatcher } from "../../auto-reply/dispatch.js";
import { getGroupThreadDispatchContext } from "../../auto-reply/group-thread-context.js";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { suppressPendingFinalDelivery } from "../../auto-reply/reply/dispatch-from-config.pending-final.js";
import { isReplyDispatchDeliveryPending } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import { runWithSessionInitConflictRetry } from "../../auto-reply/reply/session-init-conflict-retry.js";
import { withReplySystemEventContext } from "../../auto-reply/reply/system-event-session-key.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deriveInboundMessageHookContext,
  resolveInboundReplyHookTarget,
} from "../../hooks/message-hook-mappers.js";
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import {
  applyMessageSendingHook,
  type ReplyPayloadSuppressedObserver,
} from "../../infra/outbound/deliver-hooks.js";
import { normalizeEmptyPayloadForDelivery } from "../../infra/outbound/deliver-payload.js";
import {
  isPlatformMessageNotDispatchedError,
  isPlatformMessageRejectedError,
} from "../../infra/outbound/deliver-types.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import {
  createMessageSentEmitter,
  type MessageSentEvent,
} from "../../infra/outbound/message-sent-hook.js";
import {
  createStructuredOutboundPayloadPlan,
  summarizeOutboundPayloadForTransport,
} from "../../infra/outbound/payloads.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveMessageReceiptPrimaryId } from "../message/receipt.js";
import { createChannelReplyPipeline } from "../message/reply-pipeline.js";
import { recordInboundSession } from "../session.js";
import {
  createSuppressedChannelDeliveryResult,
  isChannelPartialDeliveryError,
} from "./delivery-result.js";
import {
  createDirectPendingFinalCustody,
  NO_PENDING_FINAL_CUSTODY,
  resolvePendingFinalCompletion,
  toCoreManagedDeliveryInfo,
} from "./direct-delivery-custody.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  deliverStructuredInboundReplyWithMessageSendContextCore,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
  type DurableInboundReplyDeliveryParams,
} from "./durable-delivery.js";
import { runPreparedChannelTurnCore } from "./execution.js";
import { applyRouteDmScope } from "./route-dm-scope.js";
import type {
  AssembledChannelTurn,
  ChannelEventDeliveryAdapter,
  ChannelDeliveryInfo,
  ChannelDeliveryOutcome,
  ChannelDeliveryResult,
  ChannelTurnDeliveryAdapter,
  ChannelTurnPlan,
  ChannelProviderOwnedMessageSendingDeliveryAdapter,
  ChannelTurnResolved,
  ChannelTurnResult,
  PreparedChannelTurn,
} from "./types.js";

type RoutedAssembledChannelTurn = Omit<
  AssembledChannelTurn,
  "delivery" | "dispatchReplyWithBufferedBlockDispatcher"
> & {
  delivery: ChannelTurnDeliveryAdapter;
};

type AnyChannelDeliveryAdapter = ChannelEventDeliveryAdapter | ChannelTurnDeliveryAdapter;

type ChannelDeliveryOperation<T extends { payload: ReplyPayload }> = {
  prepare: (payload: ReplyPayload) => T | null;
  deliver?: (
    value: T,
    info: Parameters<ChannelEventDeliveryAdapter["deliver"]>[1],
  ) => Promise<ChannelDeliveryResult | void>;
  deliverWithProviderMessageSending?: (
    value: T,
    info: Parameters<
      ChannelProviderOwnedMessageSendingDeliveryAdapter["deliverWithProviderMessageSending"]
    >[1],
  ) => Promise<ChannelDeliveryResult | void>;
  deliverDurable: (
    value: T,
    params: Omit<DurableInboundReplyDeliveryParams, "payload">,
  ) => ReturnType<typeof deliverInboundReplyWithMessageSendContextCore>;
};

type PendingChannelDeliveryAttempt = {
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
  emitMessageSent?: ReturnType<typeof createMessageSentEmitter>["emitMessageSent"];
} & (
  | { state: "fulfilled"; result: ChannelDeliveryResult | void }
  | { state: "rejected"; error: unknown }
);

function resolvePartialChannelDeliveryResult(
  error: unknown,
): (ChannelDeliveryOutcome & { visibleReplySent: true }) | undefined {
  return isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
}

export function assembleResolvedChannelTurn<
  TDispatchResult,
  TDelivery extends ChannelTurnDeliveryAdapter,
>(
  value: ChannelTurnResolved<TDispatchResult, TDelivery>,
): AssembledChannelTurn | RoutedAssembledChannelTurn | PreparedChannelTurn<TDispatchResult> {
  if (!("route" in value)) {
    return value;
  }
  const { cfg, route } = value;
  const routing = {
    ctxPayload: applyRouteDmScope(value.ctxPayload, route.dmScope),
    routeSessionKey: route.sessionKey,
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: route.agentId }),
    recordInboundSession,
  };
  if ("runDispatch" in value) {
    const { cfg: _cfg, route: _route, ...turn } = value;
    return { ...turn, ...routing };
  }
  const { cfg: _cfg, route: _route, ...turn } = value;
  return { ...turn, ...routing, cfg, agentId: route.agentId };
}

function resolveAssembledReplyPipeline(
  params: AssembledChannelTurn | RoutedAssembledChannelTurn,
): Pick<AssembledChannelTurn, "dispatcherOptions" | "replyOptions"> {
  const adoption = params.turnAdoptionLifecycle ?? params.replyOptions?.turnAdoptionLifecycle;
  let replyOptions = adoption
    ? { ...params.replyOptions, turnAdoptionLifecycle: adoption }
    : params.replyOptions;
  if (params.routeSessionKey !== params.ctxPayload.SessionKey) {
    replyOptions = withReplySystemEventContext(replyOptions ?? {}, {
      sessionKey: params.routeSessionKey,
    });
  }
  if (!params.replyPipeline) {
    return {
      dispatcherOptions: params.dispatcherOptions,
      replyOptions,
    };
  }
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    ...params.replyPipeline,
  });
  return {
    dispatcherOptions: {
      ...replyPipeline,
      ...params.dispatcherOptions,
    },
    replyOptions: {
      onModelSelected,
      ...replyOptions,
    },
  };
}

function isExplicitlyNonVisibleChannelDelivery(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { visibleReplySent?: unknown }).visibleReplySent === false
  );
}

function markChannelDeliveryErrorVisible(error: unknown): unknown {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    try {
      Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
      return error;
    } catch {
      // Fall back to a wrapper when a platform error object is non-extensible.
    }
  }
  const visibleError = new Error("visible channel reply delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

async function runChannelDeliveryObserver(params: {
  onDelivered: AnyChannelDeliveryAdapter["onDelivered"] | undefined;
  payload: ReplyPayload;
  info: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[1];
  result: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[2];
}): Promise<void> {
  if (!params.onDelivered || isReplyDispatchDeliveryPending(params.result)) {
    return;
  }
  try {
    await params.onDelivered(params.payload, params.info, params.result);
  } catch (error: unknown) {
    throw isExplicitlyNonVisibleChannelDelivery(params.result)
      ? error
      : markChannelDeliveryErrorVisible(error);
  }
}

function resolveChannelDeliveryMessageId(
  result: ChannelDeliveryOutcome | undefined,
): string | undefined {
  return result?.receipt
    ? resolveMessageReceiptPrimaryId(result.receipt)
    : result?.messageIds?.find((messageId) => messageId.trim());
}

async function settleChannelDeliveryAttempts(
  attempts: readonly PendingChannelDeliveryAttempt[],
  delivery: AnyChannelDeliveryAdapter,
): Promise<void> {
  let preferredSettlementError: unknown;

  for (const attempt of attempts) {
    try {
      await settleChannelDeliveryAttempt(attempt, delivery.onDelivered, (error) =>
        delivery.onError?.(error, attempt.info),
      );
    } catch (error: unknown) {
      // Any visible partial outcome must win over an earlier generic failure so callers
      // retain provider identity and do not retry an already-visible logical payload.
      if (
        preferredSettlementError === undefined ||
        (resolvePartialChannelDeliveryResult(error) !== undefined &&
          resolvePartialChannelDeliveryResult(preferredSettlementError) === undefined)
      ) {
        preferredSettlementError = error;
      }
    }
  }

  if (preferredSettlementError !== undefined) {
    throw toErrorObject(preferredSettlementError, "channel delivery settlement failed");
  }
}

// Permanent non-dispatch rejection proves no send; an untyped post-claim error stays ambiguous.
// Retryable rejection restores prepared custody so recovery can replay instead of faking ambiguity.
async function settleFailedPendingFinalDelivery(
  payload: ReplyPayload,
  error: unknown,
): Promise<void> {
  const completion = resolvePendingFinalCompletion(payload);
  if (!completion) {
    return;
  }
  if (isPlatformMessageRejectedError(error)) {
    await settlePendingFinalDelivery(completion, "suppressed", ["prepared", "queued", "unknown"]);
  } else if (isPlatformMessageNotDispatchedError(error)) {
    await settlePendingFinalDelivery(completion, "prepared", ["queued", "unknown"]);
  } else {
    await settlePendingFinalDelivery(completion, "unknown", ["queued", "unknown"]);
  }
}

async function settleChannelDeliveryAttempt(
  attempt: PendingChannelDeliveryAttempt,
  onDelivered: AnyChannelDeliveryAdapter["onDelivered"] | undefined,
  onFinalizationError?: (error: unknown) => Promise<void> | void,
): Promise<void> {
  const emitFailure = (error: unknown): void => {
    const partial = resolvePartialChannelDeliveryResult(error);
    if (!isPlatformMessageNotDispatchedError(error)) {
      attempt.emitMessageSent?.({
        success: false,
        content: partial?.content ?? attempt.payload.text ?? "",
        error: formatErrorMessage(error),
        messageId: resolveChannelDeliveryMessageId(partial),
      });
    }
  };
  if (attempt.state === "rejected") {
    emitFailure(attempt.error);
    return;
  }

  let finalized: ChannelDeliveryResult | undefined;
  try {
    finalized = attempt.result || undefined;
    if (finalized?.finalization) {
      finalized = { ...finalized, ...(await finalized.finalization), finalization: undefined };
    }
  } catch (error: unknown) {
    try {
      await onFinalizationError?.(error);
    } catch {
      // Error observers are best-effort and must not replace the native settlement failure.
    }
    await settleFailedPendingFinalDelivery(attempt.payload, error);
    emitFailure(error);
    throw toErrorObject(error, "channel delivery finalization failed");
  }

  const pending = isReplyDispatchDeliveryPending(finalized);
  if (!pending && !isExplicitlyNonVisibleChannelDelivery(finalized)) {
    attempt.emitMessageSent?.({
      success: true,
      content: finalized?.content ?? attempt.payload.text ?? "",
      messageId: resolveChannelDeliveryMessageId(finalized),
    });
  }
  const completion = resolvePendingFinalCompletion(attempt.payload);
  if (completion) {
    await settlePendingFinalDelivery(
      completion,
      pending
        ? "unknown"
        : isExplicitlyNonVisibleChannelDelivery(finalized)
          ? "suppressed"
          : "delivered",
    );
  }
  await runChannelDeliveryObserver({
    onDelivered,
    payload: attempt.payload,
    info: attempt.info,
    result: finalized,
  });
}

async function applyRoutedDirectMessageSending(params: {
  turn: RoutedAssembledChannelTurn;
  payload: ReplyPayload;
}): Promise<{ payload: ReplyPayload; suppression?: ChannelDeliveryResult }> {
  const hookRunner = getGlobalHookRunner();
  const hookCtx = deriveInboundMessageHookContext(params.turn.ctxPayload);
  const hookResult = await applyMessageSendingHook({
    hookRunner,
    enabled: hookRunner?.hasHooks("message_sending") ?? false,
    payload: params.payload,
    payloadSummary: summarizeOutboundPayloadForTransport(params.payload),
    to: resolveInboundReplyHookTarget(params.turn.ctxPayload, hookCtx),
    channel: params.turn.channel,
    accountId: params.turn.accountId,
    replyToId:
      params.payload.replyToId ??
      params.turn.ctxPayload.ReplyToIdFull ??
      params.turn.ctxPayload.ReplyToId,
    threadId: params.turn.ctxPayload.MessageThreadId,
    sessionKey: params.turn.routeSessionKey,
  });
  if (hookResult.cancelled) {
    return {
      payload: params.payload,
      suppression: createSuppressedChannelDeliveryResult({
        reason: "cancelled_by_message_sending_hook",
        cancelReason: hookResult.cancelReason,
        metadata: hookResult.hookMetadata,
      }),
    };
  }
  const payload = normalizeEmptyPayloadForDelivery(hookResult.payload);
  if (!payload) {
    return {
      payload: hookResult.payload,
      suppression: createSuppressedChannelDeliveryResult({
        reason: hookResult.contentRewritten
          ? "empty_after_message_sending_hook"
          : "no_visible_payload",
      }),
    };
  }
  return { payload: copyReplyPayloadMetadata(params.payload, payload) };
}

function createObserveOnlyDeliveryAdapter(): ChannelEventDeliveryAdapter {
  // Observe-only turns still run the agent, but transport delivery must remain impossible for
  // every assembled-turn entry point, including direct SDK dispatch.
  return {
    deliver: async () => ({ visibleReplySent: false }),
  };
}

async function dispatchChannelTurnWithDeliveryOwner(
  ...args:
    | [params: AssembledChannelTurn, ownership: "legacy-dispatcher"]
    | [params: RoutedAssembledChannelTurn, ownership: "routed-delivery"]
): Promise<ChannelTurnResult> {
  const [params, ownership] = args;
  const replyPipeline = resolveAssembledReplyPipeline(params);
  const adoption = params.turnAdoptionLifecycle ?? params.replyOptions?.turnAdoptionLifecycle;
  const delivery =
    params.admission?.kind === "observeOnly" ? createObserveOnlyDeliveryAdapter() : params.delivery;
  const pendingDeliveryAttempts: PendingChannelDeliveryAttempt[] = [];
  const normalizationSuppressionAttempts: PendingChannelDeliveryAttempt[] = [];
  let agentRun: [runId?: string, executionIdentityToken?: ExecutionToken] = [];
  const onAgentRunStart = replyPipeline.replyOptions?.onAgentRunStart;
  const replyOptions: NonNullable<AssembledChannelTurn["replyOptions"]> = {
    ...replyPipeline.replyOptions,
    onAgentRunStart: (...runStartArgs) => {
      agentRun = [runStartArgs[0], runStartArgs[1]];
      return onAgentRunStart?.(...runStartArgs);
    },
  };
  const hookCtx = delivery.observeMessageSent
    ? deriveInboundMessageHookContext(params.ctxPayload)
    : undefined;
  let messageSentEmitter: ReturnType<typeof createMessageSentEmitter> | undefined;
  const getMessageSentEmitter = () => {
    if (!delivery.observeMessageSent || !hookCtx) {
      return undefined;
    }
    const group = getGroupThreadDispatchContext();
    if (!group && messageSentEmitter) {
      return messageSentEmitter;
    }
    const emitter = createMessageSentEmitter({
      hookRunner: getGlobalHookRunner(),
      channel: params.channel,
      to: resolveInboundReplyHookTarget(params.ctxPayload, hookCtx),
      accountId: params.accountId,
      sessionKeyForInternalHooks: group?.ctx.SessionKey ?? params.routeSessionKey,
      runId: group ? group.runState.runId : agentRun[0],
      isGroup: hookCtx.isGroup,
      groupId: hookCtx.groupId,
      logPrefix: "dispatchAssembledChannelTurn",
    });
    if (!group) {
      messageSentEmitter = emitter;
    }
    return emitter;
  };
  const suppressReply = async (
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
    reason: NonNullable<ChannelDeliveryResult["suppression"]>["reason"],
  ): Promise<ChannelDeliveryResult> => {
    const result = createSuppressedChannelDeliveryResult({ reason });
    await suppressPendingFinalDelivery(payload);
    await runChannelDeliveryObserver({ onDelivered: delivery.onDelivered, payload, info, result });
    return result;
  };
  const onReplySuppressed: ReplyPayloadSuppressedObserver = async (payload, info, reason) => {
    await suppressReply(payload, info, reason);
  };
  const rawDeliver = delivery.deliver?.bind(delivery);
  const rawProviderDeliver =
    "deliverWithProviderMessageSending" in delivery
      ? delivery.deliverWithProviderMessageSending?.bind(delivery)
      : undefined;
  const preparedDeliver = delivery.deliverPrepared?.bind(delivery);
  const preparedProviderDeliver =
    "deliverPreparedWithProviderMessageSending" in delivery
      ? delivery.deliverPreparedWithProviderMessageSending?.bind(delivery)
      : undefined;
  const rawOperation: ChannelDeliveryOperation<{ payload: ReplyPayload }> = {
    prepare: (payload) => ({ payload }),
    deliver: rawDeliver ? (value, info) => rawDeliver(value.payload, info) : undefined,
    deliverWithProviderMessageSending: rawProviderDeliver
      ? (value, info) => rawProviderDeliver(value.payload, info)
      : undefined,
    deliverDurable: (value, context) =>
      deliverInboundReplyWithMessageSendContextCore({ ...context, payload: value.payload }),
  };
  async function deliverReply<T extends { payload: ReplyPayload }>(
    payload: ReplyPayload,
    info: ChannelDeliveryInfo,
    operation: ChannelDeliveryOperation<T>,
  ): Promise<ChannelDeliveryResult | void> {
    const preparedPayloadResult = delivery.preparePayload
      ? await delivery.preparePayload(payload, info)
      : payload;
    const preparedValue =
      preparedPayloadResult === null
        ? null
        : operation.prepare(copyReplyPayloadMetadata(payload, preparedPayloadResult));
    if (preparedValue === null) {
      return await suppressReply(payload, info, "no_visible_payload");
    }
    const preparedPayload = preparedValue.payload;
    const declaredDurable = "durable" in delivery ? delivery.durable : undefined;
    const durableOptions =
      typeof declaredDurable === "function"
        ? await declaredDurable(preparedPayload, info)
        : declaredDurable;
    if (durableOptions) {
      const durable = await operation.deliverDurable(preparedValue, {
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
        agentId: params.agentId,
        ctxPayload: params.ctxPayload,
        info,
        executionIdentityToken: agentRun[1],
        ...durableOptions,
      });
      throwIfDurableInboundReplyDeliveryFailed(durable);
      if (isDurableInboundReplyDeliveryHandled(durable)) {
        // Durable sends emit canonical message_sent after outbound hooks settle.
        await runChannelDeliveryObserver({
          onDelivered: delivery.onDelivered,
          payload: preparedPayload,
          info,
          result: durable.delivery,
        });
        return durable.delivery;
      }
    }
    let effectiveValue = preparedValue;
    let effectivePayload = preparedPayload;
    let result: ChannelDeliveryResult | void = undefined;
    let directInfo: ChannelDeliveryInfo = info;
    // Provider finalization may outlive the participant's async context.
    const emitMessageSentForDelivery = delivery.observeMessageSent
      ? getGroupThreadDispatchContext()
        ? getMessageSentEmitter()?.emitMessageSent
        : (event: MessageSentEvent) => getMessageSentEmitter()?.emitMessageSent(event)
      : undefined;
    try {
      if (ownership === "routed-delivery" && operation.deliverWithProviderMessageSending) {
        const providerInfo = {
          ...info,
          ...(createDirectPendingFinalCustody(effectivePayload, params.storePath) ??
            NO_PENDING_FINAL_CUSTODY),
        };
        directInfo = providerInfo;
        result = await operation.deliverWithProviderMessageSending(effectiveValue, providerInfo);
      } else {
        if (ownership === "routed-delivery" && params.admission?.kind !== "observeOnly") {
          const hook = await applyRoutedDirectMessageSending({
            turn: params as RoutedAssembledChannelTurn,
            payload: effectivePayload,
          });
          effectivePayload = hook.payload;
          if (hook.suppression) {
            result = hook.suppression;
          } else {
            const nextValue = operation.prepare(effectivePayload);
            if (nextValue) {
              effectiveValue = nextValue;
              effectivePayload = nextValue.payload;
            } else {
              result = createSuppressedChannelDeliveryResult({ reason: "no_visible_payload" });
            }
          }
        }
        if (!result) {
          if (!operation.deliver) {
            throw new Error("channel delivery adapter is missing a direct deliverer");
          }
          const custody = createDirectPendingFinalCustody(effectivePayload, params.storePath);
          await custody?.onPlatformSendDispatch();
          result = await operation.deliver(effectiveValue, toCoreManagedDeliveryInfo(info));
        }
      }
    } catch (error: unknown) {
      await settleFailedPendingFinalDelivery(effectivePayload, error);
      if (delivery.observeMessageSent) {
        await settleChannelDeliveryAttempt(
          {
            state: "rejected",
            payload: effectivePayload,
            info: directInfo,
            error,
            emitMessageSent: emitMessageSentForDelivery,
          },
          delivery.onDelivered,
        );
      }
      throw error;
    }
    const attempt: PendingChannelDeliveryAttempt = {
      state: "fulfilled",
      payload: effectivePayload,
      info: directInfo,
      result,
      emitMessageSent: emitMessageSentForDelivery,
    };
    if (result?.finalization) {
      // Observe rejection while the dispatcher unwinds; settlement awaits the same promise.
      void result.finalization.catch(() => undefined);
      pendingDeliveryAttempts.push(attempt);
    } else {
      await settleChannelDeliveryAttempt(attempt, delivery.onDelivered);
    }
    return result;
  }
  const deliverPrepared = (plan: OutboundPayloadPlan, info: ChannelDeliveryInfo) =>
    deliverReply<OutboundPayloadPlan>(plan.payload, info, {
      prepare: (payload) => {
        const [entry] = createStructuredOutboundPayloadPlan([payload]);
        return entry ? { ...entry, sourceIndex: plan.sourceIndex } : null;
      },
      deliver: preparedDeliver ?? rawOperation.deliver,
      deliverWithProviderMessageSending:
        preparedProviderDeliver ?? rawOperation.deliverWithProviderMessageSending,
      deliverDurable: (value, context) =>
        deliverStructuredInboundReplyWithMessageSendContextCore({ ...context, plan: value }),
    });
  return await runPreparedChannelTurnCore(
    {
      channel: params.channel,
      accountId: params.accountId,
      routeSessionKey: params.routeSessionKey,
      storePath: params.storePath,
      ctxPayload: params.ctxPayload,
      recordInboundSession: params.recordInboundSession,
      afterRecord: params.afterRecord,
      record: params.record,
      history: params.history,
      admission: params.admission,
      botLoopProtection: params.botLoopProtection,
      outboundEchoSourceId: params.outboundEchoSourceId,
      log: params.log,
      messageId: params.messageId,
      ...(adoption
        ? {
            runDispatchLifecycle: {
              turnAdoptionLifecycle: adoption,
              onDispatchSkipped: async () => await adoption.onAdopted(),
            },
          }
        : {}),
      runDispatch: async () => {
        let dispatchResult:
          | Awaited<ReturnType<AssembledChannelTurn["dispatchReplyWithBufferedBlockDispatcher"]>>
          | undefined;
        let dispatchError: unknown;
        try {
          dispatchResult = await runWithSessionInitConflictRetry(
            () =>
              (ownership === "routed-delivery"
                ? dispatchInboundMessageWithRoutedChannelDispatcher
                : params.dispatchReplyWithBufferedBlockDispatcher)({
                ctx: params.ctxPayload,
                cfg: params.cfg,
                ...(ownership === "routed-delivery"
                  ? {
                      ...(params.admission?.kind === "observeOnly"
                        ? { suppressOutboundHooks: true as const }
                        : {}),
                      onReplyPayloadSuppressed: onReplySuppressed,
                    }
                  : {}),
                dispatcherOptions: {
                  ...replyPipeline.dispatcherOptions,
                  onSkip: (payload, info) => {
                    replyPipeline.dispatcherOptions?.onSkip?.(payload, info);
                    if (info.reason !== "channel_transform") {
                      return;
                    }
                    const { reason: _reason, ...deliveryInfo } = info;
                    normalizationSuppressionAttempts.push({
                      state: "fulfilled",
                      payload,
                      info: deliveryInfo,
                      result: createSuppressedChannelDeliveryResult({ reason: info.reason }),
                    });
                  },
                  deliver: (payload: ReplyPayload, info: ChannelDeliveryInfo) =>
                    deliverReply(payload, info, rawOperation),
                  deliverPrepared,
                  onError: delivery.onError,
                },
                dispatchReplyFromConfig: params.dispatchReplyFromConfig,
                toolsAllow: params.toolsAllow,
                replyOptions,
                replyResolver: params.replyResolver,
              }),
            params.sessionInitRetry
              ? {
                  retryDelaysMs: params.sessionInitRetry.delaysMs,
                  signal: params.sessionInitRetry.signal,
                  sleep: params.sessionInitRetry.sleep,
                }
              : undefined,
          );
        } catch (error: unknown) {
          dispatchError = error;
        }

        let settlementError: unknown;
        try {
          await settleChannelDeliveryAttempts(normalizationSuppressionAttempts, delivery);
          await settleChannelDeliveryAttempts(pendingDeliveryAttempts, delivery);
        } catch (error: unknown) {
          settlementError = error;
        }
        // Preserve deferred provider receipts so callers do not retry an accepted send.
        if (
          settlementError !== undefined &&
          resolvePartialChannelDeliveryResult(settlementError) !== undefined
        ) {
          throw toErrorObject(settlementError, "channel delivery settlement failed");
        }
        if (dispatchError !== undefined) {
          throw toErrorObject(dispatchError, "channel dispatch failed");
        }
        if (settlementError !== undefined) {
          throw toErrorObject(settlementError, "channel delivery settlement failed");
        }
        return dispatchResult!;
      },
    },
    { suppressObserveOnlyDispatch: false },
  );
}

export async function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult> {
  return await dispatchChannelTurnWithDeliveryOwner(params, "legacy-dispatcher");
}

export function dispatchRoutedChannelTurn(
  params: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
): Promise<ChannelTurnResult>;
export function dispatchRoutedChannelTurn(
  params: ChannelTurnPlan<ChannelProviderOwnedMessageSendingDeliveryAdapter>,
): Promise<ChannelTurnResult>;
export function dispatchRoutedChannelTurn(params: ChannelTurnPlan): Promise<ChannelTurnResult>;
export async function dispatchRoutedChannelTurn(
  params: ChannelTurnPlan<ChannelTurnDeliveryAdapter>,
): Promise<ChannelTurnResult> {
  return await dispatchChannelTurnWithDeliveryOwner(
    assembleResolvedChannelTurn(params) as RoutedAssembledChannelTurn,
    "routed-delivery",
  );
}
