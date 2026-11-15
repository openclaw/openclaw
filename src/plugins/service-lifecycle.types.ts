import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayPluginEventBroadcastFn } from "../gateway/server-broadcast-types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginInstanceConsumer } from "./plugin-instance.types.js";
import type { OpenClawPluginServiceContext } from "./plugin-registration.types.js";
import type { PluginRegistry, PluginServiceRegistration } from "./registry-types.js";
import type { PluginServiceCronHost } from "./service-cron.js";
import type { PluginServiceSchedulerOwner } from "./service-scheduler.js";

export type PluginServicesHandle = {
  reload: (config: OpenClawConfig, serviceIds: ReadonlySet<string>) => Promise<void>;
  stop: (options?: {
    strict: true;
    /** Wall-clock epoch deadline, converted to elapsed time when stop starts. */
    deadlineAtMs?: number;
    pluginIds?: ReadonlySet<string>;
  }) => Promise<void | { errors: readonly unknown[] }>;
};

export type StartPluginServicesParams = {
  scheduler: GatewayScheduler;
  registry: PluginRegistry;
  config: OpenClawConfig;
  workspaceDir?: string;
  startupTrace?: NonNullable<OpenClawPluginServiceContext["startupTrace"]>;
  broadcastPluginEvent?: GatewayPluginEventBroadcastFn;
  getCronService?: () => PluginServiceCronHost | null | undefined;
  oneShotStopTimeouts?: { eventDrainMs: number; serviceStopMs: number };
  previous?: PluginServicesHandle | null;
  deferStartForPluginIds?: ReadonlySet<string>;
} & (
  | { throwOnStartError: true; onHandle: (handle: PluginServicesHandle) => void }
  | { throwOnStartError?: false; onHandle?: (handle: PluginServicesHandle) => void }
);

export type PreparedPluginServicesParams = Omit<
  StartPluginServicesParams,
  "previous" | "onHandle"
> & {
  owner: PluginServicesOwner;
  publication: { callback: ((handle: PluginServicesHandle) => void) | undefined };
};

/** An issued service attempt retains cleanup custody across registry handoffs. */
export type OwnedPluginService = {
  owner: PluginServicesOwner;
  id: string;
  pluginId: string;
  registration: PluginServiceRegistration;
  registry: PluginRegistry;
  diagnosticsExporter: boolean;
  stop?: () => unknown;
  startup?: Promise<void>;
  startupConsumer?: PluginInstanceConsumer;
  stopping?: Promise<unknown>;
  reloading?: Promise<void>;
  pendingReload?: OpenClawConfig;
  cleaned: boolean;
  cleanupErrors: unknown[];
  cleanupReporting?: Promise<unknown>;
  stopRequested: boolean;
  stopNodeInvocations?: () => void;
  stopControlUiIngress?: () => Promise<void>;
  health: NonNullable<OpenClawPluginServiceContext["serviceHealth"]>;
  lease: PluginRuntimeCapabilityLease;
  scheduling: PluginServiceSchedulerOwner;
};

export type PluginServicesOwner = {
  services: OwnedPluginService[];
  attempts: WeakMap<PluginServiceRegistration, OwnedPluginService>;
  registrations: Set<PluginServiceRegistration>;
  stopped: Set<PluginServiceRegistration>;
  closed: boolean;
  resumeReload?: (entry: OwnedPluginService) => void;
};
