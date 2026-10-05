import { isExplicitCommandTurnContext } from "../../auto-reply/command-turn-detection.js";
import {
  withDispatchProcessedOutcomeSink,
  type DispatchProcessedNote,
} from "../../auto-reply/reply/dispatch-processed-outcome.js";
import { clearChannelHistoryIfEnabled } from "../../auto-reply/reply/history.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isRecentOutboundMessageIdentity } from "../message/outbound-echo.js";
import { recordChannelBotPairLoopAndCheckSuppression } from "./bot-loop-protection.js";
import {
  EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
  hasVisibleChannelTurnDispatch,
  type ChannelTurnDispatchResultLike,
} from "./dispatch-result.js";
import { deliverPendingDeliveryNotice } from "./pending-delivery-notice.js";
import type {
  ChannelTurnAdmission,
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnLogEvent,
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  PreparedChannelTurn,
} from "./types.js";

const log = createSubsystemLogger("channels/turn/execution");

function emit(
  params: Pick<
    PreparedChannelTurn,
    "log" | "channel" | "accountId" | "messageId" | "ctxPayload" | "routeSessionKey" | "admission"
  >,
  event: Pick<ChannelTurnLogEvent, "stage" | "event"> & Partial<ChannelTurnLogEvent>,
) {
  params.log?.({
    channel: params.channel,
    accountId: params.accountId,
    messageId: params.messageId,
    sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
    admission: params.admission?.kind ?? "dispatch",
    ...event,
  });
}

function clearPendingHistoryAfterTurn(params?: ChannelTurnHistoryFinalizeOptions): void {
  if (!params?.isGroup || !params.historyKey || !params.historyMap || params.limit === undefined) {
    return;
  }
  clearChannelHistoryIfEnabled({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    limit: params.limit,
  });
}

function resolveRecordSessionKey<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): string {
  const explicitSessionKey = params.record?.sessionKey;
  if (explicitSessionKey === undefined) {
    return params.ctxPayload.SessionKey ?? params.routeSessionKey;
  }
  const normalizedSessionKey = explicitSessionKey.trim();
  if (!normalizedSessionKey) {
    throw new Error("Channel turn record.sessionKey must be non-empty.");
  }
  if (normalizedSessionKey !== explicitSessionKey) {
    throw new Error("Channel turn record.sessionKey must not include surrounding whitespace.");
  }
  return explicitSessionKey;
}

function maybeWarnZeroCountVisibleDispatch<TDispatchResult>(
  params: Pick<
    PreparedChannelTurn<TDispatchResult>,
    "admission" | "channel" | "ctxPayload" | "messageId" | "routeSessionKey"
  > & {
    dispatchResult: TDispatchResult;
    processedOutcome?: DispatchProcessedNote;
    log?: (event: ChannelTurnLogEvent) => void;
  },
): void {
  if (
    params.admission?.kind === "observeOnly" ||
    params.ctxPayload.InternalTurnSource !== undefined
  ) {
    return;
  }
  const dispatchResult = params.dispatchResult as ChannelTurnDispatchResultLike;
  if (dispatchResult?.deferredToActiveRun) {
    return;
  }
  // The canonical visible signal includes observed delivery paths with zero queued counts.
  if (hasVisibleChannelTurnDispatch(dispatchResult)) {
    return;
  }
  // The processed outcome names the dispatch branch that produced the silence,
  // so operators can tell a benign duplicate or busy skip from a lost message.
  // It stays in this core-owned log line; the channel log event is a plugin
  // contract and must not widen.
  const processed = params.processedOutcome;
  const cause = processed
    ? `${processed.outcome}${processed.reason ? `:${processed.reason}` : ""}`
    : undefined;
  log.warn(
    `visible channel turn dispatched with no queued reply payloads: channel=${params.channel} ` +
      `messageId=${params.messageId ?? "unknown"} sessionKey=${
        params.ctxPayload.SessionKey ?? params.routeSessionKey
      } cause=${cause ?? "unknown"}`,
  );
  emit(params, {
    stage: "dispatch",
    event: "warning",
    reason: "zero-count-visible-dispatch",
  });
}

function dropPreparedChannelTurn<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
  reason: "bot-loop-protection" | "outbound-echo",
  messageId = params.messageId,
): ChannelTurnResult<TDispatchResult> {
  const admission: ChannelTurnAdmission = { kind: "drop", reason };
  emit(params, {
    stage: "authorize",
    event: "drop",
    messageId,
    admission: admission.kind,
    reason: admission.reason,
  });
  return {
    admission,
    dispatched: false,
    ctxPayload: params.ctxPayload,
    routeSessionKey: params.routeSessionKey,
  };
}

function resolveBotLoopProtectionDrop<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): ChannelTurnResult<TDispatchResult> | undefined {
  return params.botLoopProtection &&
    recordChannelBotPairLoopAndCheckSuppression(params.botLoopProtection).suppressed
    ? dropPreparedChannelTurn(params, "bot-loop-protection")
    : undefined;
}

