import type { ScopedPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.types.js";
import type { PluginCacheScope } from "./plugin-cache.types.js";
import type { PluginInvocationInstance } from "./plugin-instance.types.js";

export type PluginInstanceInvocation = {
  instance: PluginInvocationInstance;
  token: object;
  /** The invocation this one was entered from, so drain dependencies survive nested calls. */
  readonly parent?: PluginInstanceInvocation;
};

export type PluginSourceCaptureStorage = Readonly<{
  stateDir: string;
  placement: "state" | "temporary";
}>;

export type PluginExecutionScopes = {
  readonly invocation?: PluginInstanceInvocation;
  readonly metadataScope?: ScopedPluginMetadataSnapshot;
  readonly cacheScope?: PluginCacheScope;
  readonly sourceCaptureStorage?: PluginSourceCaptureStorage;
};

/** Runtime owners preserve their context when these independent scopes change. */
export interface PluginExecutionFrame extends PluginExecutionScopes {
  withScopes(scopes: PluginExecutionScopes): PluginExecutionFrame;
}
