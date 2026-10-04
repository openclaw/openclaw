import type {
  DispatchReplyWithBufferedBlockDispatcher as CoreBufferedDispatcher,
  DispatchReplyWithDispatcher as CoreDispatcher,
} from "../auto-reply/reply/provider-dispatcher.types.js";
import { createLazyPromise, createLazyRuntimeMethodBinder } from "../shared/lazy-runtime.js";
import { publicReplyOptions, type PublicReplyParams } from "./reply-options.js";
/**
 * Runtime SDK subpath for lazy reply dispatch and inbound-context helpers.
 */
export { resolveChunkMode } from "../auto-reply/chunk.js";
export { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
export { finalizeInboundContextForSdk as finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";

export type DispatchReplyWithBufferedBlockDispatcher = (
  params: PublicReplyParams<Parameters<CoreBufferedDispatcher>[0]>,
) => ReturnType<CoreBufferedDispatcher>;
export type DispatchReplyWithDispatcher = (
  params: PublicReplyParams<Parameters<CoreDispatcher>[0]>,
) => ReturnType<CoreDispatcher>;
export type { ReplyPayload } from "./reply-payload.js";

const loadProviderDispatcherRuntimeModule = createLazyPromise(
  () => import("../auto-reply/reply/provider-dispatcher.runtime.js"),
  { cacheRejections: true },
);

const bindProviderDispatcher = createLazyRuntimeMethodBinder(loadProviderDispatcherRuntimeModule);

const dispatchBuffered = bindProviderDispatcher(
  (runtime) => runtime.dispatchReplyWithBufferedBlockDispatcherCore,
);
const dispatch = bindProviderDispatcher((runtime) => runtime.dispatchReplyWithDispatcherCore);

/** Dispatches a reply with buffered block support after lazy-loading the runtime dispatcher. */
export const dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher = (
  params,
) => dispatchBuffered({ ...params, replyOptions: publicReplyOptions(params.replyOptions) });

/** Dispatches a reply through the provider dispatcher after lazy-loading runtime code. */
export const dispatchReplyWithDispatcher: DispatchReplyWithDispatcher = (params) =>
  dispatch({ ...params, replyOptions: publicReplyOptions(params.replyOptions) });
