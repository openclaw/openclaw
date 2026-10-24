import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  getPluginRegistryGatewayChannelRegistration,
  getPluginRegistryGatewayOwner,
  isPluginRegistryGatewayViewOf,
} from "../../plugins/registry-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { getPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";

/** Final delivery is a new operation of the admitting Gateway, not of the completed model turn. */
export function withDurableDeliveryRuntime<T>(
  input: {
    cfg: OpenClawConfig;
    channel: string;
    prepareRuntimeHandoff?: (cfg: OpenClawConfig) => OpenClawConfig;
  },
  deliver: (cfg: OpenClawConfig, assertCurrent?: () => void) => T,
): T {
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const owner = registry && getPluginRegistryGatewayOwner(registry);
  if (!registry || !owner) {
    return deliver(input.cfg);
  }
  const current = owner.current();
  const reject = (message: string): never => {
    throw new PlatformMessageNotDispatchedError(message, {
      cause: new Error(message),
      retryable: false,
    });
  };
  if (!current) {
    return reject("The Gateway that admitted this reply is closing.");
  }
  const assertCurrent = () => {
    if (owner.current() !== current) {
      reject("The reply delivery runtime changed before sending.");
    }
  };
  if (current === registry || isPluginRegistryGatewayViewOf(registry, current)) {
    // A filtered agent registry is still this publication, not a reload handoff.
    // The completed model turn must not select or own the final transport.
    return runOutsidePluginRuntimeGenerationScope(() =>
      withPluginRuntimeRegistryScope(current, () => deliver(input.cfg, assertCurrent)),
    );
  }
  const cfg = getPluginRuntimeLoadContext(current)?.rawConfig;
  const channel = current.channels.find((entry) => entry.plugin.id === input.channel);
  const prepareRuntimeHandoff = input.prepareRuntimeHandoff;
  const admittedChannel = getPluginRegistryGatewayChannelRegistration(registry, input.channel);
  const admittedConfig = admittedChannel?.config;
  const retainedChannel =
    channel &&
    admittedChannel?.pluginId === channel.pluginId &&
    admittedChannel.plugin === channel.plugin;
  if (
    !cfg ||
    !admittedConfig ||
    !isDeepStrictEqual(cfg.channels?.[input.channel], admittedConfig.channels?.[input.channel]) ||
    !isDeepStrictEqual(cfg.channels?.defaults, admittedConfig.channels?.defaults) ||
    !channel ||
    !retainedChannel ||
    !isDeepStrictEqual(
      cfg.plugins?.entries?.[channel.pluginId],
      admittedConfig.plugins?.entries?.[channel.pluginId],
    )
  ) {
    return reject("The reply channel changed; delivery was not started.");
  }
  // Drop both inherited generation selectors, but retain the exact authenticated caller.
  // The retained registration and unchanged settings keep the admitted sender. Channels whose
  // credential can change outside config (env, files, SecretRefs) pin it through the callback.
  return runOutsidePluginRuntimeGenerationScope(() =>
    withPluginRuntimeRegistryScope(current, () => {
      const preparedCfg = prepareRuntimeHandoff ? prepareRuntimeHandoff(cfg) : cfg;
      assertCurrent();
      return deliver(preparedCfg, assertCurrent);
    }),
  );
}