function resolveOutboundEchoDrop<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): ChannelTurnResult<TDispatchResult> | undefined {
  const conversationId = [params.ctxPayload.NativeChannelId, params.ctxPayload.ChatId].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!conversationId) {
    return undefined;
  }
  const messageIds = [
    params.messageId,
    params.ctxPayload.MessageSidFull,
    params.ctxPayload.MessageSid,
  ];
  const matchedMessageId = messageIds.find(
    (messageId): messageId is string =>
      typeof messageId === "string" &&
      isRecentOutboundMessageIdentity({
        channel: params.channel,
        accountId: params.accountId,
        conversationId,
        messageId,
      }),
  );
  const sourceId = params.outboundEchoSourceId?.trim();
  const matchesSource = sourceId
    ? isRecentOutboundMessageIdentity({
        channel: params.channel,
        accountId: params.accountId,
        conversationId,
        sourceId,
      })
    : false;
  if (!matchedMessageId && !matchesSource) {
    return undefined;
  }
  return dropPreparedChannelTurn(params, "outbound-echo", params.messageId ?? matchedMessageId);
}

export async function runPreparedChannelTurnCore<
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
  const outboundEchoDrop = resolveOutboundEchoDrop(params);
  if (outboundEchoDrop) {
    clearPendingHistoryAfterTurn(params.history);
    await params.runDispatchLifecycle?.onDispatchSkipped("outboundEcho");
    return outboundEchoDrop;
  }
  const botLoopDrop = resolveBotLoopProtectionDrop(params);
  if (botLoopDrop) {
    clearPendingHistoryAfterTurn(params.history);
    await params.runDispatchLifecycle?.onDispatchSkipped("botLoopProtection");
    return botLoopDrop;
  }
  // Durable ingress releases deferred lanes so one sender's burst can keep
  // coalescing; record and dispatch still follow ingress order. Control
  // commands keep their immediate dispatch, matching their debounce bypass.
  const admissionTurn = params.runDispatchLifecycle?.turnAdoptionLifecycle?.admissionTurn;
  if (admissionTurn && !isExplicitCommandTurnContext(params.ctxPayload, params.cfg)) {
    await admissionTurn.wait();
  }
  // Native commands can execute in an isolated command session while updating the
  // provider-routed target session. Keep that record target separate from dispatch.
  // The caller retains pending history across turns; finalize every admitted terminal
  // path before the next group turn can replay stale context.
  try {
    const recordSessionKey = resolveRecordSessionKey(params);
    if (params.ctxPayload.SessionTranscriptContext) {
      const { mergeSessionTranscriptContext } =
        await import("../inbound-event/session-transcript-context.runtime.js");
      await mergeSessionTranscriptContext({
        agentId: params.ctxPayload.AgentId,
        ctx: params.ctxPayload,
        sessionKey: recordSessionKey,
        storePath: params.storePath,
      });
    }
    emit(params, {
      stage: "record",
      event: "start",
      sessionKey: recordSessionKey,
      admission: admission.kind,
    });
    try {
      await params.recordInboundSession({
        storePath: params.storePath,
        sessionKey: recordSessionKey,
        ctx: params.ctxPayload,
        groupResolution: params.record?.groupResolution,
        createIfMissing: params.record?.createIfMissing,
        updateLastRoute: params.record?.updateLastRoute,
        onRecordError: params.record?.onRecordError ?? (() => undefined),
        trackSessionMetaTask: params.record?.trackSessionMetaTask,
      });
      emit(params, {
        stage: "record",
        event: "done",
        sessionKey: recordSessionKey,
        admission: admission.kind,
      });
      await params.afterRecord?.();
      await deliverPendingDeliveryNotice(recordSessionKey, params.storePath);
    } catch (err) {
      emit(params, {
        stage: "record",
        event: "error",
        sessionKey: recordSessionKey,
        admission: admission.kind,
        error: err,
      });
      try {
        await params.onPreDispatchFailure?.(err);
      } catch {
        // Preserve the original session-recording error.
      }
      throw err;
    }

    emit(params, {
      stage: "dispatch",
      event: "start",
      admission: admission.kind,
    });
    let dispatchResult: TDispatchResult;
    try {
      let processedOutcome: DispatchProcessedNote | undefined;
      if (admission.kind === "observeOnly") {
        if (options.suppressObserveOnlyDispatch) {
          await params.runDispatchLifecycle?.onDispatchSkipped("observeOnly");
        } else {
          await params.runDispatch();
        }
        dispatchResult = (params.observeOnlyDispatchResult ?? {
          queuedFinal: false,
          counts: EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
        }) as TDispatchResult;
      } else {
        // The sink carries the dispatch's terminal outcome to the warning below
        // without widening the plugin-visible dispatch result contract.
        ({ result: dispatchResult, processedOutcome } = await withDispatchProcessedOutcomeSink(() =>
          params.runDispatch(),
        ));
      }
      maybeWarnZeroCountVisibleDispatch({
        ...params,
        admission,
        dispatchResult,
        processedOutcome,
      });
    } catch (err) {
      emit(params, {
        stage: "dispatch",
        event: "error",
        admission: admission.kind,
        error: err,
      });
      throw err;
    }
    emit(params, {
      stage: "dispatch",
      event: "done",
      admission: admission.kind,
    });

    return {
      admission,
      dispatched: true,
      ctxPayload: params.ctxPayload,
      routeSessionKey: params.routeSessionKey,
      dispatchResult,
    };
  } finally {
    clearPendingHistoryAfterTurn(params.history);
  }
}

export async function runPreparedChannelTurn<
  TDispatchResult = DispatchedChannelTurnResult["dispatchResult"],
>(params: PreparedChannelTurn<TDispatchResult>): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedChannelTurnCore(params, { suppressObserveOnlyDispatch: true });
}
