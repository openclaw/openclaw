import { recordChannelHistoryEntryWithMedia } from "../../auto-reply/reply/history.js";
import { toHistoryMediaEntries } from "../inbound-event/media.js";
import { runPreparedChannelTurn } from "./execution.js";
import {
  assembleResolvedChannelTurn,
  dispatchAssembledChannelTurn,
  dispatchRoutedChannelTurn,
} from "./lifecycle.js";
import type {
  AssembledChannelTurn,
  ChannelEventClass,
  ChannelProviderOwnedMessageSendingDeliveryAdapter,
  ChannelTurnAdmission,
  ChannelTurnDeliveryAdapter,
  ChannelTurnLogEvent,
  ChannelTurnPlan,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  NormalizedTurnInput,
  PreflightFacts,
  PreparedChannelTurn,
  RunChannelTurnParams,
} from "./types.js";

const DEFAULT_EVENT_CLASS: ChannelEventClass = {
  kind: "message",
  canStartAgentTurn: true,
};

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

function assertPreparedDispatchLifecycle<TDispatchResult>(
  turn: PreparedChannelTurn<TDispatchResult>,
  turnAdoptionLifecycle: RunChannelTurnParams<unknown>["turnAdoptionLifecycle"],
): void {
  if (!turnAdoptionLifecycle) {
    return;
  }
  const lifecycle = turn.runDispatchLifecycle;
  if (!lifecycle) {
    throw new Error(
      "runChannelInboundEvent prepared turns must declare runDispatchLifecycle when creating runDispatch",
    );
  }
  if (lifecycle.turnAdoptionLifecycle !== turnAdoptionLifecycle) {
    throw new Error(
      "runChannelInboundEvent prepared turn runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
    );
  }
}

function resolveDroppedHistorySender(input: NormalizedTurnInput, preflight: PreflightFacts) {
  return (
    preflight.message?.senderLabel ??
    preflight.message?.envelopeFrom ??
    (typeof input.raw === "object" &&
    input.raw &&
    "sender" in input.raw &&
    typeof input.raw.sender === "string"
      ? input.raw.sender
      : undefined) ??
    "unknown"
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
  const body =
    params.preflight.message?.bodyForAgent ??
    params.preflight.message?.body ??
    params.preflight.message?.rawBody ??
    params.input.textForAgent ??
    params.input.rawText;
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
  await recordChannelHistoryEntryWithMedia({
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

export async function runChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<
    TRaw,
    TDispatchResult,
    ChannelProviderOwnedMessageSendingDeliveryAdapter
  >,
): Promise<ChannelTurnResult<TDispatchResult>>;
export async function runChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(params: RunChannelTurnParams<TRaw, TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>>;
export async function runChannelTurn<
  TRaw,
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(
  params: RunChannelTurnParams<TRaw, TDispatchResult, ChannelTurnDeliveryAdapter>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  const emit = (event: Omit<ChannelTurnLogEvent, "channel">) => {
    params.log?.({
      channel: params.channel,
      accountId: params.accountId,
      ...event,
    });
  };
  emit({ stage: "ingest", event: "start" });
  const input = await params.adapter.ingest(params.raw);
  if (!input) {
    const admission: ChannelTurnAdmission = { kind: "drop", reason: "ingest-null" };
    emit({
      stage: "ingest",
      event: "drop",
      admission: admission.kind,
      reason: admission.reason,
    });
    return { admission, dispatched: false };
  }
  emit({ stage: "ingest", event: "done", messageId: input.id });

  const eventClass = (await params.adapter.classify?.(input)) ?? DEFAULT_EVENT_CLASS;
  if (!eventClass.canStartAgentTurn) {
    const admission: ChannelTurnAdmission = {
      kind: "handled",
      reason: `event:${eventClass.kind}`,
    };
    emit({
      stage: "classify",
      event: "handled",
      messageId: input.id,
      admission: admission.kind,
      reason: admission.reason,
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
      stage: "preflight",
      event: preflightAdmission.kind === "handled" ? "handled" : "drop",
      messageId: input.id,
      admission: preflightAdmission.kind,
      reason: preflightAdmission.reason,
    });
    return { admission: preflightAdmission, dispatched: false };
  }

  const unresolved = await params.adapter.resolveTurn(input, eventClass, preflight);
  const isRoutedTurn = "route" in unresolved && !("runDispatch" in unresolved);
  const resolved = assembleResolvedChannelTurn(unresolved);
  emit({
    accountId: resolved.accountId ?? params.accountId,
    stage: "assemble",
    event: "done",
    messageId: input.id,
    sessionKey: resolved.routeSessionKey,
    admission: resolved.admission?.kind ?? "dispatch",
  });

  const admission = resolved.admission ?? preflightAdmission ?? ({ kind: "dispatch" } as const);
  const emitFinalize = (event: { event: "done" | "error"; error?: unknown }) =>
    emit({
      accountId: resolved.accountId ?? params.accountId,
      stage: "finalize",
      messageId: input.id,
      sessionKey: resolved.routeSessionKey,
      admission: admission.kind,
      ...event,
    });
  const dispatchContext = {
    admission,
    log: params.log,
    messageId: input.id,
  };
  const assembledDispatchContext = params.turnAdoptionLifecycle
    ? { ...dispatchContext, turnAdoptionLifecycle: params.turnAdoptionLifecycle }
    : dispatchContext;
  let result: ChannelTurnResult<TDispatchResult>;
  try {
    if ("runDispatch" in resolved) {
      assertPreparedDispatchLifecycle(resolved, params.turnAdoptionLifecycle);
    }
    const dispatchResult = (
      "runDispatch" in resolved
        ? await runPreparedChannelTurn({
            ...resolved,
            ...dispatchContext,
          })
        : isRoutedTurn
          ? await dispatchRoutedChannelTurn({
              ...(unresolved as ChannelTurnPlan<ChannelTurnDeliveryAdapter>),
              ...assembledDispatchContext,
            })
          : await dispatchAssembledChannelTurn({
              ...(resolved as AssembledChannelTurn),
              ...assembledDispatchContext,
            })
    ) as ChannelTurnResult<TDispatchResult>;
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
    emitFinalize({ event: "done" });
    throw err;
  }

  try {
    await params.adapter.onFinalize?.(result);
    emitFinalize({ event: "done" });
  } catch (err) {
    emitFinalize({ event: "error", error: err });
    throw err;
  }

  return result;
}
