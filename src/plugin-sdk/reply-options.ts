import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type {
  ChannelTurnDeliveryAdapter,
  ChannelTurnResolved,
  RunChannelTurnParams,
} from "../channels/turn/types.js";

type PublicReplyOptions<T> = T extends undefined
  ? undefined
  : Omit<T, "internalEventExecution" | "onReplyOperationOwned">;

type PublicReplyFunction<T> = T extends (params: infer P) => infer R
  ? (params: PublicReplyParams<P>) => R
  : T;

type PublicReplyResolver<T> = T extends (
  ctx: infer C,
  options?: infer O,
  config?: infer F,
) => infer R
  ? (ctx: C, options?: PublicReplyOptions<O>, config?: F) => R
  : T;

export type PublicReplyParams<T> = {
  [K in keyof T]: K extends "replyOptions"
    ? PublicReplyOptions<T[K]>
    : K extends "replyResolver"
      ? PublicReplyResolver<T[K]>
      : K extends "dispatchReplyFromConfig" | "dispatchReplyWithBufferedBlockDispatcher"
        ? PublicReplyFunction<T[K]>
        : T[K];
};

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

/** Event custody is issued by core, never accepted from plugin reply options. */
export function publicReplyOptions(
  options: GetReplyOptions | undefined,
): GetReplyOptions | undefined {
  if (!options) {
    return undefined;
  }
  const publicOptions = { ...options };
  Reflect.deleteProperty(publicOptions, "internalEventExecution");
  Reflect.deleteProperty(publicOptions, "onReplyOperationOwned");
  return publicOptions;
}

export function publicChannelTurn<T extends object>(
  turn: T & { replyOptions?: GetReplyOptions },
): Omit<T, "replyOptions"> & { replyOptions?: GetReplyOptions } {
  return { ...turn, replyOptions: publicReplyOptions(turn.replyOptions) };
}

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
