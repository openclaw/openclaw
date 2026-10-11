import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { DispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.types.js";
import type {
  ChannelTurnDeliveryAdapter,
  ChannelTurnResolved,
  RunChannelTurnParams,
} from "../channels/turn/types.js";

type PublicReplyOptions<T> = T extends undefined
  ? undefined
  : Omit<T, "internalEventExecution" | "onReplyOperationOwned" | "assertChannelAuthority">;

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

const coreChannelReplyDispatchers = new WeakMap<object, DispatchReplyFromConfig>();

/** The registered runtime reply function sanitizes direct plugin calls; channel turns retain its core owner. */
export function createPublicChannelReplyDispatch(coreDispatch: DispatchReplyFromConfig) {
  const publicDispatch = (params: PublicReplyParams<Parameters<DispatchReplyFromConfig>[0]>) =>
    coreDispatch(publicChannelTurn(params));
  coreChannelReplyDispatchers.set(publicDispatch, coreDispatch);
  return publicDispatch;
}

export function resolveCoreChannelReplyDispatch(
  publicDispatch: object,
): DispatchReplyFromConfig | undefined {
  return coreChannelReplyDispatchers.get(publicDispatch);
}

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
  Reflect.deleteProperty(publicOptions, "assertChannelAuthority");
  return publicOptions;
}

export function publicChannelTurn<T extends object>(
  turn: T & { replyOptions?: GetReplyOptions },
): Omit<T, "replyOptions"> & { replyOptions?: GetReplyOptions } {
  const dispatch = "dispatchReplyFromConfig" in turn ? turn.dispatchReplyFromConfig : undefined;
  const coreDispatch =
    typeof dispatch === "function" ? coreChannelReplyDispatchers.get(dispatch) : undefined;
  return {
    ...turn,
    replyOptions: publicReplyOptions(turn.replyOptions),
    ...(coreDispatch ? { dispatchReplyFromConfig: coreDispatch } : {}),
  };
}

/** Resolve plugin plans before core attaches its own admission authority. */
export function publicChannelTurnParams<
  TRaw,
  TResult,
  TDelivery extends ChannelTurnDeliveryAdapter,
>(
  params: PublicChannelTurnParams<TRaw, TResult, TDelivery>,
): RunChannelTurnParams<TRaw, TResult, TDelivery> {
  return {
    ...params,
    adapter: {
      ...params.adapter,
      resolveTurn: async (...args) => {
        const turn = await params.adapter.resolveTurn(...args);
        const dispatch =
          "dispatchReplyFromConfig" in turn ? turn.dispatchReplyFromConfig : undefined;
        const coreDispatch =
          typeof dispatch === "function" ? coreChannelReplyDispatchers.get(dispatch) : undefined;
        if (!("replyOptions" in turn) && !coreDispatch) {
          return turn;
        }
        return {
          ...turn,
          ...("replyOptions" in turn
            ? { replyOptions: publicReplyOptions(turn.replyOptions) }
            : {}),
          ...(coreDispatch ? { dispatchReplyFromConfig: coreDispatch } : {}),
        };
      },
    },
  };
}
