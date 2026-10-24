import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assert, expect, it } from "vitest";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  captureUpdateCommandExecutorAuthority,
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

export function registerExecutorRootOwnershipTests(
  fixture: () => { root: string; replaceOwner: (installationRoot?: string) => void },
) {
  function roots(withService = true) {
    const state = fixture();
    const serviceRoot = path.join(state.root, "service-A");
    if (withService) {
      fs.mkdirSync(serviceRoot);
    }
    return { ...state, serviceRoot, store: createManagedHandoffLeaseStore() };
  }
  it.each(["package", "service", "neither"] as const)(
    "admits both roots before parent mutation and preserves an unrelated owner: %s busy",
    async (busy) => {
      const { root, serviceRoot, store } = roots();
      const siblingRoot = path.join(root, "unrelated-C");
      fs.mkdirSync(siblingRoot);
      const sibling = store.acquire(siblingRoot, "unrelated", { kind: "update" });
      assert(sibling.kind === "acquired");
      const busyRoot = busy === "package" ? root : serviceRoot;
      const incumbent =
        busy === "neither"
          ? undefined
          : store.acquire(busyRoot, "other-profile", { kind: "update" });
      if (incumbent) {
        assert(incumbent.kind === "acquired");
      }
      let mutated = false;
      const work = withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root, { serviceRoot });
        expect(captureUpdateCommandExecutorAuthority(fence).installKey).toBe(root);
        for (const admitted of [root, serviceRoot]) {
          expect(store.acquire(admitted, "contender", { kind: "update" }).kind).toBe("busy");
        }
        await expect(executor.enter(root)).rejects.toThrow("installation changed");
        expect(await executor.enter(root, { serviceRoot })).toBe(fence);
        fence.assertCurrent();
        mutated = true;
      });
      if (incumbent?.kind === "acquired") {
        await expect(work).rejects.toThrow("owns");
        expect(mutated).toBe(false);
        expect(store.current(incumbent.lease)).toBe(true);
        expect(store.release(incumbent.lease)).toBe(true);
      } else {
        await work;
        expect(mutated).toBe(true);
      }
      expect([store.read(root), store.read(serviceRoot)]).toEqual([
        { kind: "absent" },
        { kind: "absent" },
      ]);
      expect(store.current(sibling.lease)).toBe(true);
      expect(store.release(sibling.lease)).toBe(true);
    },
  );

  it("releases both preflight roots before helper admission and never reactivates them", async () => {
    const { root, serviceRoot, store } = roots();
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root, { serviceRoot, preflight: true });
      releaseUpdateCommandPreflightForHandoff(fence);
      expect(fence.assertCurrent).toThrow("no longer current");
      for (const admitted of [root, serviceRoot]) {
        expect(store.read(admitted)).toEqual({ kind: "absent" });
      }
      const acquired = store.acquire(root, "independent-helper", { kind: "update" });
      assert(acquired.kind === "acquired");
      try {
        await expect(executor.enter(root)).rejects.toThrow("closed or busy");
        expect(() => releaseUpdateCommandPreflightForHandoff(fence)).toThrow("not current");
      } finally {
        expect(store.release(acquired.lease)).toBe(true);
      }
    });
  });

  it.each(["preflight", "service"] as const)(
    "refuses stale %s authority and preserves the replacement lease",
    async (owner) => {
      const preflight = owner === "preflight";
      const { root, serviceRoot, replaceOwner, store } = roots(!preflight);
      const replacedRoot = preflight ? root : serviceRoot;
      let refusal: unknown;
      await expect(
        withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(root, preflight ? { preflight } : { serviceRoot });
          replaceOwner(replacedRoot);
          try {
            if (preflight) {
              releaseUpdateCommandPreflightForHandoff(fence);
            } else {
              fence.assertCurrent();
            }
          } catch (error) {
            refusal = error;
          }
        }),
      ).rejects.toThrow();
      expect(refusal).toBeInstanceOf(UpdateCommandRecoveryPendingError);
      expect(refusal).toMatchObject({ message: expect.stringContaining("no longer current") });
      expect(store.read(replacedRoot)).toMatchObject({
        kind: "current",
        lease: { owner: "replacement" },
      });
    },
  );

  it("recovery acquires a fresh owner without reactivating the original fence", async () => {
    const { root } = fixture();
    const store = createManagedHandoffLeaseStore();
    const runId = randomUUID();
    const original = await withUpdateCommandExecutor(runId, async (executor) => {
      const fence = await executor.enter(root);
      const current = store.read(root);
      assert(current.kind === "current", "Original executor was not acquired");
      return {
        fence,
        lease: current.lease,
        authority: captureUpdateCommandExecutorAuthority(fence),
      };
    });
    expect(Object.isFrozen(original.authority)).toBe(true);
    expect(original.authority.owner).toBe(original.lease.owner);
    expect(() => captureUpdateCommandExecutorAuthority(original.fence)).toThrow(
      "no longer current",
    );
    await withUpdateCommandExecutor(
      runId,
      async (executor) => {
        const fence = await executor.enter(root);
        const current = store.read(root);
        assert(current.kind === "current", "Recovery executor was not acquired");
        expect(current.lease.owner).not.toBe(original.lease.owner);
        expect(current.lease.helper.pid).toBe(process.pid);
        const recoveredAuthority = captureUpdateCommandExecutorAuthority(fence);
        expect(recoveredAuthority).toEqual({
          ...original.authority,
          owner: current.lease.owner,
        });
        expect(Object.isFrozen(recoveredAuthority)).toBe(true);
        expect(store.current(original.lease)).toBe(false);
        expect(store.release(original.lease)).toBe(false);
        expect(original.fence.assertCurrent).toThrow("no longer current");
        fence.assertCurrent();
      },
      { existingAuthority: original.authority },
    );
    expect(store.read(root)).toEqual({ kind: "absent" });
  });
}
