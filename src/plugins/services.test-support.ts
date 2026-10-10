import { onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { createPluginServiceGatewayEvents } from "./gateway-events.js";
import type { OpenClawPluginSessionsChangedEvent } from "./gateway-events.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { startPluginServices as start } from "./services.js";

export type { PluginServicesHandle } from "./services.js";

type WithTestScheduler<T> = T extends { scheduler: GatewayScheduler }
  ? Omit<T, "scheduler"> & { scheduler?: GatewayScheduler }
  : never;

export function startPluginServices(
  params: WithTestScheduler<Parameters<typeof start>[0]>,
): ReturnType<typeof start> {
  const scheduler = params.scheduler ?? createTestGatewayScheduler("fake-timers");
  if (!params.scheduler) {
    onTestFinished(() => scheduler.stop());
  }
  return start({ ...params, scheduler });
}

export function createServiceRegistration(
  service: PluginServiceRegistration["service"],
  owner: Partial<Omit<PluginServiceRegistration, "id" | "service">> = {},
): PluginServiceRegistration {
  return {
    pluginId: "plugin:test",
    source: "test",
    origin: "workspace",
    ...owner,
    id: service.id.trim(),
    service,
  };
}

export function createRegistry(
  services: PluginServiceRegistration["service"][],
  pluginId = "plugin:test",
  origin: PluginOrigin = "workspace",
) {
  const registry = createEmptyPluginRegistry();
  registry.services = services.map((service) =>
    createServiceRegistration(service, {
      pluginId,
      origin,
      rootDir: "/plugins/test-plugin",
    }),
  );
  return registry;
}

export const createServiceConfig = (): OpenClawConfig => ({});

export function subscribePluginSessionsChanged(
  handler: (event: OpenClawPluginSessionsChangedEvent) => void,
): () => void {
  const events = createPluginServiceGatewayEvents({
    pluginId: "test",
    broadcast: () => undefined,
    lease: createPluginRuntimeCapabilityLease("test"),
  });
  if (!events) {
    throw new Error("Expected Gateway events with a broadcaster");
  }
  return events.onSessionsChanged(handler);
}
