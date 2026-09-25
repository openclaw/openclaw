import type { ScopedPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.types.js";
import type { PluginCacheScope } from "./plugin-cache.types.js";
import type { PluginInvocationInstance } from "./plugin-instance.types.js";

export type PluginInstanceInvocation = { instance: PluginInvocationInstance; token: object };

export type PluginExecutionScopes = {
  readonly invocation?: PluginInstanceInvocation;
  readonly metadataScope?: ScopedPluginMetadataSnapshot;
  readonly cacheScope?: PluginCacheScope;
};

/** Runtime owners preserve their context when these independent scopes change. */
export interface PluginExecutionFrame extends PluginExecutionScopes {
  withScopes(scopes: PluginExecutionScopes): PluginExecutionFrame;
}
