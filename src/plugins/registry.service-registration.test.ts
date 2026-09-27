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
  advertisements = 0;

  constructor(readonly id: string) {}

  start() {
    this.starts += 1;
  }

  advertise() {
    this.advertisements += 1;
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
  it.each(["canonical", "frozen", "getter"])(
    "preserves %s service descriptors through canonical reload and cleanup",
    async (descriptor) => {
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
      if (descriptor === "frozen") {
        Object.defineProperty(service, "id", { value: " native-service " });
        Object.freeze(service);
      } else if (descriptor === "getter") {
        let reads = 0;
        Object.defineProperty(service, "id", {
          get() {
            if (reads++ > 0) {
              throw new Error("service id must only be read at admission");
            }
            return " native-service ";
          },
        });
      }
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
    },
  );

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

  it.each([
    { surface: "service", id: "\t\n" },
    { surface: "discovery", id: "\t\n" },
  ] as const)("reports a blank $surface service id ($id)", async ({ surface, id }) => {
    const { builder, createRecord } = createRegistrationFixture();
    const record = createRecord("invalid-service-owner");
    const api = builder.createApi(record, { config: {} });
    const service = new ClassBackedLifecycleService(id);

    if (surface === "service") {
      api.registerService(service);
    } else {
      api.registerGatewayDiscoveryService(service);
    }

    const registrations =
      surface === "service" ? builder.registry.services : builder.registry.gatewayDiscoveryServices;
    const recordIds = surface === "service" ? record.services : record.gatewayDiscoveryServiceIds;
    expect(registrations).toEqual([]);
    expect(recordIds).toEqual([]);
    expect(builder.registry.diagnostics).toEqual([
      {
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          surface === "service"
            ? "service registration missing id"
            : "gateway discovery service registration missing id",
      },
    ]);

    if (surface === "service") {
      const handle = await startPluginServices({ registry: builder.registry, config: {} });
      expect(service.starts).toBe(0);
      await handle.stop();
    } else {
      expect(service.advertisements).toBe(0);
    }
  });

  it.each([
    { surface: "service", sameOwner: false, paddedFirst: true },
    { surface: "service", sameOwner: true, paddedFirst: false },
    { surface: "discovery", sameOwner: false, paddedFirst: true },
    { surface: "discovery", sameOwner: true, paddedFirst: false },
  ] as const)(
    "deduplicates $surface registrations (same owner: $sameOwner, padded first: $paddedFirst)",
    async ({ surface, sameOwner, paddedFirst }) => {
      const { builder, createRecord } = createRegistrationFixture();
      const firstRecord = createRecord("first-owner");
      const secondRecord = sameOwner ? firstRecord : createRecord("second-owner");
      const firstApi = builder.createApi(firstRecord, { config: {} });
      const secondApi = builder.createApi(secondRecord, { config: {} });
      const firstService = new ClassBackedLifecycleService(
        paddedFirst ? " shared-service " : "shared-service",
      );
      const secondService = new ClassBackedLifecycleService(
        paddedFirst ? "shared-service" : " shared-service ",
      );

      if (surface === "service") {
        firstApi.registerService(firstService);
        secondApi.registerService(secondService);
      } else {
        firstApi.registerGatewayDiscoveryService(firstService);
        secondApi.registerGatewayDiscoveryService(secondService);
      }

      const registrations =
        surface === "service"
          ? builder.registry.services
          : builder.registry.gatewayDiscoveryServices;
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({
        pluginId: firstRecord.id,
        source: firstRecord.source,
        id: firstService.id.trim(),
        service: { id: firstService.id },
      });
      expect(registrations[0]?.service).toBeInstanceOf(ClassBackedLifecycleService);

      const recordIds =
        surface === "service" ? firstRecord.services : firstRecord.gatewayDiscoveryServiceIds;
      expect(recordIds).toEqual(["shared-service"]);

      if (sameOwner) {
        expect(builder.registry.diagnostics).toEqual([]);
      } else {
        expect(builder.registry.diagnostics).toEqual([
          expect.objectContaining({
            pluginId: "second-owner",
            message:
              surface === "service"
                ? "service already registered: shared-service (first-owner)"
                : "gateway discovery service already registered: shared-service (first-owner)",
          }),
        ]);
        expect(
          surface === "service" ? secondRecord.services : secondRecord.gatewayDiscoveryServiceIds,
        ).toEqual([]);
      }

      setActivePluginRegistry(builder.registry);
      if (surface === "service") {
        const handle = await startPluginServices({ registry: builder.registry, config: {} });
        try {
          expect(firstService.starts).toBe(1);
          expect(secondService.starts).toBe(0);
        } finally {
          await handle.stop();
        }
      } else {
        await builder.registry.gatewayDiscoveryServices[0]!.service.advertise({
          machineDisplayName: "fixture",
          gatewayPort: 18789,
          gatewayTlsEnabled: false,
          gatewayDirectReachable: true,
          minimal: true,
        });
        expect(firstService.advertisements).toBe(1);
        expect(secondService.advertisements).toBe(0);
      }
    },
  );
});
