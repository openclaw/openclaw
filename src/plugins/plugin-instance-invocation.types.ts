import type { AgentInputRecoveryContext } from "../state/agent-input-recovery.types.js";
import type { ScopedPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.types.js";
import type { PluginCacheScope } from "./plugin-cache.types.js";
import type { PluginInvocationInstance, PluginRetentionOwner } from "./plugin-instance.types.js";

export type PluginInstanceInvocation = {
  instance: PluginInvocationInstance;
  token: object;
  readonly parent?: PluginInstanceInvocation;
};

export type PluginSourceCaptureStorage = Readonly<{
  stateDir: string;
  placement: "state" | "temporary";
}>;

export type PluginExecutionScopes = {
  readonly retentionOwner?: PluginRetentionOwner;
  readonly invocation?: PluginInstanceInvocation;
  readonly metadataScope?: ScopedPluginMetadataSnapshot;
  readonly cacheScope?: PluginCacheScope;
  readonly sourceCaptureStorage?: PluginSourceCaptureStorage;
  /** Generation-only scopes preserve this source even when copying the Gateway view. */
  readonly inputRecoveryContext?: AgentInputRecoveryContext;
};

/** Runtime owners preserve their context when these independent scopes change. */
export interface PluginExecutionFrame extends PluginExecutionScopes {
  /** Runtime provenance for diagnostics, never authorization. */
  readonly runtimePluginId?: string | undefined;
  withScopes(scopes: PluginExecutionScopes): PluginExecutionFrame;
}
