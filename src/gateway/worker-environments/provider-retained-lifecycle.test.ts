import { describe, expect, it, vi } from "vitest";
import type { WorkerLeaseStatus, WorkerResourceReceipt } from "../../plugins/types.js";
import type {
  WorkerRetentionObservation,
  WorkerRetentionOperation,
} from "../../plugins/worker-retention.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";
import { workerReadyPatch } from "./store.test-support.js";

const policy = { version: 1 as const, ownerBinding: "a".repeat(64), computeWindowSeconds: 600 };
const receipt: WorkerResourceReceipt = {
  version: 1,
  leaseId: "lease-retained",
  identity: { disk: "original" },
};
async function seed() {
  const store = support.testState.store;
  const environmentId = "retained-original";
  const provisionOperationId = "provision-original";
  await store.createIntent({
    environmentId,
    provisionOperationId,
    providerId: "fake",
    profileId: "development",
    profileSnapshot: { settings: {}, executionMode: "worker-turn" },
    retention: policy,
  });
  await store.transition({ environmentId, from: "requested", to: "provisioning" });
  await store.recordResourceReceipt({
    environmentId,
    provisionOperationId,
    receipt,
    assertCurrent: () => {},
  });
  const record = await store.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: {
      ...workerReadyPatch(receipt.leaseId, "node-original"),
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    },
  });
  return { environmentId, expectedOwnerEpoch: record.ownerEpoch, assertCurrent: () => {} };
}
function fixture(environmentId = "retained-original") {
  let observation: WorkerRetentionObservation = {
    claimRevision: "revision-initial",
    state: "running",
    computeExpiresAtMs: 601_000,
  };
  const inspect = vi.fn<import("../../plugins/types.js").WorkerProvider["inspect"]>(
    async (): Promise<WorkerLeaseStatus> => ({
      status: observation.state === "running" ? "active" : "dormant",
      resourceReceipt: receipt,
      retention: observation,
    }),
  );
  const operations: WorkerRetentionOperation[] = [];
  const setRetainedState = vi.fn(
    async (
      lease: Parameters<
        NonNullable<import("../../plugins/types.js").WorkerProvider["setRetainedState"]>
      >[0],
    ) => {
      lease.assertCurrent();
      expect(lease.resourceReceipt).toEqual(receipt);
      expect(lease.retention).toEqual(policy);
      expect(support.testState.store.get(environmentId)?.retention?.operation).toEqual(
        lease.operation,
      );
      operations.push(lease.operation);
      observation = {
        claimRevision: "revision-" + operations.length,
        state: lease.operation.action === "pause" ? "suspended" : "running",
        computeExpiresAtMs: support.testState.nowMs + 600_000,
        operation: { ...lease.operation, phase: "observed" },
      };
      return observation;
    },
  );
  const destroy = vi.fn(async () => {});
  const provider = support.createProvider({
    supportsResourceReceipts: true,
    inspect,
    setRetainedState,
    destroy,
  });
  const waitForRetainedNode = vi.fn(async (_node: string, args: { assertCurrent: () => void }) => {
    args.assertCurrent();
  });
  const ensureNodeWorkerBundle = vi.fn(async () => support.BOOTSTRAP_RECEIPT);
  const service = () =>
    support.createService(provider, { waitForRetainedNode, ensureNodeWorkerBundle });
  return {
    provider,
    service,
    operations,
    inspect,
    destroy,
    setRetainedState,
    waitForRetainedNode,
    ensureNodeWorkerBundle,
    get observation() {
      return observation;
    },
    set observation(value: WorkerRetentionObservation) {
      observation = value;
    },
  };
}

