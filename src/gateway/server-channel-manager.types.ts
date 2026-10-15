// Channel manager construction dependencies stay separate from read-only runtime snapshots.
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntimeChannel } from "../plugins/runtime/types-channel.js";
import type { RuntimeEnv } from "../runtime.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

export type ChannelManagerOptions = {
  scheduler: GatewayScheduler;
  getRuntimeConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
  resolveGatewayContext?: GatewayContextResolver;
  channelLogs: Partial<Record<ChannelId, SubsystemLogger>>;
  channelRuntimeEnvs: Partial<Record<ChannelId, RuntimeEnv>>;
  /** Supply the complete createPluginRuntime().channel surface; partial stubs are unsupported. */
  channelRuntime?: PluginRuntimeChannel;
  /** Resolve the same complete surface only when a channel account starts. */
  resolveChannelRuntime?: () => PluginRuntimeChannel | Promise<PluginRuntimeChannel>;
  startupTrace?: { measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T> };
  deferStartupAccountStartsUntil?: Promise<void>;
  getNativeApprovalRuntime?: () => GatewayNativeApprovalRuntime | undefined;
  ambientAutostartSuppressedChannelIds?: ReadonlySet<string>;
  tryRecoverAutostartSuppression?: () => boolean;
  isClosing?: () => boolean;
};
