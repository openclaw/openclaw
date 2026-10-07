import type {
  PluginChannelTokensRevokedDispatchOptions,
  PluginHookChannelTokensRevokedContext,
  PluginHookChannelTokensRevokedEvent,
  PluginHookHandlerMap,
} from "../plugins/hook-types.js";
import type { OpenClawPluginApi } from "../plugins/types.js";

export type {
  PluginChannelTokensRevokedDispatchOptions,
  PluginHookChannelTokensRevokedContext,
  PluginHookChannelTokensRevokedEvent,
};

/** Register through the caller's lifecycle-bound API; never register globally. */
export function registerChannelTokensRevokedConsumer(
  api: Pick<OpenClawPluginApi, "on">,
  handler: PluginHookHandlerMap["channel_tokens_revoked"],
): void {
  api.on("channel_tokens_revoked", handler);
}

async function resolveRevocationHookRunner(policy: PluginChannelTokensRevokedDispatchOptions) {
  const ids = policy.requiredConsumerPluginIds;
  let assertSourceRegistryCurrent = () => {};
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 0)) {
    const [lifecycle, generation, request] = await Promise.all([
      import("../plugins/registry-lifecycle.js"),
      import("../plugins/runtime/generation-state.js"),
      import("../plugins/runtime/gateway-request-scope.js"),
    ]);
    const scopedRegistry =
      generation.getPluginRuntimeGenerationRegistry() ??
      request.getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
    // The general hook facade can fall back from a retired scope to the root.
    // Required revocation delivery retains its source's exact admission instead.
    assertSourceRegistryCurrent = () => {
      if (scopedRegistry && lifecycle.isPluginRegistryRetired(scopedRegistry)) {
        throw new Error("channel_tokens_revoked required consumer is unavailable");
      }
    };
    assertSourceRegistryCurrent();
  }
  const { getGlobalHookRunner } = await import("../plugins/hook-runner-global.js");
  const runner = getGlobalHookRunner();
  if (!runner && ids !== undefined && (!Array.isArray(ids) || ids.length > 0)) {
    throw new Error("channel_tokens_revoked required consumer is unavailable");
  }
  return { runner, assertSourceRegistryCurrent };
}

/** Check current consumer readiness without invoking handlers or retaining a registry snapshot. */
export async function assertChannelTokensRevokedConsumersReady(
  policy: PluginChannelTokensRevokedDispatchOptions = {},
): Promise<void> {
  const ids = policy.requiredConsumerPluginIds;
  if (ids === undefined || (Array.isArray(ids) && ids.length === 0)) {
    return;
  }
  const selected = await resolveRevocationHookRunner(policy);
  selected.assertSourceRegistryCurrent();
  selected.runner?.assertChannelTokensRevokedConsumersReady(policy);
}

/** Await registered consumers. This trusted-plugin API is not source authentication. */
export async function dispatchChannelTokensRevoked(
  event: PluginHookChannelTokensRevokedEvent,
  context: PluginHookChannelTokensRevokedContext,
  policy: PluginChannelTokensRevokedDispatchOptions = {},
): Promise<void> {
  const selected = await resolveRevocationHookRunner(policy);
  selected.assertSourceRegistryCurrent();
  await selected.runner?.runChannelTokensRevoked(event, context, policy);
}
