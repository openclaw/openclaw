import { expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createDeviceWorkerRuntime } from "../worker-environments/device-provider.js";
import { createWorkerEnvironmentService } from "../worker-environments/service.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import { environmentsHandlers } from "./environments.js";
import { mockContext, workerService } from "./environments.test-support.js";
export function registerWorkerInferenceEnvironmentTests(
  makeTempDir: (prefix: string) => string,
): void {
  it("projects only validated device inference without leaking settings or hiding other profiles", async () => {
    const profiles = {
      canonical: { provider: "device", settings: { device: "paired-node", inference: "worker" } },
      legacy: {
        provider: "device",
        settings: { device: "paired-node", inference: "runtime-local" },
      },
      default: { provider: "device", settings: { device: "paired-node" } },
      gateway: { provider: "device", settings: { device: "paired-node", inference: "gateway" } },
      invalid: { provider: "device", settings: { device: "paired-node", inference: "unknown" } },
      "missing-device": { provider: "device", settings: { inference: "worker" } },
      foreign: { provider: "static-ssh", settings: { inference: "worker" } },
    };
    const respond = vi.fn();
    await environmentsHandlers["environments.list"]?.({
      params: { projection: "profiles" },
      respond,
      context: {
        ...mockContext(workerService()),
        getRuntimeConfig: () => ({ cloudWorkers: { profiles } }),
      },
    } as never);
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toEqual({
      environments: [],
      profiles: [
        { id: "canonical", providerId: "device", inference: "worker" },
        { id: "default", providerId: "device" },
        { id: "foreign", providerId: "static-ssh" },
        { id: "gateway", providerId: "device" },
        { id: "invalid", providerId: "device" },
        { id: "legacy", providerId: "device", inference: "worker" },
        { id: "missing-device", providerId: "device" },
      ],
    });
  });

  it("advertises a named worker-inference device profile using the core provider without allocating", async () => {
    const root = makeTempDir("openclaw-environments-named-device-");
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const store = await createWorkerEnvironmentStore({ database });
    const config = {
      cloudWorkers: {
        profiles: {
          "dedicated-native": {
            provider: "device",
            settings: { device: "paired-node", inference: "worker" },
          },
        },
      },
    };
    const runtime = createDeviceWorkerRuntime({ getPairedDevice: async () => null });
    const provision = vi.spyOn(runtime.provider, "provision");
    const prepareInstallation = vi.fn();
    const bootstrapWorker = vi.fn();
    const service = createWorkerEnvironmentService({
      store,
      scheduler: createTestGatewayScheduler(),
      getConfig: () => config,
      resolveProvider: (id) => (id === "device" ? runtime.provider : undefined),
      prepareInstallation,
      bootstrapWorker,
      executeInference: vi.fn(),
    });
    try {
      const context = { ...mockContext(service), getRuntimeConfig: () => config };
      const respond = vi.fn();
      await environmentsHandlers["environments.list"]?.({
        params: { projection: "profiles" },
        respond,
        context,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          environments: [],
          profiles: [
            {
              id: "dedicated-native",
              providerId: "device",
              inference: "worker",
              executionMode: "worker-turn",
              executionModes: ["worker-turn", "remote-exec"],
            },
          ],
        },
        undefined,
      );
      expect(provision).not.toHaveBeenCalled();
      expect(prepareInstallation).not.toHaveBeenCalled();
      expect(bootstrapWorker).not.toHaveBeenCalled();
      expect(store.list()).toEqual([]);
    } finally {
      await service.stop();
      closeOpenClawStateDatabaseForTest();
    }
  });
}
