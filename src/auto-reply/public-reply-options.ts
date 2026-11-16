import type { GetReplyOptions } from "./get-reply-options.types.js";

type PublicReplyOptions<T> = T extends undefined
  ? undefined
  : Omit<
      T,
      | "internalEventExecution"
      | "onReplyOperationAdmitted"
      | "onReplyOperationOwned"
      | "assertChannelAuthority"
    >;

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

/** Event custody is issued by core, never accepted from plugin reply options. */
export function publicReplyOptions(
  options: GetReplyOptions | undefined,
): GetReplyOptions | undefined {
  if (!options) {
    return undefined;
  }
  const publicOptions = { ...options };
  Reflect.deleteProperty(publicOptions, "internalEventExecution");
  Reflect.deleteProperty(publicOptions, "onReplyOperationAdmitted");
  Reflect.deleteProperty(publicOptions, "onReplyOperationOwned");
  return publicOptions;
}

export function publicChannelTurn<T extends object>(
  turn: T & { replyOptions?: GetReplyOptions },
): Omit<T, "replyOptions"> & { replyOptions?: GetReplyOptions } {
  return { ...turn, replyOptions: publicReplyOptions(turn.replyOptions) };
}
