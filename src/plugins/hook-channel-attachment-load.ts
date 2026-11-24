import { awaitHook } from "./hook-timeout.js";
import type {
  PluginHookBeforeChannelAttachmentLoadContext,
  PluginHookBeforeChannelAttachmentLoadEvent,
  PluginHookBeforeChannelAttachmentLoadResult,
  PluginHookRegistration,
} from "./hook-types.js";

export function createChannelAttachmentLoadHookRunner(
  getHooks: () => PluginHookRegistration<"before_channel_attachment_load">[],
  handleHookError: (params: {
    hookName: "before_channel_attachment_load";
    pluginId: string;
    error: unknown;
  }) => void,
) {
  return async function runBeforeChannelAttachmentLoad(
    event: PluginHookBeforeChannelAttachmentLoadEvent,
    ctx: PluginHookBeforeChannelAttachmentLoadContext,
  ): Promise<PluginHookBeforeChannelAttachmentLoadResult | undefined> {
    for (const hook of getHooks()) {
      ctx.abortSignal.throwIfAborted();
      let active = true;
      const scope = new AbortController();
      const handlerContext = {
        ...ctx,
        abortSignal: AbortSignal.any([ctx.abortSignal, scope.signal]),
        heartbeat: () => {
          if (!active) {
            throw new Error("channel ingress preparation handler is no longer active");
          }
          ctx.abortSignal.throwIfAborted();
          ctx.heartbeat();
        },
      };
      try {
        const result = await awaitHook(
          hook,
          Promise.resolve(hook.handler(event, handlerContext)),
          undefined,
          { signal: ctx.abortSignal },
        );
        ctx.abortSignal.throwIfAborted();
        if (result !== undefined) {
          return result;
        }
      } catch (error) {
        handleHookError({
          hookName: "before_channel_attachment_load",
          pluginId: hook.pluginId,
          error,
        });
      } finally {
        active = false;
        scope.abort(new Error("channel ingress preparation handler is no longer active"));
      }
    }
    return undefined;
  };
}
