import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  getPluginRegistryGatewayChannelRegistration,
  getPluginRegistryGatewayOwner,
  isPluginRegistryGatewayViewOf,
} from "../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { getPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";

type AdmittingGatewayDeliveryInput = {
  /** Registry the producing turn ran in; its Gateway owner admitted the turn. */
  registry: PluginRegistry;
  cfg: OpenClawConfig;
  channel: string;
  /** Validate the admitted sender or restore its account view from current Gateway config. */
  prepareRuntimeHandoff?: (cfg: OpenClawConfig) => OpenClawConfig;
};

/**
 * Final delivery is a new operation of the admitting Gateway, not of the completed model turn.
 * Runs `deliver` in the Gateway's current registry, or rejects before any send when the
 * admitted channel changed. Registries without a Gateway owner deliver unchanged.
 */
export async function runAdmittingGatewayDelivery<T>(
  input: AdmittingGatewayDeliveryInput,
  deliver: (cfg: OpenClawConfig, assertCurrent?: () => void) => Promise<T>,
): Promise<T> {
  const { registry } = input;
  const owner = getPluginRegistryGatewayOwner(registry);
  if (!owner) {
    return await deliver(input.cfg);
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
    return await runOutsidePluginRuntimeGenerationScope(() =>
      withPluginRuntimeRegistryScope(current, () => deliver(input.cfg, assertCurrent)),
    );
  }
  const cfg = getPluginRuntimeLoadContext(current)?.rawConfig;
  const channel = current.channels.find((entry) => entry.plugin.id === input.channel);
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
  const prepareRuntimeHandoff = input.prepareRuntimeHandoff;
  return await runOutsidePluginRuntimeGenerationScope(() =>
    withPluginRuntimeRegistryScope(current, () => {
      const preparedCfg = prepareRuntimeHandoff ? prepareRuntimeHandoff(cfg) : cfg;
      assertCurrent();
      return deliver(preparedCfg, assertCurrent);
    }),
  );
}
