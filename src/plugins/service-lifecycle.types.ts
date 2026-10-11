import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginInstanceConsumer } from "./plugin-instance.types.js";
import type { OpenClawPluginServiceContext } from "./plugin-registration.types.js";
import type { PluginRegistry, PluginServiceRegistration } from "./registry-types.js";
import type { PluginServiceSchedulerOwner } from "./service-scheduler.js";

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
};
