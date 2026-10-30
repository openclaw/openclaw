import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import {
  beforeSettlement,
  create,
  pendingNodeEnrollment,
  providerService,
} from "./provider-lifecycle.test-support.js";
import {
  createProvider,
  createService,
  reopenWorkerEnvironmentStore,
  setupWorkerEnvironmentServiceSuite,
  testState,
} from "./service.test-support.js";

function blockedAllocation(leaseId: string) {
  const entered = createDeferredCore();
  const pending = createDeferredCore();
  const resolveAllocation = vi.fn(async () => {
    entered.resolve();
    await pending.promise;
    return { leaseId, sharedHost: false };
  });
  return { entered: entered.promise, release: pending.resolve, resolveAllocation };
}

async function failedCreation(
  service: ReturnType<typeof createService>,
  key: string,
  expected: object = { code: "provider_failure" },
) {
  await expect(create(service, key)).rejects.toMatchObject(expected);
  return expectDefined(testState.store.list()[0], "failed allocation intent");
}

const refusedProvision = () =>
  vi.fn(async () => {
    throw new Error("allocation response lost");
  });
const allocation = (leaseId: string) => vi.fn(async () => ({ leaseId, sharedHost: false }));
const expectRecord = (state: string, leaseId: string | null, details: object = {}) =>
  expect(testState.store.list()[0]).toMatchObject({ state, leaseId, ...details });
async function reopenService(provider: Parameters<typeof createService>[0]) {
  await reopenWorkerEnvironmentStore();
  return createService(provider);
}

