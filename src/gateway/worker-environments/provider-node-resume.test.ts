import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider } from "../../plugins/types.js";
import { createWorkerRuntimeRefreshWaiter } from "../server-worker-placement-runtime-refresh.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import { testState } from "./service.test-support.js";

describe("same enrolled node admission recovery", () => {
  support.setupWorkerEnvironmentServiceSuite();

  async function setup(
    options: { connected?: boolean; capable?: boolean; prepared?: boolean } = {},
  ) {
    const environmentId = "resume-worker";
    await testState.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "development",
      provisionOperationId: "resume-operation",
      profileSnapshot: {
        settings: { region: "test" },
        ...(options.prepared === false
          ? {}
          : {
              runtimePreparation: {
                source: "empty",
                key: "c".repeat(64),
                cacheKey: "d".repeat(64),
                contractVersion: 2,
                target: { machineClass: "test", platform: "linux" },
                artifacts: {
                  nodeBootstrapSha256: "b".repeat(64),
                  enabledPluginIds: [],
                  workerBundleHash: support.BUNDLE_HASH,
                  workerArchiveSha256: "e".repeat(64),
                  openclawVersion: "2026.7.2",
                  protocolFeatures: [],
                },
              },
            }),
      },
    });
    await testState.store.transition({ environmentId, from: "requested", to: "provisioning" });
    await testState.store.transition({
      environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        ...support.readyPatch(environmentId),
        leaseId: "lease-1",
        nodeDeviceId: "device-1",
        sharedHost: false,
      },
    });
    const environment = await testState.store.transition({
      environmentId,
      from: "ready",
      to: "attached",
      patch: support.attachedPatch(environmentId, REQUEST.sessionId),
    });
    const placements = createWorkerSessionPlacementStore({ database: testState.stateDb });
    const placement = await seedActivePlacement(placements, {
      environmentId,
      ownerEpoch: environment.ownerEpoch,
    });
    if (placement.state !== "active") {
      throw new Error("Expected an active fixture placement");
    }
    const admittedEnvironment = testState.store.get(environmentId);
    if (!admittedEnvironment) {
      throw new Error("Expected the fixture environment");
    }
    let running = options.connected === true;
    const resumeNode = vi.fn<NonNullable<WorkerProvider["resumeNode"]>>(async (request) => {
      request.assertCurrent();
      running = true;
    });
    const provision = vi.fn(support.createProvider().provision);
    const inspect = vi.fn<WorkerProvider["inspect"]>(async () => ({
      status: "active",
      sharedHost: false,
    }));
    const service = support.createService(
      support.createProvider({
        ...(options.capable === false ? {} : { resumeNode }),
        inspect,
        provision,
      }),
    );
    const waiter = createWorkerRuntimeRefreshWaiter({
      environments: service,
      isStopping: () => false,
      hasCurrentRunner: () => running,
    });
    waiter.bind(async () => {
      expect(running, "reconnect wait must have a node process to reconnect").toBe(true);
    });
    return {
      environment: admittedEnvironment,
      placement,
      service,
      waiter,
      resumeNode,
      inspect,
      provision,
    };
  }

  it("restarts the exact enrolled lease before reconnect without provisioning or changing custody", async () => {
    const h = await setup();
    await h.waiter.wait({
      placement: h.placement,
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    expect(h.resumeNode).toHaveBeenCalledOnce();
    expect(h.resumeNode.mock.calls[0]![0]).toMatchObject({
      leaseId: "lease-1",
      deviceId: "device-1",
      nodeBootstrapSha256: "b".repeat(64),
      openclawVersion: "2026.7.2",
      platform: "linux",
    });
    expect(() => h.resumeNode.mock.calls[0]![0].assertCurrent()).toThrow("owner changed");
    expect(h.provision).not.toHaveBeenCalled();
    expect(testState.store.get(h.environment.environmentId)).toEqual(h.environment);
  });

  it.each([{ connected: true }, { capable: false }, { prepared: false }])(
    "retains reconnect without provider work for %j",
    async (options) => {
      const h = await setup(options);
      const reconnected = vi.fn(async () => {});
      h.waiter.bind(reconnected);
      await h.waiter.wait({
        placement: h.placement,
        signal: new AbortController().signal,
        assertCurrent() {},
      });
      expect(reconnected).toHaveBeenCalledOnce();
      expect(h.inspect).not.toHaveBeenCalled();
      expect(h.resumeNode).not.toHaveBeenCalled();
    },
  );

  it.each<Awaited<ReturnType<WorkerProvider["inspect"]>>>([
    { status: "active" },
    { status: "active", sharedHost: true },
    { status: "dormant" },
    { status: "unknown" },
    { status: "destroyed" },
  ])("refuses restart without explicit dedicated active observation: %j", async (inspection) => {
    const h = await setup();
    h.inspect.mockResolvedValue(inspection);
    await expect(
      h.waiter.wait({
        placement: h.placement,
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    ).rejects.toThrow("active dedicated lease");
    expect(h.resumeNode).not.toHaveBeenCalled();
    expect(testState.store.get(h.environment.environmentId)).toEqual(h.environment);
  });

  it.each(["cancel", "authority", "unavailable"])(
    "holds recovery when %s interrupts inspection",
    async (reason) => {
      const h = await setup();
      const controller = new AbortController();
      let current = true;
      h.inspect.mockImplementation(async () => {
        if (reason === "cancel") {
          controller.abort(new Error("cancelled"));
        }
        if (reason === "authority") {
          current = false;
        }
        if (reason === "unavailable") {
          throw new Error("provider unavailable");
        }
        return { status: "active", sharedHost: false };
      });
      await expect(
        h.waiter.wait({
          placement: h.placement,
          signal: controller.signal,
          assertCurrent() {
            if (!current) {
              throw new Error("authority changed");
            }
          },
        }),
      ).rejects.toThrow();
      expect(h.resumeNode).not.toHaveBeenCalled();
      expect(h.provision).not.toHaveBeenCalled();
      expect(testState.store.get(h.environment.environmentId)).toEqual(h.environment);
    },
  );
});
