import { afterEach, describe, expect, it } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createPluginRecord } from "./loader-records.js";
import { PluginInstance } from "./plugin-instance.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";
import { startPluginServices } from "./services.js";

const registries: ReturnType<typeof createTestPluginRegistry>["registry"][] = [];

afterEach(async () => {
  await clearActivePluginRegistry();
  for (const registry of registries.splice(0)) {
    await disposePluginRegistryInstances(registry);
  }
});

class ClassBackedLifecycleService {
  starts = 0;

  constructor(readonly id: string) {}

  start() {
    this.starts += 1;
  }
}

function createRegistrationFixture() {
  const builder = createTestPluginRegistry();
  registries.push(builder.registry);
  const createRecord = (id: string) => {
    const record = createPluginRecord({
      id,
      source: `/plugins/${id}/index.ts`,
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    builder.registry.plugins.push(record);
    return record;
  };
  return { builder, createRecord };
}

describe("plugin service registration identity", () => {
  it("preserves native service descriptors through canonical reload and cleanup", async () => {
    const { builder, createRecord } = createRegistrationFixture();
    const record = createRecord("native-service-owner");
    const instance = new PluginInstance(record.id, { record, registry: builder.registry });
    const store = createPluginRuntimeStore<object>("native service runtime missing");
    const runtime = {};
    const calls: Array<{ phase: string; value: number; runtime: object | null }> = [];
    class NativeService extends Date {
      readonly id = "native-service";
      start() {
        calls.push({ phase: "start", value: this.getTime(), runtime: store.tryGetRuntime() });
      }
      stop() {
        calls.push({ phase: "stop", value: this.getTime(), runtime: store.tryGetRuntime() });
      }
    }
    const service = new NativeService(37);
    let reads = 0;
    Object.defineProperty(service, "id", {
      get() {
        if (reads++ > 0) {
          throw new Error("service id must only be read at admission");
        }
        return " native-service ";
      },
    });
    instance.run(() => {
      store.setRuntime(runtime);
      builder.createApi(record, { config: {} }).registerService(service);
    });
    expect(builder.registry.services).toHaveLength(1);
    expect(builder.registry.services[0]?.service).toBe(service);
    expect(record.services).toEqual(["native-service"]);
    const services = await startPluginServices({ registry: builder.registry, config: {} });
    try {
      await services.reload({}, new Set(["native-service"]));
      await services.stop();
      expect(calls).toEqual([
        { phase: "start", value: 37, runtime },
        { phase: "stop", value: 37, runtime },
        { phase: "start", value: 37, runtime },
        { phase: "stop", value: 37, runtime },
      ]);
      expect(calls.every((call) => call.runtime === runtime)).toBe(true);
    } finally {
      await services.stop();
    }
  });

  it("contains unreadable IDs without leaking accessor errors", () => {
    const { builder, createRecord } = createRegistrationFixture();
    const record = createRecord("unreadable-owner");
    const api = builder.createApi(record, { config: {} });
    const service = {
      get id(): string {
        throw new Error("private accessor failure");
      },
      start() {},
      advertise() {},
    };
    expect(() => api.registerService(service)).not.toThrow();
    expect(() => api.registerGatewayDiscoveryService(service)).not.toThrow();
    expect(builder.registry.services).toEqual([]);
    expect(builder.registry.gatewayDiscoveryServices).toEqual([]);
    expect(builder.registry.diagnostics.map(({ message }) => message)).toEqual([
      "service registration id cannot be normalized",
      "gateway discovery service registration id cannot be normalized",
    ]);
  });

  it("snapshots each namespace independently without writing plugin accessors", () => {
    const { builder, createRecord } = createRegistrationFixture();
    const record = createRecord("shared-owner");
    const api = builder.createApi(record, { config: {} });
    let rawId = " shared-service ";
    class Service extends Date {
      get id() {
        return rawId;
      }
      set id(_value: string) {
        throw new Error("must not write plugin-owned IDs");
      }
      start() {}
      advertise() {}
    }
    const service = new Service();
    api.registerService(service);
    api.registerGatewayDiscoveryService(service);
    rawId = "changed-after-registration";
    api.registerService({ id: "shared-service", start() {} });
    api.registerGatewayDiscoveryService({ id: "shared-service", advertise() {} });
    expect(builder.registry.services).toHaveLength(1);
    expect(builder.registry.gatewayDiscoveryServices).toHaveLength(1);
    for (const entry of [
      ...builder.registry.services,
      ...builder.registry.gatewayDiscoveryServices,
    ]) {
      expect(entry.id).toBe("shared-service");
      expect(entry.service).toBe(service);
    }
    expect(record.services).toEqual(["shared-service"]);
    expect(record.gatewayDiscoveryServiceIds).toEqual(["shared-service"]);
    expect(builder.registry.diagnostics).toEqual([]);
  });

  it("retains the first service when a different owner claims its normalized ID", async () => {
    const { builder, createRecord } = createRegistrationFixture();
    const first = createRecord("first-owner");
    const second = createRecord("second-owner");
    const firstService = new ClassBackedLifecycleService(" shared-service ");
    const secondService = new ClassBackedLifecycleService("shared-service");
    builder.createApi(first, { config: {} }).registerService(firstService);
    builder.createApi(second, { config: {} }).registerService(secondService);
    expect(builder.registry.services).toEqual([
      expect.objectContaining({
        pluginId: first.id,
        source: first.source,
        id: "shared-service",
        service: firstService,
      }),
    ]);
    expect(first.services).toEqual(["shared-service"]);
    expect(second.services).toEqual([]);
    expect(builder.registry.diagnostics).toEqual([
      expect.objectContaining({
        pluginId: second.id,
        message: "service already registered: shared-service (first-owner)",
      }),
    ]);
    setActivePluginRegistry(builder.registry);
    const handle = await startPluginServices({ registry: builder.registry, config: {} });
    try {
      expect(firstService.starts).toBe(1);
      expect(secondService.starts).toBe(0);
    } finally {
      await handle.stop();
    }
  });
});