describe("worker allocation cleanup", () => {
  setupWorkerEnvironmentServiceSuite();

  it("retries bound node retirement before completing provider cleanup", async () => {
    const retirementEntered = createDeferredCore();
    const retirementFinished = createDeferredCore();
    const primaryError = new Error("node enrollment failed after setup");
    let retireAttempts = 0;
    const retireNodeEnrollment = vi.fn(async () => {
      retirementEntered.resolve();
      await retirementFinished.promise;
      if (++retireAttempts === 1) {
        throw new Error("node retirement unavailable");
      }
    });
    const destroy = vi.fn(async () => {});
    const provider = createProvider({
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      provision: async (_profile, _operationId, options) => {
        const enrollment = await options?.beginNodeEnrollment?.();
        if (enrollment?.mode !== "connect") {
          throw new Error("expected pending enrollment");
        }
        await completeWorkerNodeSetupForTest({
          baseDir: testState.root,
          store: testState.store,
          setupId: enrollment.setupId,
          deviceId: "cleanup-device",
          completedAtMs: 1_000,
        });
        throw WorkerProviderError.cleanupComplete("cleanup-node-lease", primaryError);
      },
      destroy,
      inspect: async () => ({ status: "destroyed" }),
    });
    const provision = vi.spyOn(provider, "provision");
    const newService = () =>
      createService(provider, {
        prepareNodeEnrollment: (record) =>
          pendingNodeEnrollment(record, async () => "cleanup-device"),
        retireNodeEnrollment,
      });
    let service = newService();
    const creation = create(service, "confirmed-node-cleanup").catch((error: unknown) => error);
    try {
      await beforeSettlement(retirementEntered.promise, creation, "Node retirement");
      expectRecord("destroying", "cleanup-node-lease", {
        nodeDeviceId: "cleanup-device",
        lastError: primaryError.message,
      });
    } finally {
      retirementFinished.resolve();
      await creation;
    }
    expect(await creation).toMatchObject({ message: "node retirement unavailable" });
    expectRecord("destroying", "cleanup-node-lease", {
      lastError: primaryError.message,
    });
    await reopenWorkerEnvironmentStore();
    service = newService();
    await service.reconcileOnce();
    expectRecord("failed", null, {
      nodeDeviceId: null,
      lastError: primaryError.message,
    });
    expect(retireNodeEnrollment).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("does not replay a confirmed-cleaned-up allocation after restart", async () => {
    const primaryError = new Error("project preparation failed before enrollment");
    let attempts = 0;
    const provision = vi.fn(async () => {
      if (++attempts === 1) {
        throw new Error("allocation response lost");
      }
      throw WorkerProviderError.cleanupComplete("released-allocation", primaryError);
    });
    const destroy = vi.fn(async () => {});
    const provider = createProvider({ provision, destroy });
    let service = createService(provider);
    const intent = await failedCreation(service, "confirmed-cleanup", {
      code: "provider_failure",
      message: expect.stringContaining("allocation response lost"),
    });
    expect(intent).toMatchObject({ state: "provisioning", leaseId: null });
    service = await reopenService(provider);
    await service.reconcileOnce();
    const failed = {
      state: "failed",
      leaseId: null,
      lastError: primaryError.message,
    };
    expect(service.get(intent.environmentId)).toMatchObject(failed);
    service = await reopenService(provider);
    await service.reconcileOnce();
    expect(service.get(intent.environmentId)).toMatchObject(failed);
    expect(provision).toHaveBeenCalledTimes(2);
    expect(destroy).not.toHaveBeenCalled();
    expect(testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("retains cleanup intent for an invalid allocation identity", async () => {
    const destroy = vi.fn(async () => {});
    const provider = createProvider({
      provision: refusedProvision(),
      // Exercise the untyped plugin result boundary without changing the public contract.
      resolveAllocation: async () => ({ leaseId: "unattested-host" }) as never,
      destroy,
    });
    const service = createService(provider);
    const pending = await failedCreation(service, "invalid-allocation");
    await expect(service.destroy(pending.environmentId)).rejects.toMatchObject({
      code: "provider_failure",
      message: "Worker provider returned an invalid allocation identity",
    });
    expectRecord("provisioning", null, {
      sharedHost: null,
      destroyRequestedAtMs: expect.any(Number),
      lastError: "Worker provider returned an invalid allocation identity",
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("does not replay refused provisioning during restart cleanup", async () => {
    const provision = refusedProvision();
    const resolveAllocation = allocation("operation-cleanup");
    const destroy = vi.fn(async () => {});
    const provider = {
      ...createProvider({ provisionBeforeInstallation: true, provision, destroy }),
      resolveAllocation,
    };
    let service = createService(provider);
    const pending = await failedCreation(service, "preflight-cleanup");
    expect(pending).toMatchObject({ state: "provisioning", leaseId: null });
    await testState.store.requestDestroy({
      environmentId: pending.environmentId,
      state: pending.state,
    });
    // Cleanup must use the persisted profile even after the operator removes it.
    testState.config.cloudWorkers!.profiles = {};
    service = await reopenService(provider);
    await service.reconcileOnce();

    const terminal = expectDefined(service.get(pending.environmentId), "terminal environment");
    await expect(service.destroy(pending.environmentId)).resolves.toEqual(terminal);
    await service.reconcileOnce();
    service = await reopenService(provider);
    await service.reconcileOnce();
    await expect(service.destroy(pending.environmentId)).resolves.toEqual(terminal);

    expect(provision).toHaveBeenCalledOnce();
    expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
      { region: "test" },
      pending.provisionOperationId,
    );
    expect(destroy).toHaveBeenCalledExactlyOnceWith({
      leaseId: "operation-cleanup",
      profile: { region: "test" },
      signal: expect.any(AbortSignal),
    });
    expect(testState.prepareInstallation).not.toHaveBeenCalled();
    expect(testState.bootstrapWorker).not.toHaveBeenCalled();
    expect(testState.store.getCredential(pending.environmentId)).toBeUndefined();
    expectRecord("destroyed", "operation-cleanup", {
      sharedHost: false,
      sshEndpoint: null,
      nodeDeviceId: null,
      bootstrapReceipt: null,
      ownerEpoch: 0,
    });
  });

  it("retains an unreported allocation across failed teardown and restart", async () => {
    const physicalLeases = new Set<string>();
    const leaseId = "lost-response-allocation";
    const provision = vi.fn(async () => {
      physicalLeases.add(leaseId);
      throw new Error("allocation response lost");
    });
    const resolveAllocation = allocation(leaseId);
    const secret = "fixture-release-secret";
    const destroy = vi
      .fn(async () => {
        physicalLeases.delete(leaseId);
      })
      .mockRejectedValueOnce(
        new Error(
          `release outcome unknown;\n retry cleanup; token=${secret}; ${"detail ".repeat(200)}`,
        ),
      );
    const provider = createProvider({ provision, resolveAllocation, destroy });
    const first = createService(provider);
    const pending = await failedCreation(first, "lost-allocation");
    await testState.store.requestDestroy({
      environmentId: pending.environmentId,
      state: pending.state,
      terminalState: "destroyed",
      lastError: "allocation response lost",
    });
    const cleanupFailure = await (
      await reopenService(provider)
    )
      .destroy(pending.environmentId)
      .catch((error: unknown) => error);
    expect(cleanupFailure).toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("release outcome unknown; retry cleanup;"),
    });
    expect(cleanupFailure).toHaveProperty("message", expect.not.stringContaining(secret));
    expect(cleanupFailure).toHaveProperty("message", expect.stringMatching(/^[^\n]{1,1024}$/u));
    expect(physicalLeases).toEqual(new Set([leaseId]));
    expectRecord("destroying", leaseId, {
      teardownTerminalState: "destroyed",
    });
    await (await reopenService(provider)).reconcileOnce();
    expect(provision).toHaveBeenCalledOnce();
    expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
      { region: "test" },
      pending.provisionOperationId,
    );
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(physicalLeases.size).toBe(0);
    expectRecord("destroyed", leaseId);
  });

  it.each(["queued", "resolving"] as const)(
    "fences a replaced cleanup owner while allocation resolution is %s",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const provisionEntered = createDeferredCore();
      const intentCommitted = createDeferredCore();
      const provisionPending = createDeferredCore();
      const resolution = blockedAllocation("old-allocation");
      const { resolveAllocation } = resolution;
      const requestDestroy = testState.store.requestDestroy.bind(testState.store);
      vi.spyOn(testState.store, "requestDestroy").mockImplementation(async (input) => {
        const record = await requestDestroy(input);
        intentCommitted.resolve();
        return record;
      });
      const provision = vi.fn(async () => {
        provisionEntered.resolve();
        if (phase === "queued") {
          await provisionPending.promise;
        }
        throw new Error("provision response lost");
      });
      const destroy = vi.fn(async () => {});
      const service = providerService({
        provision,
        resolveAllocation,
        destroy,
        resolveProvisionTimeoutMs: () => 20,
      });
      const creation = create(service, "owner-race").catch((error: unknown) => error);
      let teardownResult: Promise<unknown> | undefined;
      try {
        await beforeSettlement(provisionEntered.promise, creation, "Provision");
        if (phase === "queued") {
          await vi.advanceTimersByTimeAsync(20);
        }
        expect(await creation).toMatchObject({ code: "provider_failure" });
        const pending = expectDefined(testState.store.list()[0], "pending owner");
        teardownResult = service.destroy(pending.environmentId).catch((error: unknown) => error);
        await beforeSettlement(intentCommitted.promise, teardownResult, "Destroy intent");
        if (phase === "resolving") {
          await beforeSettlement(resolution.entered, teardownResult, "Allocation resolution");
        }
        const replacement = await testState.store.transition({
          environmentId: pending.environmentId,
          from: "provisioning",
          to: "draining",
          patch: {
            leaseId: "replacement-allocation",
            sharedHost: true,
            lastError: "replacement owner",
          },
        });
        provisionPending.resolve();
        resolution.release();
        expect(await teardownResult).toBeInstanceOf(Error);
        expect(testState.store.get(pending.environmentId)).toEqual(replacement);
        expect(resolveAllocation).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
        expect(provision).toHaveBeenCalledOnce();
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        provisionPending.resolve();
        resolution.release();
        await Promise.all([creation, teardownResult]);
      }
    },
  );

  it("keeps timed-out allocation resolution owned until settlement, including shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const resolution = blockedAllocation("late-allocation");
    const { resolveAllocation } = resolution;
    const provision = refusedProvision();
    const destroy = vi.fn(async () => {});
    const service = providerService(
      { provision, resolveAllocation, destroy },
      { providerCallTimeoutMs: 20 },
    );
    const pending = await failedCreation(service, "resolution-timeout");
    const teardownResult = service.destroy(pending.environmentId).catch((error: unknown) => error);
    let retryResult: Promise<unknown> | undefined;
    let stopping: Promise<void> | undefined;
    let stopped = false;
    try {
      await beforeSettlement(resolution.entered, teardownResult, "Allocation resolution");
      await vi.advanceTimersByTimeAsync(20);
      expect.soft(await teardownResult).toMatchObject({
        code: "provider_failure",
        message: "Worker provider operation timed out after 20ms",
      });
      retryResult = service.destroy(pending.environmentId).catch((error: unknown) => error);
      stopping = service.stop().then(() => {
        stopped = true;
      });
      // The retry and shutdown have been admitted, but neither can release the provider queue.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(resolveAllocation).toHaveBeenCalledOnce();
      expect(destroy).not.toHaveBeenCalled();
      expect(stopped).toBe(false);
      expectRecord("provisioning", null, {
        destroyRequestedAtMs: expect.any(Number),
      });
    } finally {
      resolution.release();
      await Promise.all([teardownResult, retryResult, stopping]);
    }
    expect(await retryResult).toMatchObject({
      code: "provider_failure",
      message: "Worker reconciliation paused",
    });
    expect(resolveAllocation).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    expect(stopped).toBe(true);
    expectRecord("destroying", "late-allocation");
    const restarted = await reopenService(
      createProvider({ provision, resolveAllocation, destroy }),
    );
    await restarted.reconcileOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expectRecord("destroyed", "late-allocation");
  });
});
