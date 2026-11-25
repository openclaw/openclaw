import { publicChannelTurn, type PublicReplyParams } from "../auto-reply/public-reply-options.js";
import type {
  DispatchReplyWithBufferedBlockDispatcher as CoreBufferedDispatcher,
  DispatchReplyWithDispatcher as CoreDispatcher,
} from "../auto-reply/reply/provider-dispatcher.types.js";
import {
  createLazyPromise,
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "../shared/lazy-runtime.js";
import {
  getBoundLegacyPluginSdkResourceHost,
  type LegacyPluginSdkReplyDispatch,
} from "./legacy-sdk-resource-host.js";

/** Capture the creating host's module graph; native SDK caches must not choose state owners. */
export function createLegacyPluginSdkReplyDispatch(): LegacyPluginSdkReplyDispatch {
  const bindProvider = createLazyRuntimeMethodBinder(
    createLazyPromise(() => import("../auto-reply/reply/provider-dispatcher.runtime.js"), {
      cacheRejections: true,
    }),
  );
  return Object.freeze({
    tryDispatchAcpReplyHook: createLazyRuntimeMethod(
      createLazyRuntimeModule(() => import("../auto-reply/reply/dispatch-acp-sdk.js")),
      (runtime) => runtime.tryDispatchAcpReplyHookCore,
    ),
    dispatchReplyWithBufferedBlockDispatcher: bindProvider(
      (runtime) => runtime.dispatchReplyWithBufferedBlockDispatcherCore,
    ),
    dispatchReplyWithDispatcher: bindProvider((runtime) => runtime.dispatchReplyWithDispatcherCore),
  });
}

// Only genuinely unbound, shipped standalone calls use the process-native runtime.
const bindStandaloneProvider = createLazyRuntimeMethodBinder(
  createLazyPromise(() => import("../auto-reply/reply/provider-dispatcher.runtime.js"), {
    cacheRejections: true,
  }),
);
const dispatchBuffered = bindStandaloneProvider(
  (runtime) => runtime.dispatchReplyWithBufferedBlockDispatcherCore,
);
const dispatch = bindStandaloneProvider((runtime) => runtime.dispatchReplyWithDispatcherCore);

/** Select and admit the exact host before processing public options or loading stateful code. */
export async function dispatchReplyWithBufferedBlockDispatcher(
  params: PublicReplyParams<Parameters<CoreBufferedDispatcher>[0]>,
): ReturnType<CoreBufferedDispatcher> {
  const host = getBoundLegacyPluginSdkResourceHost();
  return host
    ? host.invokeReplyDispatch((reply) =>
        reply.dispatchReplyWithBufferedBlockDispatcher(publicChannelTurn(params)),
      )
    : dispatchBuffered(publicChannelTurn(params));
}

export async function dispatchReplyWithDispatcher(
  params: PublicReplyParams<Parameters<CoreDispatcher>[0]>,
): ReturnType<CoreDispatcher> {
  const host = getBoundLegacyPluginSdkResourceHost();
  return host
    ? host.invokeReplyDispatch((reply) =>
        reply.dispatchReplyWithDispatcher(publicChannelTurn(params)),
      )
    : dispatch(publicChannelTurn(params));
}
