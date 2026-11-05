import { describe, expect, it, vi } from "vitest";
import type { WorkerLeaseStatus, WorkerResourceReceipt } from "../../plugins/types.js";
import { create } from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";

const receipt: WorkerResourceReceipt = {
  version: 1,
  leaseId: "lease-resource",
  identity: { resourceId: "resource-original", attempt: "attempt-original" },
};

describe("provider resource custody", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("recovers a receipt committed before a lost provision reply, then retains uncertain deletion across restart", async () => {
    const operations: string[] = [];
    let loseReply = true;
    let deletionConfirmed = false;
    const destroy = vi.fn(
      async (lease: Parameters<import("../../plugins/types.js").WorkerProvider["destroy"]>[0]) => {
        lease.assertCurrent?.();
        expect(lease.resourceReceipt).toEqual(receipt);
        if (!deletionConfirmed) {
          throw new Error("provider deletion outcome unavailable");
        }
      },
    );
    const provider = support.createProvider({
      supportsResourceReceipts: true,
      resolveAllocation: async () => ({ leaseId: receipt.leaseId, sharedHost: false }),
      provision: async (_profile, operationId, options) => {
        operations.push(operationId);
        if (!loseReply) {
          expect(options?.resourceReceipt).toEqual(receipt);
        }
        await options?.recordResourceReceipt?.(receipt);
        expect(support.testState.store.list()[0]?.resourceReceipt).toEqual(receipt);
        if (loseReply) {
          loseReply = false;
          throw new Error("allocation reply lost");
        }
        return { leaseId: receipt.leaseId, resourceReceipt: receipt, ssh: support.SSH_ENDPOINT };
      },
      inspect: async () => ({ status: "active", sharedHost: false, resourceReceipt: receipt }),
      destroy,
    });
    await expect(create(support.createService(provider), "resource-custody")).rejects.toThrow(
      "allocation reply lost",
    );
    const pending = support.testState.store.list()[0]!;
    expect(pending).toMatchObject({
      state: "provisioning",
      leaseId: null,
      resourceReceipt: receipt,
    });
    await support.reopenWorkerEnvironmentStore();
    const restarted = support.createService(provider);
    await restarted.reconcileOnce();
    expect(support.testState.store.get(pending.environmentId)).toMatchObject({
      state: "ready",
      resourceReceipt: receipt,
    });
    expect(operations).toEqual([pending.provisionOperationId, pending.provisionOperationId]);
    await expect(restarted.destroy(pending.environmentId)).rejects.toThrow(
      "deletion outcome unavailable",
    );
    expect(support.testState.store.get(pending.environmentId)).toMatchObject({
      state: "destroying",
      resourceReceipt: receipt,
    });
    await support.reopenWorkerEnvironmentStore();
    deletionConfirmed = true;
    await support.createService(provider).reconcileOnce();
    expect(support.testState.store.get(pending.environmentId)).toMatchObject({
      state: "destroyed",
      resourceReceipt: receipt,
    });
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "changed", "offline", "unsupported"] as const)(
    "does not turn %s resource observation into deletion or replacement",
    async (failure) => {
      const destroy = vi.fn(async () => {});
      let observation: WorkerLeaseStatus = {
        status: "active",
        sharedHost: false,
        resourceReceipt: receipt,
      };
      let offline = false;
      const provider = support.createProvider({
        supportsResourceReceipts: true,
        provision: async (_profile, _operation, options) => {
          await options?.recordResourceReceipt?.(receipt);
          return { leaseId: receipt.leaseId, resourceReceipt: receipt, ssh: support.SSH_ENDPOINT };
        },
        inspect: async () => {
          if (offline) {
            throw new Error("offline observation");
          }
          return observation;
        },
        destroy,
      });
      const service = support.createService(provider);
      const ready = await create(service, "observation-" + failure);
      if (failure === "missing") {
        observation = { status: "destroyed" };
      }
      if (failure === "changed") {
        observation = {
          status: "unknown",
          resourceReceipt: { ...receipt, identity: { resourceId: "other" } },
        };
      }
      if (failure === "offline") {
        offline = true;
      }
      if (failure === "unsupported") {
        delete provider.supportsResourceReceipts;
      }
      await service.reconcileOnce();
      expect(support.testState.store.get(ready.environmentId)).toMatchObject({
        state: "ready",
        resourceReceipt: receipt,
        destroyRequestedAtMs: null,
      });
      expect(destroy).not.toHaveBeenCalled();
      if (failure === "unsupported") {
        await expect(service.destroy(ready.environmentId)).rejects.toThrow("cannot honor");
        expect(destroy).not.toHaveBeenCalled();
      }
    },
  );
});
