import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { ScopedPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.types.js";
import type { PluginCacheScope } from "./plugin-cache.types.js";
import type { PluginInvocationInstance } from "./plugin-instance.types.js";

export type PluginInstanceInvocation = { instance: PluginInvocationInstance; token: object };

export type PluginSourceCaptureStorage = Readonly<{
  stateDir: string;
  placement: "state" | "temporary";
}>;

export type PluginSourceCaptureInstance = {
  isCurrent(): boolean;
  assertCurrent(): void;
  startMaintenance(scheduler: GatewayScheduler): Promise<void>;
  readonly managedRoot: string | undefined;
  createDirectory(prefix?: string): string;
  createNativeDirectory(): { directory: string; commit(): boolean };
  release(): void;
  releaseAsync(): Promise<void>;
};

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
