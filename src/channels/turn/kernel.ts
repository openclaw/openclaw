// Channel turn kernel for normalized inbound event dispatch, history, and delivery.
import type { ToolLifecycleEvent } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryWithMedia,
} from "../../auto-reply/reply/history.js";
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { normalizeChatType } from "../chat-type.js";
import { toHistoryMediaEntries } from "../inbound-event/media.js";
import { createChannelReplyPipeline } from "../message/reply-pipeline.js";
import type { CreateChannelReplyPipelineParams } from "../message/reply-pipeline.js";
import { recordChannelBotPairLoopAndCheckSuppression } from "./bot-loop-protection.js";
import {
  EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
  hasVisibleChannelTurnDispatch,
} from "./dispatch-result.js";
import type { ChannelTurnDispatchResultLike } from "./dispatch-result.js";
import {
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
import {
  materializeTurnState,
  sanitizeTurnEvent,
  sanitizeTurnEventMetadata,
  validateTurnCompletion,
} from "./turn-event-state.js";
import type { AppendTurnEventInput, TurnEvent, TurnEventRecorder } from "./turn-event-state.js";
export {
  buildChannelInboundEventContext,
  filterChannelInboundSupplementalContext,
} from "../inbound-event/context.js";
export type { BuildChannelInboundEventContextParams } from "../inbound-event/context.js";
export {
  clearChannelBotPairLoopGuardForTests,
  listTrackedChannelBotPairsForTests,
  recordChannelBotPairLoopAndCheckSuppression,
} from "./bot-loop-protection.js";
export { createChannelHistoryWindow } from "./history-window.js";
export type { ChannelHistoryWindow } from "./history-window.js";
export type { ChannelBotLoopProtectionFacts } from "./bot-loop-protection.js";
export {
  deliverDurableInboundReplyPayload,
  deliverInboundReplyWithMessageSendContext,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
} from "./durable-delivery.js";
export type {
  DurableInboundReplyDeliveryOptions,
  DurableInboundReplyDeliveryParams,
  DurableInboundReplyDeliveryResult,
} from "./durable-delivery.js";
import type {
  AssembledChannelTurn,
  ChannelEventClass,
  ChannelTurnAdmission,
  ChannelTurnDispatchRuntimeContext,
  ChannelEventDeliveryAdapter,
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnLogEvent,
  ChannelTurnResolved,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  NormalizedTurnInput,
  PreparedChannelTurn,
  PreflightFacts,
  RunChannelTurnParams,
} from "./types.js";
export { createChannelDeliveryResultFromReceipt } from "./delivery-result.js";
export {
  EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
  type ChannelTurnDispatchResultLike,
  type ChannelTurnVisibleDeliverySignals,
} from "./dispatch-result.js";
export {
  InMemoryTurnEventStore,
  materializeTurnState,
  validateTurnCompletion,
} from "./turn-event-state.js";
export type {
  AppendTurnEventInput,
  TurnEvent,
  TurnEventRecorder,
  TurnState,
  TurnStateStatus,
} from "./turn-event-state.js";
export type {
  AccessFacts,
  AssembledChannelTurn,
  ChannelDeliveryInfo,
  ChannelDeliveryResult,
  ChannelEventClass,
  ChannelTurnAdapter,
  ChannelTurnAdmission,
  ChannelEventDeliveryAdapter,
  ChannelTurnDroppedHistoryOptions,
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnDispatcherOptions,
  ChannelTurnLogEvent,
  ChannelTurnRecordOptions,
  ChannelTurnReplyPipelineOptions,
  ChannelTurnResolved,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  ConversationFacts,
  MessageFacts,
  NormalizedTurnInput,
  PreflightFacts,
  PreparedChannelTurn,
  ReplyPlanFacts,
  RouteFacts,
  RunChannelTurnParams,
  SenderFacts,
  SupplementalContextFacts,
} from "./types.js";
export type { InboundMediaFacts } from "./types.js";

const DEFAULT_EVENT_CLASS: ChannelEventClass = {
  kind: "message",
  canStartAgentTurn: true,
};

/**
 * @deprecated Compatibility assembly for legacy buffered reply dispatchers.
 * New channel plugins should expose `defineChannelMessageAdapter(...)` from
 * `openclaw/plugin-sdk/channel-outbound` and route send/receive behavior through
 * the message lifecycle helpers.
 */
export function createChannelTurnReplyPipeline(
  params: CreateChannelReplyPipelineParams,
): ReturnType<typeof createChannelReplyPipeline> {
  return createChannelReplyPipeline(params);
}

function isAdmission(value: unknown): value is ChannelTurnAdmission {
  if (!value || typeof value !== "object") {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === "dispatch" || kind === "observeOnly" || kind === "handled" || kind === "drop";
}

function normalizePreflight(
  value: PreflightFacts | ChannelTurnAdmission | null | undefined,
): PreflightFacts {
  if (!value) {
    return {};
  }
  if (isAdmission(value)) {
    return { admission: value };
  }
  return value;
}

function emit(params: {
  log?: (event: ChannelTurnLogEvent) => void;
  event: Omit<ChannelTurnLogEvent, "channel" | "accountId">;
  channel: string;
  accountId?: string;
}) {
  params.log?.({
    channel: params.channel,
    accountId: params.accountId,
    ...params.event,
  });
}

function projectTurnStateLogFields(
  turnState: ChannelTurnLogEvent["turnState"],
): Pick<ChannelTurnLogEvent, "reason" | "turnState"> {
  if (!turnState) {
    return {};
  }
  const reason = turnState.errors[0];
  return {
    ...(reason ? { reason } : {}),
    turnState,
  };
}

function resolveTurnEventTurnId(params: {
  accountId?: string;
  channel: string;
  messageId?: string;
  routeSessionKey?: string;
  sessionKey?: string;
}): string {
  const scope = params.accountId ? `${params.channel}:${params.accountId}` : params.channel;
  if (params.messageId) {
    return `${scope}:message:${params.messageId}`;
  }
  return `${scope}:session:${params.sessionKey ?? params.routeSessionKey ?? "unknown"}`;
}

function normalizeDiagnosticTimestamp(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const normalized = value < 10_000_000_000 ? value * 1000 : value;
  const now = Date.now();
  if (normalized > now + 60_000) {
    return undefined;
  }
  return normalized;
}

function computePositiveDurationMs(
  endMs: number | undefined,
  startMs: number | undefined,
): number | undefined {
  if (
    endMs === undefined ||
    startMs === undefined ||
    !Number.isFinite(endMs) ||
    !Number.isFinite(startMs)
  ) {
    return undefined;
  }
  const duration = Math.round(endMs - startMs);
  return duration >= 0 ? duration : undefined;
}

async function appendTurnEvent(params: {
  accountId?: string;
  event: AppendTurnEventInput;
  events?: TurnEvent[];
  recorder?: TurnEventRecorder;
}): Promise<void> {
  const safeEvent: AppendTurnEventInput = {
    ...params.event,
    metadata: sanitizeTurnEventMetadata(params.event.metadata),
  };
  const recorded = sanitizeTurnEvent(
    params.recorder
      ? await params.recorder.append(safeEvent)
      : ({
          id: safeEvent.id ?? `turn-event:${safeEvent.turnId}:${safeEvent.type}`,
          timestamp: safeEvent.timestamp ?? Date.now(),
          ...safeEvent,
        } satisfies TurnEvent),
  );
  emitTrustedDiagnosticEvent({
    type: "channel.turn.event",
    channel: recorded.channel,
    accountId: params.accountId,
    turnId: recorded.turnId,
    sessionKey:
      typeof recorded.metadata?.sessionKey === "string" ? recorded.metadata.sessionKey : undefined,
    messageId:
      typeof recorded.metadata?.messageId === "string" ? recorded.metadata.messageId : undefined,
    target: recorded.target,
    turnEventType: recorded.type,
    status: recorded.status,
    reason: typeof recorded.metadata?.reason === "string" ? recorded.metadata.reason : undefined,
    visibleDeliveryRequired:
      typeof recorded.metadata?.visibleDeliveryRequired === "boolean"
        ? recorded.metadata.visibleDeliveryRequired
        : undefined,
    visibleDeliverySent:
      typeof recorded.metadata?.visibleDeliverySent === "boolean"
        ? recorded.metadata.visibleDeliverySent
        : undefined,
    completionAllowed:
      typeof recorded.metadata?.completionAllowed === "boolean"
        ? recorded.metadata.completionAllowed
        : undefined,
    nativeMessageTimestamp:
      typeof recorded.metadata?.nativeMessageTimestamp === "number"
        ? recorded.metadata.nativeMessageTimestamp
        : undefined,
    messageReceivedAt:
      typeof recorded.metadata?.messageReceivedAt === "number"
        ? recorded.metadata.messageReceivedAt
        : undefined,
    messageAgeMs:
      typeof recorded.metadata?.messageAgeMs === "number"
        ? recorded.metadata.messageAgeMs
        : undefined,
    receivedToTurnStartMs:
      typeof recorded.metadata?.receivedToTurnStartMs === "number"
        ? recorded.metadata.receivedToTurnStartMs
        : undefined,
    startToDeliveryMs:
      typeof recorded.metadata?.startToDeliveryMs === "number"
        ? recorded.metadata.startToDeliveryMs
        : undefined,
    startToCompletionMs:
      typeof recorded.metadata?.startToCompletionMs === "number"
        ? recorded.metadata.startToCompletionMs
        : undefined,
    toolName:
      typeof recorded.metadata?.toolName === "string" ? recorded.metadata.toolName : undefined,
    toolCallId:
      typeof recorded.metadata?.toolCallId === "string" ? recorded.metadata.toolCallId : undefined,
    durationMs:
      typeof recorded.metadata?.durationMs === "number" ? recorded.metadata.durationMs : undefined,
    isError:
      typeof recorded.metadata?.isError === "boolean" ? recorded.metadata.isError : undefined,
    deniedReason:
      typeof recorded.metadata?.deniedReason === "string"
        ? recorded.metadata.deniedReason
        : undefined,
    errorCategory:
      typeof recorded.metadata?.errorCategory === "string"
        ? recorded.metadata.errorCategory
        : undefined,
  });
  if (recorded) {
    params.events?.push(recorded);
  }
}

function buildToolCallParentEventId(params: { turnId: string; toolCallId: string }): string {
  return `turn-event:${params.turnId}:tool:${params.toolCallId}:called`;
}

async function appendChannelTurnToolLifecycleEvent(params: {
  accountId?: string;
  channel: string;
  event: ToolLifecycleEvent;
  events: TurnEvent[];
  recorder?: TurnEventRecorder;
  target?: string;
  turnId: string;
}): Promise<void> {
  const toolCallId = typeof params.event.toolCallId === "string" ? params.event.toolCallId : "";
  const parentId = toolCallId
    ? buildToolCallParentEventId({ turnId: params.turnId, toolCallId })
    : undefined;
  const type = params.event.phase === "start" ? "tool.called" : "tool.result";
  await appendTurnEvent({
    accountId: params.accountId,
    recorder: params.recorder,
    events: params.events,
    event: {
      ...(type === "tool.called" && parentId ? { id: parentId } : {}),
      type,
      turnId: params.turnId,
      runId: params.event.runId,
      ...(type === "tool.result" && parentId ? { parentId } : {}),
      actor: type === "tool.called" ? "agent" : "tool",
      channel: params.channel,
      target: params.target,
      status:
        params.event.phase === "start"
          ? "started"
          : params.event.phase === "end"
            ? "completed"
            : "failed",
      metadata: {
        toolName: params.event.toolName,
        toolCallId: params.event.toolCallId,
        phase: params.event.phase,
        sessionKey: params.event.sessionKey,
        sessionId: params.event.sessionId,
        durationMs: params.event.durationMs,
        isError: params.event.isError,
        status: params.event.status,
        deniedReason: params.event.deniedReason,
        errorCategory: params.event.errorCategory,
      },
    },
  });
}

function mergeToolLifecycleCallbacks(params: {
  first?: (event: ToolLifecycleEvent) => Promise<void> | void;
  second?: (event: ToolLifecycleEvent) => Promise<void> | void;
}): ((event: ToolLifecycleEvent) => Promise<void>) | undefined {
  if (!params.first && !params.second) {
    return undefined;
  }
  return async (event) => {
    await params.first?.(event);
    await params.second?.(event);
  };
}

function isTelegramDirectDispatchRequired(params: {
  admission: ChannelTurnAdmission;
  channel: string;
  chatType?: string;
}): boolean {
  return (
    params.admission.kind === "dispatch" &&
    params.channel === "telegram" &&
    normalizeChatType(params.chatType) === "direct"
  );
}

export function createNoopChannelEventDeliveryAdapter(): ChannelEventDeliveryAdapter {
  // Observe-only channels still need an adapter shape for shared turn plumbing.
  return {
    deliver: async () => ({
      visibleReplySent: false,
    }),
  };
}

function clearPendingHistoryAfterTurn(params?: ChannelTurnHistoryFinalizeOptions): void {
  if (!params?.isGroup || !params.historyKey || !params.historyMap || params.limit === undefined) {
    return;
  }
  clearHistoryEntriesIfEnabled({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    limit: params.limit,
  });
}

function resolveDroppedHistorySender(input: NormalizedTurnInput, preflight: PreflightFacts) {
  return (
    preflight.message?.senderLabel ??
    preflight.message?.envelopeFrom ??
    (typeof input.raw === "object" &&
    input.raw &&
    "sender" in input.raw &&
    typeof (input.raw as { sender?: unknown }).sender === "string"
      ? (input.raw as { sender: string }).sender
      : undefined) ??
    "unknown"
  );
}

function resolveDroppedHistoryBody(input: NormalizedTurnInput, preflight: PreflightFacts) {
  return (
    preflight.message?.bodyForAgent ??
    preflight.message?.body ??
    preflight.message?.rawBody ??
    input.textForAgent ??
    input.rawText
  );
}

export async function recordDroppedChannelTurnHistory(params: {
  input: NormalizedTurnInput;
  preflight: PreflightFacts;
  admission?: ChannelTurnAdmission;
}): Promise<void> {
  const admission = params.admission ?? params.preflight.admission;
  if (admission?.kind !== "drop") {
    return;
  }
  const history = params.preflight.history;
  if (!history || history.limit <= 0 || !(history.recordOnDrop || admission.recordHistory)) {
    return;
  }
  const body = resolveDroppedHistoryBody(params.input, params.preflight);
  const entry =
    body.trim().length > 0
      ? {
          sender: resolveDroppedHistorySender(params.input, params.preflight),
          body,
          timestamp: params.input.timestamp,
          messageId: params.input.id,
        }
      : null;
  const media = params.preflight.media;
  await recordPendingHistoryEntryWithMedia({
    historyMap: history.historyMap,
    historyKey: history.key,
    limit: history.limit,
    entry,
    mediaLimit: history.mediaLimit,
    messageId: params.input.id,
    shouldRecord: history.shouldRecord,
    media:
      typeof media === "function"
        ? async () => toHistoryMediaEntries(await media(), { messageId: params.input.id })
        : toHistoryMediaEntries(media, { messageId: params.input.id }),
  });
}

export const recordDroppedChannelInboundHistory = recordDroppedChannelTurnHistory;

function resolveAssembledReplyPipeline(
  params: AssembledChannelTurn,
): Pick<AssembledChannelTurn, "dispatcherOptions" | "replyOptions"> {
  if (!params.replyPipeline) {
    return {
      dispatcherOptions: params.dispatcherOptions,
      replyOptions: params.replyOptions,
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
      ...params.replyOptions,
    },
  };
}

function resolveObserveOnlyDispatchResult<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): TDispatchResult {
  return (params.observeOnlyDispatchResult ?? {
    queuedFinal: false,
    counts: EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
  }) as TDispatchResult;
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
  onDelivered: ChannelEventDeliveryAdapter["onDelivered"] | undefined;
  payload: ReplyPayload;
  info: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[1];
  result: Parameters<NonNullable<ChannelEventDeliveryAdapter["onDelivered"]>>[2];
}): Promise<void> {
  if (!params.onDelivered) {
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

function resolveBotLoopProtectionDrop<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): ChannelTurnResult<TDispatchResult> | undefined {
  if (!params.botLoopProtection) {
    return undefined;
  }
  const botLoopResult = recordChannelBotPairLoopAndCheckSuppression(params.botLoopProtection);
  if (!botLoopResult.suppressed) {
    return undefined;
  }
  const admission: ChannelTurnAdmission = { kind: "drop", reason: "bot-loop-protection" };
  emit({
    ...params,
    event: {
      stage: "authorize",
      event: "drop",
      messageId: params.messageId,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      admission: admission.kind,
      reason: admission.reason,
    },
  });
  return {
    admission,
    dispatched: false,
    ctxPayload: params.ctxPayload,
    routeSessionKey: params.routeSessionKey,
  };
}

type AssembledChannelTurnWithBotLoopProtection = AssembledChannelTurn & {
  botLoopProtection: NonNullable<AssembledChannelTurn["botLoopProtection"]>;
};

type AssembledChannelTurnWithoutBotLoopProtection = Omit<
  AssembledChannelTurn,
  "botLoopProtection"
> & {
  botLoopProtection?: undefined;
};

export function dispatchAssembledChannelTurn(
  params: AssembledChannelTurnWithBotLoopProtection,
): Promise<ChannelTurnResult>;
export function dispatchAssembledChannelTurn(
  params: AssembledChannelTurnWithoutBotLoopProtection,
): Promise<DispatchedChannelTurnResult>;
export function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult>;
export async function dispatchAssembledChannelTurn(
  params: AssembledChannelTurn,
): Promise<ChannelTurnResult> {
  const replyPipeline = resolveAssembledReplyPipeline(params);
  return await runPreparedChannelTurnCore(
    {
      channel: params.channel,
      accountId: params.accountId,
      routeSessionKey: params.routeSessionKey,
      storePath: params.storePath,
      ctxPayload: params.ctxPayload,
      recordInboundSession: params.recordInboundSession,
      record: params.record,
      history: params.history,
      admission: params.admission,
      botLoopProtection: params.botLoopProtection,
      log: params.log,
      turnEvents: params.turnEvents,
      messageId: params.messageId,
      runDispatch: async (runtimeContext?: ChannelTurnDispatchRuntimeContext) =>
        await params.dispatchReplyWithBufferedBlockDispatcher({
          ctx: params.ctxPayload,
          cfg: params.cfg,
          dispatcherOptions: {
            ...replyPipeline.dispatcherOptions,
            deliver: async (payload: ReplyPayload, info) => {
              const preparedPayload = params.delivery.preparePayload
                ? await params.delivery.preparePayload(payload, info)
                : payload;
              const durableOptions =
                typeof params.delivery.durable === "function"
                  ? await params.delivery.durable(preparedPayload, info)
                  : params.delivery.durable;
              if (durableOptions) {
                const durable = await deliverInboundReplyWithMessageSendContext({
                  cfg: params.cfg,
                  channel: params.channel,
                  accountId: params.accountId,
                  agentId: params.agentId,
                  ctxPayload: params.ctxPayload,
                  payload: preparedPayload,
                  info,
                  ...durableOptions,
                });
                throwIfDurableInboundReplyDeliveryFailed(durable);
                if (isDurableInboundReplyDeliveryHandled(durable)) {
                  await runChannelDeliveryObserver({
                    onDelivered: params.delivery.onDelivered,
                    payload: preparedPayload,
                    info,
                    result: durable.delivery,
                  });
                  return durable.delivery;
                }
              }
              const result = await params.delivery.deliver(preparedPayload, info);
              await runChannelDeliveryObserver({
                onDelivered: params.delivery.onDelivered,
                payload: preparedPayload,
                info,
                result,
              });
              return result;
            },
            onError: params.delivery.onError,
          },
          toolsAllow: params.toolsAllow,
          replyOptions: {
            ...replyPipeline.replyOptions,
            onToolLifecycleEvent: mergeToolLifecycleCallbacks({
              first: runtimeContext?.onToolLifecycleEvent,
              second: replyPipeline.replyOptions?.onToolLifecycleEvent,
            }),
          },
          replyResolver: params.replyResolver,
        }),
    },
    { suppressObserveOnlyDispatch: false },
  );
}

export const dispatchChannelInboundReply = dispatchAssembledChannelTurn;

function isPreparedChannelTurn<TDispatchResult>(
  value: ChannelTurnResolved<TDispatchResult>,
): value is PreparedChannelTurn<TDispatchResult> & {
  admission?: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
} {
  return "runDispatch" in value;
}

async function dispatchResolvedChannelTurn<TDispatchResult>(
  params: ChannelTurnResolved<TDispatchResult> & {
    admission: Extract<ChannelTurnAdmission, { kind: "dispatch" | "observeOnly" }>;
    log?: (event: ChannelTurnLogEvent) => void;
    turnEvents?: TurnEventRecorder;
    messageId?: string;
  },
): Promise<ChannelTurnResult<TDispatchResult>> {
  if (isPreparedChannelTurn(params)) {
    return await runPreparedChannelTurn(params);
  }
  return (await dispatchAssembledChannelTurn(params)) as ChannelTurnResult<TDispatchResult>;
}

async function runPreparedChannelTurnCore<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurn<TDispatchResult>,
  options: { suppressObserveOnlyDispatch: boolean },
): Promise<ChannelTurnResult<TDispatchResult>> {
  const trace = createDiagnosticTraceContextFromActiveScope();
  return await runWithDiagnosticTraceContext(trace, () =>
    runPreparedChannelTurnCoreInTrace(params, options),
  );
}

