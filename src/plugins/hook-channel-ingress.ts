import { cloneHookIsolationValue } from "./hook-isolation.js";
import type {
  HookContext,
  HookEvent,
  HookResult,
  ModifyingHookPolicy,
} from "./hook-runner-types.js";
import type { PluginHookRegistration } from "./hook-types.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";

/** Pre-storage policy uses the shared hook executor and retains its exact participant authority. */
export function createChannelIngressHookRunner(options: {
  getHooks: () => PluginHookRegistration<"before_channel_ingress">[];
  run: (
    event: HookEvent<"before_channel_ingress">,
    context: HookContext<"before_channel_ingress">,
    policy: ModifyingHookPolicy<"before_channel_ingress">,
  ) => Promise<HookResult<"before_channel_ingress"> | undefined>;
}) {
  return async (
    event: HookEvent<"before_channel_ingress">,
    ctx: HookContext<"before_channel_ingress">,
  ) => {
    const hooks = options.getHooks();
    if (hooks.length === 0) {
      return undefined;
    }
    const instances = hooks
      .map((hook) => getPluginValueInstance(hook.handler))
      .filter((instance) => instance !== undefined);
    const signal = AbortSignal.any([
      ctx.signal,
      ...instances.map((instance) => instance.lifecycle.signal),
    ]);
    const assertCurrent = () => {
      if (
        signal.aborted ||
        instances.some((instance) => !instance.acceptingCalls || instance.owner?.revoked)
      ) {
        throw new Error("Channel ingress transform is no longer current");
      }
    };
    assertCurrent();
    const result = await options.run(
      event,
      { ...ctx, signal },
      {
        eventForHandler: (original, accumulated) => ({
          event: cloneHookIsolationValue(
            "before_channel_ingress",
            accumulated?.event === undefined ? original.event : accumulated.event,
          ),
        }),
        mergeResults: (accumulated, next) =>
          next.event === undefined ? (accumulated ?? {}) : { event: next.event },
        assertHandlerBoundaryActive: assertCurrent,
        onHandlerError: () => {
          // Policy exceptions can contain the unsanitized event. Never format or log them.
          throw new Error("Channel ingress transform failed");
        },
      },
    );
    assertCurrent();
    return {
      event: result?.event === undefined ? event.event : result.event,
      // The queue retains this host assertion through its actual transaction and commit.
      assertCurrent,
    };
  };
}
