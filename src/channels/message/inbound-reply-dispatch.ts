import { withReplyDispatcher } from "../../auto-reply/dispatch.js";
import type { GetReplyOptions } from "../../auto-reply/get-reply-options.types.js";
import {
  dispatchReplyFromConfig,
  type DispatchFromConfigResult,
} from "../../auto-reply/reply/dispatch-from-config.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.types.js";
import type { ReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeOutboundReplyPayload,
  type OutboundReplyPayload,
} from "../../infra/outbound/reply-payload-normalize.js";
import {
  hasFinalChannelTurnDispatch,
  hasVisibleChannelTurnDispatch,
  deliverInboundReplyWithMessageSendContext,
  dispatchChannelInboundReply as dispatchChannelInboundReplyCore,
  isDurableInboundReplyDeliveryHandled,
  resolveChannelTurnDispatchCounts,
  recordDroppedChannelInboundHistory,
  runChannelInboundEvent as runChannelInboundEventCore,
  runPreparedInboundReply as runPreparedInboundReplyCore,
  throwIfDurableInboundReplyDeliveryFailed,
} from "../turn/kernel.js";
import type {
  ChannelTurnResult,
  DispatchedChannelTurnResult,
  DurableInboundReplyDeliveryOptions,
} from "../turn/kernel.js";
import type {
  AssembledChannelTurn,
  PreparedChannelTurn,
  RunChannelTurnParams,
} from "../turn/types.js";

export type {
  ChannelTurnDroppedHistoryOptions,
  ChannelTurnDroppedHistoryOptions as ChannelInboundDroppedHistoryOptions,
  ChannelTurnRecordOptions,
  ChannelTurnRecordOptions as InboundReplyRecordOptions,
} from "../turn/types.js";
export type { DurableInboundReplyDeliveryParams } from "../turn/kernel.js";
export type { ChannelBotLoopProtectionFacts } from "../turn/kernel.js";
export { recordChannelBotPairLoopAndCheckSuppression } from "../turn/kernel.js";

type ReplyOptionsWithoutModelSelected = Omit<
  Omit<GetReplyOptions, "onBlockReply">,
  "onModelSelected"
>;
type RecordInboundSessionFn = typeof import("../session.js").recordInboundSession;

type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onBlockReply">;
/** Parameters for running a raw inbound channel event through the shared turn pipeline. */
export type ChannelInboundEventRunnerParams<
  TRaw,
  TDispatchResult = DispatchFromConfigResult,
> = RunChannelTurnParams<TRaw, TDispatchResult>;
/** Prepared turn shape kept for legacy inbound-reply naming. */
export type PreparedInboundReply<TDispatchResult> = PreparedChannelTurn<TDispatchResult>;
/** Assembled dispatch context kept for legacy inbound-reply naming. */
export type AssembledInboundReply = AssembledChannelTurn;
/** Turn result shape kept for legacy inbound-reply naming. */
export type InboundReplyDispatchResult<TDispatchResult> = ChannelTurnResult<TDispatchResult>;

/** Run an already prepared inbound reply through shared session-record + dispatch ordering. */
type PreparedInboundReplyTurnWithBotLoopProtection<TDispatchResult> =
  PreparedChannelTurn<TDispatchResult> & {
    botLoopProtection: NonNullable<PreparedChannelTurn<TDispatchResult>["botLoopProtection"]>;
  };

type PreparedInboundReplyTurnWithoutBotLoopProtection<TDispatchResult> = Omit<
  PreparedChannelTurn<TDispatchResult>,
  "botLoopProtection"
> & {
  botLoopProtection?: undefined;
};

export function runPreparedInboundReply<TDispatchResult>(
  params: PreparedInboundReplyTurnWithBotLoopProtection<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runPreparedInboundReply<TDispatchResult>(
  params: PreparedInboundReplyTurnWithoutBotLoopProtection<TDispatchResult>,
): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
export function runPreparedInboundReply<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export async function runPreparedInboundReply<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedInboundReplyCore(params);
}

/** @deprecated Use `runPreparedInboundReply`. */
export function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedInboundReplyTurnWithBotLoopProtection<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedInboundReplyTurnWithoutBotLoopProtection<TDispatchResult>,
): Promise<DispatchedChannelTurnResult<TDispatchResult>>;
export function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>>;
export async function runPreparedInboundReplyTurn<TDispatchResult>(
  params: PreparedChannelTurn<TDispatchResult>,
): Promise<ChannelTurnResult<TDispatchResult>> {
  return await runPreparedInboundReply(params);
}