async function runPreparedChannelTurnCoreInTrace<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurn<TDispatchResult>,
  options: { suppressObserveOnlyDispatch: boolean },
): Promise<ChannelTurnResult<TDispatchResult>> {
  const admission = params.admission ?? ({ kind: "dispatch" } as const);
  const turnEventTurnId = resolveTurnEventTurnId({
    accountId: params.accountId,
    channel: params.channel,
    messageId: params.messageId,
    routeSessionKey: params.routeSessionKey,
    sessionKey: params.ctxPayload.SessionKey,
  });
  const recordedTurnEvents: TurnEvent[] = [];
  const turnStartedAt = Date.now();
  const onToolLifecycleEvent = async (event: ToolLifecycleEvent) => {
    await appendChannelTurnToolLifecycleEvent({
      accountId: params.accountId,
      channel: params.channel,
      event,
      events: recordedTurnEvents,
      recorder: params.turnEvents,
      target: params.ctxPayload.To,
      turnId: turnEventTurnId,
    });
  };
  const visibleDeliveryRequired = isTelegramDirectDispatchRequired({
    admission,
    channel: params.channel,
    chatType: params.ctxPayload.ChatType,
  });
  const botLoopDrop = resolveBotLoopProtectionDrop(params);
  if (botLoopDrop) {
    clearPendingHistoryAfterTurn(params.history);
    return botLoopDrop;
  }
  await appendTurnEvent({
    accountId: params.accountId,
    recorder: params.turnEvents,
    events: recordedTurnEvents,
    event: {
      type: "turn.started",
      turnId: turnEventTurnId,
      actor: "runtime",
      channel: params.channel,
      target: params.ctxPayload.To,
      status: "started",
      metadata: {
        admission: admission.kind,
        messageId: params.messageId,
        routeSessionKey: params.routeSessionKey,
        sessionKey: params.ctxPayload.SessionKey,
        nativeMessageTimestamp: params.turnTiming?.nativeMessageTimestamp,
        messageReceivedAt: params.turnTiming?.messageReceivedAt,
        receivedToTurnStartMs: computePositiveDurationMs(
          turnStartedAt,
          params.turnTiming?.messageReceivedAt,
        ),
        messageAgeMs: computePositiveDurationMs(
          turnStartedAt,
          params.turnTiming?.nativeMessageTimestamp,
        ),
      },
    },
  });
  if (visibleDeliveryRequired) {
    await appendTurnEvent({
      accountId: params.accountId,
      recorder: params.turnEvents,
      events: recordedTurnEvents,
      event: {
        type: "delivery.required",
        turnId: turnEventTurnId,
        actor: "runtime",
        channel: params.channel,
        target: params.ctxPayload.To,
        status: "required",
        metadata: {
          reason: "telegram_direct_message",
          messageId: params.messageId,
        },
      },
    });
  }
  emit({
    ...params,
    event: {
      stage: "record",
      event: "start",
      messageId: params.messageId,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      admission: admission.kind,
    },
  });
  try {
    await params.recordInboundSession({
      storePath: params.storePath,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      ctx: params.ctxPayload,
      groupResolution: params.record?.groupResolution,
      createIfMissing: params.record?.createIfMissing,
      updateLastRoute: params.record?.updateLastRoute,
      onRecordError: params.record?.onRecordError ?? (() => undefined),
      trackSessionMetaTask: params.record?.trackSessionMetaTask,
    });
    emit({
      ...params,
      event: {
        stage: "record",
        event: "done",
        messageId: params.messageId,
        sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
        admission: admission.kind,
      },
    });
  } catch (err) {
    emit({
      ...params,
      event: {
        stage: "record",
        event: "error",
        messageId: params.messageId,
        sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
        admission: admission.kind,
        error: err,
      },
    });
    try {
      await params.onPreDispatchFailure?.(err);
    } catch {
      // Preserve the original session-recording error.
    }
    throw err;
  }

  emit({
    ...params,
    event: {
      stage: "dispatch",
      event: "start",
      messageId: params.messageId,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      admission: admission.kind,
    },
  });
  let dispatchResult: TDispatchResult;
  try {
    dispatchResult =
      options.suppressObserveOnlyDispatch && admission.kind === "observeOnly"
        ? resolveObserveOnlyDispatchResult(params)
        : await params.runDispatch({ onToolLifecycleEvent });
  } catch (err) {
    await appendTurnEvent({
      accountId: params.accountId,
      recorder: params.turnEvents,
      events: recordedTurnEvents,
      event: {
        type: "turn.failed",
        turnId: turnEventTurnId,
        actor: "runtime",
        channel: params.channel,
        target: params.ctxPayload.To,
        status: "failed",
        metadata: {
          reason: "dispatch_error",
          messageId: params.messageId,
        },
      },
    });
    const dispatchErrorTurnState = materializeTurnState(recordedTurnEvents);
    emit({
      ...params,
      event: {
        stage: "dispatch",
        event: "error",
        messageId: params.messageId,
        sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
        admission: admission.kind,
        ...projectTurnStateLogFields(dispatchErrorTurnState),
        error: err,
      },
    });
    throw err;
  }
  const visibleDispatch = hasVisibleChannelTurnDispatch(
    dispatchResult as ChannelTurnDispatchResultLike,
  );
  if (visibleDispatch) {
    const deliveryRecordedAt = Date.now();
    await appendTurnEvent({
      accountId: params.accountId,
      recorder: params.turnEvents,
      events: recordedTurnEvents,
      event: {
        type: "delivery.sent",
        turnId: turnEventTurnId,
        actor: "runtime",
        channel: params.channel,
        target: params.ctxPayload.To,
        status: "sent",
        metadata: {
          messageId: params.messageId,
          startToDeliveryMs: computePositiveDurationMs(deliveryRecordedAt, turnStartedAt),
        },
      },
    });
  } else if (visibleDeliveryRequired) {
    const deliveryFailedAt = Date.now();
    await appendTurnEvent({
      accountId: params.accountId,
      recorder: params.turnEvents,
      events: recordedTurnEvents,
      event: {
        type: "delivery.failed",
        turnId: turnEventTurnId,
        actor: "runtime",
        channel: params.channel,
        target: params.ctxPayload.To,
        status: "failed",
        metadata: {
          reason: "missing_visible_delivery",
          messageId: params.messageId,
          startToDeliveryMs: computePositiveDurationMs(deliveryFailedAt, turnStartedAt),
        },
      },
    });
  }
  const preCompletionTurnState = materializeTurnState(recordedTurnEvents);
  const completionErrors = validateTurnCompletion(preCompletionTurnState);
  const turnCompletedAt = Date.now();
  await appendTurnEvent({
    accountId: params.accountId,
    recorder: params.turnEvents,
    events: recordedTurnEvents,
    event: {
      type: completionErrors.length > 0 ? "turn.failed" : "turn.completed",
      turnId: turnEventTurnId,
      actor: "runtime",
      channel: params.channel,
      target: params.ctxPayload.To,
      status: completionErrors.length > 0 ? "invalid" : "valid",
      metadata: {
        reason: completionErrors[0],
        messageId: params.messageId,
        completionAllowed: completionErrors.length === 0,
        visibleDeliveryRequired: preCompletionTurnState.visibleDeliveryRequired,
        visibleDeliverySent: preCompletionTurnState.visibleDeliverySent,
        startToCompletionMs: computePositiveDurationMs(turnCompletedAt, turnStartedAt),
      },
    },
  });
  const turnState = materializeTurnState(recordedTurnEvents);
  emit({
    ...params,
    event: {
      stage: "dispatch",
      event: "done",
      messageId: params.messageId,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      admission: admission.kind,
    },
  });
  clearPendingHistoryAfterTurn(params.history);

  return {
    admission,
    dispatched: true,
    ctxPayload: params.ctxPayload,
    routeSessionKey: params.routeSessionKey,
    dispatchResult,
    turnState,
  };
}

