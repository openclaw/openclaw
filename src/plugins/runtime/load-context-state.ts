import type { DeclaredProviderOwnerIndex } from "../provider-owner-index.js";

export type PluginRuntimeLoadContextState = {
  activationInputFingerprint: string;
  activationResultFingerprint: string;
  controlPlaneFingerprint: string;
  registrationConfigKey: string;
  loaderCacheIdentity?: Readonly<{ requestKey: string; resolvedKey: string }>;
  declaredProviderOwners: DeclaredProviderOwnerIndex;
  selectedContextEngine?: Readonly<{ engineId: string; owner: string | null }>;
};

// Keep private config/env out of diagnostic traversal while registry spreads
// preserve the exact owning context across source and built readers.
const pluginRuntimeLoadContext = Symbol.for("openclaw.pluginRuntimeLoadContext");
type ContextCarrier = { [pluginRuntimeLoadContext]?: () => PluginRuntimeLoadContextState };

export function bindPluginRuntimeLoadContextState(
  registry: object,
  context: PluginRuntimeLoadContextState,
): void {
  Object.defineProperty(registry, pluginRuntimeLoadContext, {
    value: () => context,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

export function getPluginRuntimeLoadContextState(
  registry: object | undefined,
): PluginRuntimeLoadContextState | undefined {
  // SAFETY: Only the owning setter writes this private registry slot.
  return (registry as ContextCarrier | undefined)?.[pluginRuntimeLoadContext]?.();
}

/** Reads the canonical owner captured before plugin registration, without rediscovery. */
export function getSelectedContextEngineOwner(
  registry: object,
  engineId: string,
): string | null | undefined {
  const selected = getPluginRuntimeLoadContextState(registry)?.selectedContextEngine;
  return selected?.engineId === engineId ? selected.owner : undefined;
}