export async function runChannelInboundEvent<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: ChannelInboundEventRunnerParams<TRaw, TDispatchResult>,
) {
  return await runChannelInboundEventCore(params);
}

/** @deprecated Use `runChannelInboundEvent`. */
export async function runInboundReplyTurn<TRaw, TDispatchResult = DispatchFromConfigResult>(
  params: ChannelInboundEventRunnerParams<TRaw, TDispatchResult>,
) {
  return await runChannelInboundEvent(params);
}

export async function dispatchChannelInboundReply(params: AssembledInboundReply) {
  return await dispatchChannelInboundReplyCore(params);
}

export {
  hasFinalChannelTurnDispatch as hasFinalInboundReplyDispatch,
  hasVisibleChannelTurnDispatch as hasVisibleInboundReplyDispatch,
  deliverInboundReplyWithMessageSendContext as deliverDurableInboundReplyPayload,
  deliverInboundReplyWithMessageSendContext,
  recordDroppedChannelInboundHistory as recordDroppedChannelTurnHistory,
  recordDroppedChannelInboundHistory,
  resolveChannelTurnDispatchCounts as resolveInboundReplyDispatchCounts,
};

/** Run `dispatchReplyFromConfig` with a dispatcher that always gets its settled callback. */
export async function dispatchReplyFromConfigWithSettledDispatcher(params: {
  cfg: OpenClawConfig;
  ctxPayload: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  onSettled: () => void | Promise<void>;
  replyOptions?: ReplyDispatchFromConfigOptions;
  configOverride?: OpenClawConfig;
}): Promise<DispatchFromConfigResult> {
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    onSettled: params.onSettled,
    // withReplyDispatcher owns the finally path so streamed/block dispatchers
    // release typing, buffers, and channel resources even when dispatch throws.
    run: () =>
      dispatchReplyFromConfig({
        ctx: params.ctxPayload,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
        configOverride: params.configOverride,
      }),
  });
}

/** Assemble the common inbound reply dispatch dependencies for a resolved route. */
export function buildInboundReplyDispatchBase(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  route: {
    agentId: string;
    sessionKey: string;
  };
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  core: {
    channel: {
      session: {
        recordInboundSession: RecordInboundSessionFn;
      };
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
      };
    };
  };
}) {
  return {
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    agentId: params.route.agentId,
    routeSessionKey: params.route.sessionKey,
    storePath: params.storePath,
    ctxPayload: params.ctxPayload,
    recordInboundSession: params.core.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
  };
}

type BuildInboundReplyDispatchBaseParams = Parameters<typeof buildInboundReplyDispatchBase>[0];
type RecordChannelMessageReplyDispatchParams = {
  /** Config used to resolve agent/session/reply settings for the inbound turn. */
  cfg: OpenClawConfig;
  /** Channel id that owns the inbound reply turn. */
  channel: string;
  /** Optional account scope for multi-account channel adapters. */
  accountId?: string;
  /** Agent selected by route resolution before dispatch starts. */
  agentId: string;
  /** Stable session key used for inbound session history. */
  routeSessionKey: string;
  /** Store path used by the reply dispatcher for session state. */
  storePath: string;
  /** Finalized inbound message context passed to prompt templating. */
  ctxPayload: FinalizedMsgContext;
  /** Session recorder that must run before reply dispatch. */
  recordInboundSession: RecordInboundSessionFn;
  /** Buffered reply dispatcher used to produce tool/block/final reply deliveries. */
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
  /** Legacy outbound delivery callback used when durable message delivery is unavailable. */
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  /** Durable delivery options, or false to force the legacy deliver callback. */
  durable?: false | DurableInboundReplyDeliveryOptions;
  /** Error sink for session-record failures that should not skip dispatch. */
  onRecordError: (err: unknown) => void;
  /** Error sink for reply delivery failures, tagged by reply kind. */
  onDispatchError: (err: unknown, info: { kind: string }) => void;
  /** Reply options forwarded without block-dispatcher/model-selection overrides. */
  replyOptions?: ReplyOptionsWithoutModelSelected;
};

