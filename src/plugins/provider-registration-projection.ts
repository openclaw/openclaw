import type { ProviderPlugin } from "./types.js";

// Registered providers are host-owned copies behind plugin views. Copying one walks every
// member through the view's traps, so each registration's projection is built once and shared.
// One slot per provider: an object registered under two plugin ids just rebuilds when they alternate.
const projections = new WeakMap<ProviderPlugin, ProviderPlugin>();

/** Shared frozen `{ ...provider, pluginId }` for one registry entry; consumers must not mutate it. */
export function projectRegisteredProvider(
  provider: ProviderPlugin,
  pluginId: string,
): ProviderPlugin {
  let projected = projections.get(provider);
  if (projected?.pluginId !== pluginId) {
    projected = Object.freeze(Object.assign({}, provider, { pluginId }));
    projections.set(provider, projected);
  }
  return projected;
}
