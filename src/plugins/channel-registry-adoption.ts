import { isDeepStrictEqual } from "node:util";
import { createRuntimePluginManifestLookup } from "./active-runtime-registry.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import {
  capturePluginLifecycleAuthority,
  getPluginRegistryResourceOwner,
  isPluginRecordActive,
  isPluginRegistryRetired,
} from "./registry-lifecycle.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

type RuntimeChannelSource = {
  registry: PluginRegistry;
  isCurrent: () => boolean;
};

/** Capture before preparation awaits; a successor cannot become this request's donor. */
export function captureRuntimeChannelSource(
  registry: PluginRegistry | null,
): RuntimeChannelSource | undefined {
  const isCurrent = registry && capturePluginLifecycleAuthority(registry);
  return registry && isCurrent
    ? { registry, isCurrent: () => getActivePluginRegistry() === registry && isCurrent() }
    : undefined;
}

function gatewayOwner(registry: PluginRegistry) {
  const runtime = getPluginRegistryRuntime(getPluginRegistryResourceOwner(registry));
  const resolver = runtime && getGatewayContextResolver(runtime);
  return resolver && getCanonicalGatewayContextResolver(resolver);
}

/** A prepared view selects channels; the matching live instance owns their transport state. */
export function adoptRuntimeChannelRegistrations(
  target: PluginRegistry,
  source: RuntimeChannelSource | undefined,
): PluginRegistry {
  if (!source || target === source.registry || target.channels.length === 0) {
    return target;
  }
  if (!source.isCurrent()) {
    throw new Error("Channel runtime owner changed during prepared registry admission");
  }
  const donor = source.registry;
  const targetContext = getPluginRuntimeLoadContext(target);
  const donorContext = getPluginRuntimeLoadContext(donor);
  const donorGateway = gatewayOwner(donor);
  const caller = getPluginRuntimeGatewayRequestScope();
  const callerGateway = caller?.resolveGatewayContext
    ? getCanonicalGatewayContextResolver(caller.resolveGatewayContext)
    : caller?.pluginRegistry
      ? gatewayOwner(caller.pluginRegistry)
      : undefined;
  if (
    !targetContext ||
    !donorContext ||
    targetContext.env !== process.env ||
    !isDeepStrictEqual({ ...targetContext.env }, { ...donorContext.env }) ||
    !donorGateway ||
    gatewayOwner(target) !== donorGateway ||
    (caller && callerGateway !== donorGateway) ||
    (caller?.context && donorGateway() !== caller.context) ||
    targetContext.registrationConfigKey !== donorContext.registrationConfigKey ||
    isPluginRegistryRetired(target)
  ) {
    return target;
  }
  const manifests = targetContext.manifestRegistry?.plugins;
  const donorManifests = donorContext.manifestRegistry?.plugins;
  if (!manifests || !donorManifests) {
    return target;
  }
  const selectedTarget = createRuntimePluginManifestLookup(
    target,
    manifests,
    targetContext.preferBuiltPluginArtifacts,
  );
  const selectedDonor = createRuntimePluginManifestLookup(
    donor,
    manifests,
    targetContext.preferBuiltPluginArtifacts,
  );
  let changed = false;
  const channels = target.channels.map((entry) => {
    const record = selectedTarget(entry.pluginId);
    const donorRecord = selectedDonor(entry.pluginId);
    const local = record && getPluginInstance(record);
    const runtime = donorRecord && getPluginInstance(donorRecord);
    const registration = donor.channels.find(
      (candidate) =>
        candidate.pluginId === entry.pluginId && candidate.plugin.id === entry.plugin.id,
    );
    if (
      !record?.enabled ||
      !donorRecord ||
      !local?.acceptingCalls ||
      !runtime?.acceptingCalls ||
      !registration ||
      !isPluginRecordActive(donor, donorRecord) ||
      local.sourceDigest !== runtime.sourceDigest ||
      !isDeepStrictEqual(
        manifests.find((manifest) => manifest.id === entry.pluginId),
        donorManifests.find((manifest) => manifest.id === entry.pluginId),
      )
    ) {
      return entry;
    }
    // Both value views are existing admission owners. Captured methods and returned
    // read grants must close with the scoped consumer even while the donor stays live.
    const scoped = local.wrap(runtime.wrap(registration));
    changed = true;
    return { ...scoped, borrowedRuntimeRecord: donorRecord };
  });
  if (!source.isCurrent()) {
    throw new Error("Channel runtime owner changed during prepared registry admission");
  }
  return changed ? { ...target, channels } : target;
}