/**
 * Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn.
 *
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter via `defineChannelMessageAdapter(...)` and route
 * sends through `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
export async function dispatchChannelMessageReplyWithBase(
  params: BuildInboundReplyDispatchBaseParams &
    Pick<
      RecordChannelMessageReplyDispatchParams,
      "deliver" | "durable" | "onRecordError" | "onDispatchError" | "replyOptions"
    >,
): Promise<void> {
  const dispatchBase = buildInboundReplyDispatchBase(params);
  await recordChannelMessageReplyDispatch({
    ...dispatchBase,
    deliver: params.deliver,
    durable: params.durable,
    onRecordError: params.onRecordError,
    onDispatchError: params.onDispatchError,
    replyOptions: params.replyOptions,
  });
}

/**
 * Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn.
 *
 * @deprecated Legacy inbound reply helper. New channel plugins should expose a
 * `message` adapter via `defineChannelMessageAdapter(...)` and use
 * `dispatchChannelMessageReplyWithBase` only for compatibility dispatchers that
 * have not moved to the message lifecycle yet.
 */
export async function dispatchInboundReplyWithBase(
  params: Parameters<typeof dispatchChannelMessageReplyWithBase>[0],
): Promise<void> {
  await dispatchChannelMessageReplyWithBase(params);
}

/**
 * Record the inbound session first, then dispatch the reply using normalized outbound delivery.
 *
 * @deprecated Compatibility reply-dispatch bridge. New channel plugins should
 * expose a `message` adapter via `defineChannelMessageAdapter(...)` and route
 * sends through `deliverInboundReplyWithMessageSendContext(...)` or
 * `sendDurableMessageBatch(...)`.
 */
export async function recordChannelMessageReplyDispatch(
  params: RecordChannelMessageReplyDispatchParams,
): Promise<void> {
  await dispatchChannelInboundReplyCore({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    agentId: params.agentId,
    routeSessionKey: params.routeSessionKey,
    storePath: params.storePath,
    ctxPayload: params.ctxPayload,
    recordInboundSession: params.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: params.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      preparePayload: (payload) =>
        payload && typeof payload === "object" ? normalizeOutboundReplyPayload(payload) : {},
      deliver: async (payload, info) => {
        if (params.durable) {
          // Durable delivery owns normalized message lifecycle results; fall
          // back only when the adapter reports that this payload was unhandled.
          const durable = await deliverInboundReplyWithMessageSendContext({
            cfg: params.cfg,
            channel: params.channel,
            accountId: params.accountId,
            agentId: params.agentId,
            ctxPayload: params.ctxPayload,
            payload,
            info,
            ...params.durable,
          });
          throwIfDurableInboundReplyDeliveryFailed(durable);
          if (isDurableInboundReplyDeliveryHandled(durable)) {
            return durable.delivery;
          }
        }
        // Compatibility callers still own legacy delivery when durable routing
        // is disabled or cannot handle this specific normalized payload.
        return await params.deliver(payload as OutboundReplyPayload);
      },
      onError: params.onDispatchError,
    },
    replyPipeline: {},
    replyOptions: params.replyOptions,
    record: {
      onRecordError: params.onRecordError,
    },
  });
}

/**
 * Record the inbound session first, then dispatch the reply using normalized outbound delivery.
 *
 * @deprecated Legacy inbound reply helper. New channel plugins should expose a
 * `message` adapter via `defineChannelMessageAdapter(...)` and use
 * `recordChannelMessageReplyDispatch` only for compatibility dispatchers that
 * have not moved to the message lifecycle yet.
 */
export async function recordInboundSessionAndDispatchReply(
  params: RecordChannelMessageReplyDispatchParams,
): Promise<void> {
  await recordChannelMessageReplyDispatch(params);
}

/** @deprecated Compatibility helper for legacy reply dispatch bridges. */
export const buildChannelMessageReplyDispatchBase = buildInboundReplyDispatchBase;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export const hasFinalChannelMessageReplyDispatch = hasFinalChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export const hasVisibleChannelMessageReplyDispatch = hasVisibleChannelTurnDispatch;
/** @deprecated Compatibility helper for legacy reply dispatch results. */
export const resolveChannelMessageReplyDispatchCounts = resolveChannelTurnDispatchCounts;
