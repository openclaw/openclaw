/**
 * @deprecated Compatibility shim for openclaw/skills' openclaw-zulip plugin and
 * tloncorp/tlon-apps. Removal is targeted for the next Plugin SDK major.
 */
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { mapReplyDispatchCounts } from "../auto-reply/reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import {
  deliverInboundReplyWithMessageSendContextCore,
  isDurableInboundReplyDeliveryHandled,
  throwIfDurableInboundReplyDeliveryFailed,
  type DurableInboundReplyDeliveryOptions,
} from "../channels/turn/durable-delivery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOutboundReplyPayloadCore,
  type OutboundReplyPayload,
} from "../infra/outbound/reply-payload-normalize.js";
import { dispatchChannelInboundReply } from "./channel-inbound.js";
import type { DispatchReplyWithBufferedBlockDispatcher } from "./reply-dispatch-runtime.js";

type ReplyOptionsWithoutModelSelected = Omit<
  Omit<GetReplyOptions, "onBlockReply">,
  "onModelSelected"
>;
type RecordInboundSessionFn = typeof import("../channels/session.js").recordInboundSession;

function withLegacyDispatchCounts(
  dispatch: DispatchReplyWithBufferedBlockDispatcher,
): DispatchReplyWithBufferedBlockDispatcher {
  // @deprecated Remove this receipt-to-count projection with the shim in the next Plugin SDK major.
  return async (params) => {
    const result = await dispatch(params);
    const receipt = result.settledReceipt;
    if (!receipt) {
      return result;
    }
    const counts = mapReplyDispatchCounts(receipt.counts, (entry) => entry.delivered);
    const failedCounts = mapReplyDispatchCounts(
      receipt.counts,
      (entry) => entry.failedBeforeSend + entry.failedAfterSend,
    );
    return {
      ...result,
      queuedFinal: counts.final > 0,
      counts,
      ...(Object.values(failedCounts).some((count) => count > 0) ? { failedCounts } : {}),
    };
  };
}

function buildInboundReplyDispatchBase(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  route: { agentId: string; sessionKey: string };
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  core: {
    channel: {
      session: { recordInboundSession: RecordInboundSessionFn };
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
    dispatchReplyWithBufferedBlockDispatcher: withLegacyDispatchCounts(
      params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ),
  };
}

type BuildInboundReplyDispatchBaseParams = Parameters<typeof buildInboundReplyDispatchBase>[0];
type RecordInboundSessionAndDispatchReplyParams = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSessionFn;
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  durable?: false | DurableInboundReplyDeliveryOptions;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
  replyOptions?: ReplyOptionsWithoutModelSelected;
};

export async function dispatchInboundReplyWithBase(
  params: BuildInboundReplyDispatchBaseParams &
    Pick<
      RecordInboundSessionAndDispatchReplyParams,
      "deliver" | "durable" | "onRecordError" | "onDispatchError" | "replyOptions"
    >,
): Promise<void> {
  const base = buildInboundReplyDispatchBase(params);
  const { deliver, durable, onDispatchError, onRecordError, replyOptions } = params;
  await dispatchChannelInboundReply({
    ...base,
    delivery: {
      preparePayload: (payload): OutboundReplyPayload =>
        payload && typeof payload === "object" ? normalizeOutboundReplyPayloadCore(payload) : {},
      deliver: async (payload, info) => {
        if (durable) {
          const result = await deliverInboundReplyWithMessageSendContextCore({
            cfg: base.cfg,
            channel: base.channel,
            accountId: base.accountId,
            agentId: base.agentId,
            ctxPayload: base.ctxPayload,
            payload,
            info,
            ...durable,
          });
          throwIfDurableInboundReplyDeliveryFailed(result);
          if (isDurableInboundReplyDeliveryHandled(result)) {
            return result.delivery;
          }
        }
        return await deliver(payload as OutboundReplyPayload);
      },
      onError: onDispatchError,
    },
    replyPipeline: {},
    replyOptions,
    record: { onRecordError },
  });
}

export {
  dispatchChannelInboundReply,
  hasFinalInboundReplyDispatch,
  hasVisibleInboundReplyDispatch,
  recordChannelBotPairLoopAndCheckSuppression,
  recordDroppedChannelInboundHistory,
  recordDroppedChannelTurnHistory,
  resolveInboundReplyDispatchCounts,
  runChannelInboundEvent,
  runPreparedInboundReply,
} from "./channel-inbound.js";
export { deliverInboundReplyWithMessageSendContext } from "./channel-outbound.js";
export type {
  AssembledInboundReply,
  ChannelBotLoopProtectionFacts,
  ChannelInboundDroppedHistoryOptions,
  ChannelInboundEventRunnerParams,
  ChannelTurnDroppedHistoryOptions,
  ChannelTurnRecordOptions,
  DurableInboundReplyDeliveryParams,
  InboundReplyDispatchResult,
  InboundReplyRecordOptions,
  PreparedInboundReply,
} from "./channel-inbound.js";
