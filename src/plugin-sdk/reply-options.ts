import { publicReplyOptions, type PublicReplyParams } from "../auto-reply/public-reply-options.js";
import type {
  ChannelTurnDeliveryAdapter,
  ChannelTurnResolved,
  RunChannelTurnParams,
} from "../channels/turn/types.js";

export { publicChannelTurn, publicReplyOptions } from "../auto-reply/public-reply-options.js";
export type { PublicReplyParams } from "../auto-reply/public-reply-options.js";

export type PublicChannelTurnParams<
  TRaw,
  TResult,
  TDelivery extends ChannelTurnDeliveryAdapter,
> = Omit<RunChannelTurnParams<TRaw, TResult, TDelivery>, "adapter"> & {
  adapter: Omit<RunChannelTurnParams<TRaw, TResult, TDelivery>["adapter"], "resolveTurn"> & {
    resolveTurn: (
      ...args: Parameters<RunChannelTurnParams<TRaw, TResult, TDelivery>["adapter"]["resolveTurn"]>
    ) =>
      | PublicReplyParams<ChannelTurnResolved<TResult, TDelivery>>
      | Promise<PublicReplyParams<ChannelTurnResolved<TResult, TDelivery>>>;
  };
};

/** Resolve plugin plans before core attaches its own admission authority. */
export function publicChannelTurnParams<
  TRaw,
  TResult,
  TDelivery extends ChannelTurnDeliveryAdapter,
>(
  params: PublicChannelTurnParams<TRaw, TResult, TDelivery>,
): RunChannelTurnParams<TRaw, TResult, TDelivery> {
  const adapter = params.adapter;
  const { classify, preflight, onFinalize } = adapter;
  return {
    ...params,
    adapter: {
      ingest: (raw) => adapter.ingest(raw),
      ...(classify ? { classify: (input) => classify.call(adapter, input) } : {}),
      ...(preflight
        ? { preflight: (input, eventClass) => preflight.call(adapter, input, eventClass) }
        : {}),
      resolveTurn: async (...args) => {
        const turn = await adapter.resolveTurn(...args);
        if (!("replyOptions" in turn)) {
          return turn;
        }
        return { ...turn, replyOptions: publicReplyOptions(turn.replyOptions) };
      },
      ...(onFinalize ? { onFinalize: (result) => onFinalize.call(adapter, result) } : {}),
    },
  };
}