type PreparedChannelTurnWithBotLoopProtection<TDispatchResult> =
  PreparedChannelTurn<TDispatchResult> & {
    botLoopProtection: NonNullable<PreparedChannelTurn<TDispatchResult>["botLoopProtection"]>;
  };

type PreparedChannelTurnWithoutBotLoopProtection<TDispatchResult> = Omit<
  PreparedChannelTurn<TDispatchResult>,
  "botLoopProtection"
> & {
  botLoopProtection?: undefined;
};

export function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurnWithBotLoopProtection<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: PreparedChannelTurnWithoutBotLoopProtection<TDispatchResult>,
): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
export function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(params: PreparedChannelTurn<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
export async function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(params: PreparedChannelTurn<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedChannelTurnCore(params, { suppressObserveOnlyDispatch: true });
}

export const runPreparedInboundReply = runPreparedChannelTurn;

export async function runChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<TRaw, TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  emit({
    ...params,
    event: { stage: "ingest", event: "start" },
  });
  const input = await params.adapter.ingest(params.raw);
  const messageReceivedAt = Date.now();
  const nativeMessageTimestamp = normalizeDiagnosticTimestamp(input?.timestamp);
  if (!input) {
    const admission: ChannelTurnAdmission = { kind: "drop", reason: "ingest-null" };
    emit({
      ...params,
      event: {
        stage: "ingest",
        event: "drop",
        admission: admission.kind,
        reason: admission.reason,
      },
    });
    return { admission, dispatched: false };
  }
  emit({
    ...params,
    event: { stage: "ingest", event: "done", messageId: input.id },
  });
  await appendTurnEvent({
    accountId: params.accountId,
    recorder: params.turnEvents,
    event: {
      type: "message.received",
      turnId: resolveTurnEventTurnId({
        accountId: params.accountId,
        channel: params.channel,
        messageId: input.id,
      }),
      actor: "user",
      channel: params.channel,
      target: params.accountId,
      status: "received",
      metadata: {
        messageId: input.id,
        nativeMessageTimestamp,
        messageReceivedAt,
        messageAgeMs: computePositiveDurationMs(messageReceivedAt, nativeMessageTimestamp),
      },
    },
  });

  const eventClass = (await params.adapter.classify?.(input)) ?? DEFAULT_EVENT_CLASS;
  if (!eventClass.canStartAgentTurn) {
    const admission: ChannelTurnAdmission = {
      kind: "handled",
      reason: `event:${eventClass.kind}`,
    };
    emit({
      ...params,
      event: {
        stage: "classify",
        event: "handled",
        messageId: input.id,
        admission: admission.kind,
        reason: admission.reason,
      },
    });
    return { admission, dispatched: false };
  }

  const preflight = normalizePreflight(await params.adapter.preflight?.(input, eventClass));
  const preflightAdmission = preflight.admission;
  if (
    preflightAdmission &&
    preflightAdmission.kind !== "dispatch" &&
    preflightAdmission.kind !== "observeOnly"
  ) {
    await recordDroppedChannelTurnHistory({
      input,
      preflight,
      admission: preflightAdmission,
    });
    emit({
      ...params,
      event: {
        stage: "preflight",
        event: preflightAdmission.kind === "handled" ? "handled" : "drop",
        messageId: input.id,
        admission: preflightAdmission.kind,
        reason: preflightAdmission.reason,
      },
    });
    return { admission: preflightAdmission, dispatched: false };
  }

  const resolved = await params.adapter.resolveTurn(input, eventClass, preflight);
  emit({
    ...params,
    accountId: resolved.accountId ?? params.accountId,
    event: {
      stage: "assemble",
      event: "done",
      messageId: input.id,
      sessionKey: resolved.routeSessionKey,
      admission: resolved.admission?.kind ?? "dispatch",
    },
  });

  const admission = resolved.admission ?? preflightAdmission ?? ({ kind: "dispatch" } as const);
  let result: ChannelTurnResult<TDispatchResult>;
  try {
    const dispatchResult = await dispatchResolvedChannelTurn(
      admission.kind === "observeOnly"
        ? {
            ...resolved,
            delivery: createNoopChannelEventDeliveryAdapter(),
            admission,
            log: params.log,
            turnEvents: params.turnEvents,
            messageId: input.id,
            turnTiming: {
              messageReceivedAt,
              nativeMessageTimestamp,
            },
          }
        : {
            ...resolved,
            admission,
            log: params.log,
            turnEvents: params.turnEvents,
            messageId: input.id,
            turnTiming: {
              messageReceivedAt,
              nativeMessageTimestamp,
            },
          },
    );
    result = dispatchResult.dispatched ? { ...dispatchResult, admission } : dispatchResult;
  } catch (err) {
    const failedResult: ChannelTurnResult<TDispatchResult> = {
      admission,
      dispatched: false,
      ctxPayload: resolved.ctxPayload,
      routeSessionKey: resolved.routeSessionKey,
    };
    try {
      await params.adapter.onFinalize?.(failedResult);
    } catch {
      // Preserve the original dispatch error.
    }
    emit({
      ...params,
      accountId: resolved.accountId ?? params.accountId,
      event: {
        stage: "finalize",
        event: "done",
        messageId: input.id,
        sessionKey: resolved.routeSessionKey,
        admission: admission.kind,
      },
    });
    throw err;
  }

  try {
    await params.adapter.onFinalize?.(result);
    emit({
      ...params,
      accountId: resolved.accountId ?? params.accountId,
      event: {
        stage: "finalize",
        event: "done",
        messageId: input.id,
        sessionKey: resolved.routeSessionKey,
        admission: admission.kind,
        ...projectTurnStateLogFields(result.dispatched ? result.turnState : undefined),
      },
    });
  } catch (err) {
    emit({
      ...params,
      accountId: resolved.accountId ?? params.accountId,
      event: {
        stage: "finalize",
        event: "error",
        messageId: input.id,
        sessionKey: resolved.routeSessionKey,
        admission: admission.kind,
        error: err,
        ...projectTurnStateLogFields(result.dispatched ? result.turnState : undefined),
      },
    });
    throw err;
  }

  return result;
}

export const runChannelInboundEvent = runChannelTurn;