describe("retained lifecycle through the environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();
  it("recovers expired initial provisioning only on a fresh authorized creation retry", async () => {
    const request = {
      profileId: "development",
      idempotencyKey: "initial-retained",
      retainedPolicy: policy,
    };
    const { environmentId } = deriveEnvironmentIntent(request.idempotencyKey);
    const f = fixture(environmentId);
    let first = true;
    const provision = vi.fn<typeof f.provider.provision>(async (_profile, _operation, options) => {
      await options!.recordResourceReceipt!(receipt);
      if (first) {
        first = false;
        throw new Error("initial provisioning interrupted");
      }
      if (f.observation.state !== "running") {
        throw new Error("explicit lifecycle recovery required");
      }
      options!.assertCurrent!();
      return {
        leaseId: receipt.leaseId,
        resourceReceipt: receipt,
        node: { deviceId: "node-original" },
        sharedHost: false,
      };
    });
    f.provider.requiresNodeEnrollment = true;
    f.provider.provision = provision;
    const service = () =>
      support.createService(f.provider, {
        ensureNodeWorkerBundle: f.ensureNodeWorkerBundle,
        prepareNodeEnrollment: async () => ({
          mode: "resume",
          deviceId: "node-original",
          displayName: "Retained fixture",
          openclawVersion: "2026.8.1",
          nodeBootstrap: support.NODE_BOOTSTRAP,
          waitForDeviceId: async () => "node-original",
        }),
      });
    await expect(service().createWithRequest(request)).rejects.toThrow(
      "initial provisioning interrupted",
    );
    const initial = support.testState.store.get(environmentId)!;
    expect(initial).toMatchObject({
      state: "provisioning",
      ownerEpoch: 0,
      leaseId: null,
      nodeDeviceId: null,
      resourceReceipt: receipt,
    });
    f.observation = { ...f.observation, state: "expired", computeExpiresAtMs: 999 };
    await support.reopenWorkerEnvironmentStore();
    const restarted = service();
    await restarted.reconcileOnce();
    expect(f.operations).toEqual([]);
    const mutate = f.setRetainedState.getMockImplementation()!;
    let revoked = false;
    f.setRetainedState.mockImplementation(async (lease) => {
      if (lease.operation.action === "resume") {
        revoked = true;
        lease.assertCurrent();
      }
      return mutate(lease);
    });
    await expect(
      restarted.createWithRequest({
        ...request,
        beforeProvision: () => {
          if (revoked) {
            throw new Error("retry authority revoked");
          }
        },
      }),
    ).rejects.toThrow("retry authority revoked");
    const pending = support.testState.store.get(environmentId)!.retention!.operation!;
    expect(pending.action).toBe("resume");
    f.setRetainedState.mockImplementation(mutate);
    await support.reopenWorkerEnvironmentStore();
    const recovered = service();
    await recovered.reconcileOnce();
    expect(f.operations.map(({ action }) => action)).toEqual(["pause"]);
    await expect(recovered.createWithRequest(request)).resolves.toMatchObject({ state: "ready" });
    expect(f.operations).toEqual([expect.objectContaining({ action: "pause" }), pending]);
    expect(recovered.get(environmentId)).toMatchObject({
      ownerEpoch: 1,
      leaseId: receipt.leaseId,
      nodeDeviceId: "node-original",
      resourceReceipt: receipt,
      retention: { operation: null, runtimeReady: true },
    });
    expect(
      provision.mock.calls.every(([, operation]) => operation === initial.provisionOperationId),
    ).toBe(true);
    expect(f.destroy).not.toHaveBeenCalled();
  });
  it("preserves a revoked pending resume until an explicit authorized wake", async () => {
    const request = await seed();
    const f = fixture();
    f.observation = { ...f.observation, state: "suspended" };
    const mutate = f.setRetainedState.getMockImplementation()!;
    let revoked = false;
    f.setRetainedState.mockImplementation(async (lease) => {
      if (lease.operation.action === "resume") {
        revoked = true;
        lease.assertCurrent();
      }
      return mutate(lease);
    });
    await expect(
      f.service().ensureRetainedRunning({
        ...request,
        assertCurrent: () => {
          if (revoked) {
            throw new Error("wake authority revoked");
          }
        },
      }),
    ).rejects.toThrow("wake authority revoked");
    const resume = support.testState.store.get(request.environmentId)!.retention!.operation!;
    expect(resume.action).toBe("resume");
    expect(f.operations.map(({ action }) => action)).toEqual(["pause"]);
    f.setRetainedState.mockImplementation(mutate);
    await support.reopenWorkerEnvironmentStore();
    const restarted = f.service();
    await restarted.reconcileOnce();
    expect(f.operations.map(({ action }) => action)).toEqual(["pause"]);
    expect(restarted.get(request.environmentId)?.retention).toMatchObject({
      operation: resume,
      runtimeReady: false,
    });
    await expect(restarted.suspendRetained(request)).rejects.toThrow(
      "An earlier retained lifecycle operation must settle",
    );
    expect(f.operations.map(({ action }) => action)).toEqual(["pause"]);
    expect(restarted.get(request.environmentId)?.retention?.operation).toEqual(resume);
    await restarted.ensureRetainedRunning(request);
    expect(f.operations.slice(1)).toEqual([resume]);
    expect(restarted.get(request.environmentId)?.retention).toMatchObject({
      operation: null,
      runtimeReady: true,
    });
  });

  it("replays pending pause cleanup and observes completed resume without resubmitting it", async () => {
    const request = await seed();
    const f = fixture();
    const mutate = f.setRetainedState.getMockImplementation()!;
    f.setRetainedState.mockRejectedValueOnce(new Error("pause not submitted"));
    await expect(f.service().suspendRetained(request)).rejects.toThrow("pause not submitted");
    const pause = support.testState.store.get(request.environmentId)!.retention!.operation!;
    await support.reopenWorkerEnvironmentStore();
    const restarted = f.service();
    await restarted.reconcileOnce();
    expect(f.operations).toEqual([pause]);
    expect(restarted.get(request.environmentId)?.retention?.operation).toBeNull();
    f.setRetainedState.mockImplementation(async (lease) => {
      const observed = await mutate(lease);
      if (lease.operation.action === "resume") {
        throw new Error("resume reply lost");
      }
      return observed;
    });
    await expect(restarted.ensureRetainedRunning(request)).rejects.toThrow("resume reply lost");
    const resume = support.testState.store.get(request.environmentId)!.retention!.operation!;
    expect(f.operations.at(-1)).toEqual(resume);
    f.setRetainedState.mockClear();
    await support.reopenWorkerEnvironmentStore();
    const observed = f.service();
    await observed.reconcileOnce();
    expect(f.setRetainedState).not.toHaveBeenCalled();
    expect(observed.get(request.environmentId)?.retention).toMatchObject({
      operation: null,
      runtimeReady: false,
      observation: { state: "running", operation: { ...resume, phase: "observed" } },
    });
  });

  it("recovers lost pause and resume replies without replacing the disk, and waits for the same node before readiness", async () => {
    const request = await seed();
    const f = fixture();
    const mutate = f.setRetainedState.getMockImplementation()!;
    f.setRetainedState.mockImplementationOnce(async (lease) => {
      await mutate(lease);
      throw new Error("pause reply lost");
    });
    await expect(f.service().suspendRetained(request)).rejects.toThrow("pause reply lost");
    const pause = support.testState.store.get(request.environmentId)!.retention!.operation!;
    await support.reopenWorkerEnvironmentStore();
    const service = f.service();
    await service.reconcileOnce();
    expect(f.operations).toEqual([pause]);
    expect(support.testState.store.get(request.environmentId)!.retention!.operation).toBeNull();
    f.setRetainedState
      .mockImplementationOnce(async (lease) => {
        // Pause already observed: the next effect is a durable resume.
        return mutate(lease);
      })
      .mockImplementationOnce(async (lease) => {
        await mutate(lease);
        f.observation = {
          ...f.observation,
          state: "transitioning",
          operation: { ...lease.operation, phase: "pending" },
        };
        throw new Error("resume reply lost");
      });
    await expect(service.ensureRetainedRunning(request)).rejects.toThrow("resume reply lost");
    const resume = support.testState.store.get(request.environmentId)!.retention!.operation!;
    const connected = createDeferredCore();
    const waiting = createDeferredCore();
    f.waitForRetainedNode.mockImplementationOnce(async (node, args) => {
      expect(node).toBe("node-original");
      waiting.resolve();
      await connected.promise;
      args.assertCurrent();
    });
    const completed = vi.fn();
    const wake = service.ensureRetainedRunning(request).then(completed);
    try {
      await waiting.promise;
      expect(completed).not.toHaveBeenCalled();
      expect(f.ensureNodeWorkerBundle).not.toHaveBeenCalled();
      expect(service.get(request.environmentId)?.retention?.runtimeReady).toBe(false);
    } finally {
      connected.resolve();
    }
    await wake;
    expect(service.get(request.environmentId)?.retention?.runtimeReady).toBe(true);
    expect(f.operations.slice(-2)).toEqual([resume, resume]);
    expect(f.ensureNodeWorkerBundle).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "node-original" }),
    );
    expect(support.testState.store.get(request.environmentId)).toMatchObject({
      leaseId: receipt.leaseId,
      resourceReceipt: receipt,
      ownerEpoch: request.expectedOwnerEpoch,
    });
    await service.destroy(request.environmentId);
    expect(f.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ resourceReceipt: receipt, retention: policy }),
    );
  });

  it("keeps runtime admission closed after a failed refresh and background observation", async () => {
    const request = await seed();
    const f = fixture();
    const service = f.service();
    await service.ensureRetainedRunning(request);
    expect(service.get(request.environmentId)?.retention?.runtimeReady).toBe(true);
    f.ensureNodeWorkerBundle.mockRejectedValueOnce(new Error("runtime install interrupted"));
    await expect(service.ensureRetainedRunning(request)).rejects.toThrow(
      "runtime install interrupted",
    );
    await support.reopenWorkerEnvironmentStore();
    const restarted = f.service();
    await restarted.reconcileOnce();
    expect(restarted.get(request.environmentId)?.retention?.runtimeReady).toBe(false);
    await restarted.ensureRetainedRunning(request);
    expect(restarted.get(request.environmentId)?.retention?.runtimeReady).toBe(true);
    expect(f.setRetainedState).not.toHaveBeenCalled();
  });

  it("contains an unavailable provider while another environment reconciles, without resuming or deleting its disk", async () => {
    const request = await seed();
    await support.seedReady("other-worker");
    const f = fixture();
    f.inspect.mockImplementation(async (lease) => {
      if (lease.leaseId === receipt.leaseId) {
        throw new Error("provider unavailable");
      }
      return { status: "active" };
    });
    await f.service().reconcileOnce();
    expect(f.inspect.mock.calls.some(([lease]) => lease.leaseId === "lease:other-worker")).toBe(
      true,
    );
    expect(support.testState.store.get(request.environmentId)).toMatchObject({
      destroyRequestedAtMs: null,
      resourceReceipt: receipt,
    });
    expect(f.setRetainedState).not.toHaveBeenCalled();
    expect(f.destroy).not.toHaveBeenCalled();
  });

  it("closes an expired finite window during maintenance but requires explicit wake for new compute", async () => {
    const request = await seed();
    const f = fixture();
    f.observation = { ...f.observation, state: "expired", computeExpiresAtMs: 999 };
    await f.service().reconcileOnce();
    expect(f.operations.map(({ action }) => action)).toEqual(["pause"]);
    expect(f.waitForRetainedNode).not.toHaveBeenCalled();
    expect(support.testState.store.get(request.environmentId)!.retention!.observation?.state).toBe(
      "suspended",
    );
  });

  it("refuses changed receipt, revoked caller, and cancellation before mutation", async () => {
    const request = await seed();
    const f = fixture();
    const service = f.service();
    f.inspect.mockResolvedValueOnce({
      status: "active",
      resourceReceipt: { ...receipt, identity: { disk: "replacement" } },
      retention: f.observation,
    });
    await expect(service.ensureRetainedRunning(request)).rejects.toThrow("committed identity");
    await expect(
      service.suspendRetained({
        ...request,
        assertCurrent: () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    await expect(
      service.ensureRetainedRunning({
        ...request,
        signal: AbortSignal.abort(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
    expect(f.setRetainedState).not.toHaveBeenCalled();
    expect(f.destroy).not.toHaveBeenCalled();
  });
});
