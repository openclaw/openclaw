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
  it.each(["package", "service", "neither"] as const)(
    "admits both roots before parent mutation and preserves an unrelated owner: %s busy",
    async (busy) => {
      const { root } = fixture();
      const serviceRoot = path.join(root, "service-A");
      const siblingRoot = path.join(root, "unrelated-C");
      fs.mkdirSync(serviceRoot);
      fs.mkdirSync(siblingRoot);
      const store = createManagedHandoffLeaseStore();
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
      expect(store.read(root)).toEqual({ kind: "absent" });
      expect(store.read(serviceRoot)).toEqual({ kind: "absent" });
      expect(store.current(sibling.lease)).toBe(true);
      expect(store.release(sibling.lease)).toBe(true);
    },
  );

  it("releases both preflight roots before helper admission and never reactivates them", async () => {
    const { root } = fixture();
    const serviceRoot = path.join(root, "service-A");
    fs.mkdirSync(serviceRoot);
    const store = createManagedHandoffLeaseStore();
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root, { serviceRoot, preflight: true });
      releaseUpdateCommandPreflightForHandoff(fence);
      expect(fence.assertCurrent).toThrow("no longer current");
      for (const admitted of [root, serviceRoot]) {
        expect(store.read(admitted)).toEqual({ kind: "absent" });
      }
    });
  });

  it("refuses to release a replaced preflight owner and preserves the new lease", async () => {
    const { root, replaceOwner } = fixture();
    let refusal: unknown;
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root, { preflight: true });
        replaceOwner();
        try {
          releaseUpdateCommandPreflightForHandoff(fence);
        } catch (error) {
          refusal = error;
        }
      }),
    ).rejects.toThrow();
    expect(refusal).toBeInstanceOf(UpdateCommandRecoveryPendingError);
    expect(refusal).toMatchObject({ message: expect.stringContaining("no longer current") });
    expect(createManagedHandoffLeaseStore().read(root)).toMatchObject({
      kind: "current",
      lease: { owner: "replacement" },
    });
  });

  it("invalidates the package fence if its service owner is replaced", async () => {
    const { root, replaceOwner } = fixture();
    const serviceRoot = path.join(root, "service-A");
    fs.mkdirSync(serviceRoot);
    let refusal: unknown;
    await expect(
      withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(root, { serviceRoot });
        replaceOwner(serviceRoot);
        try {
          fence.assertCurrent();
        } catch (error) {
          refusal = error;
        }
      }),
    ).rejects.toThrow();
    expect(refusal).toBeInstanceOf(UpdateCommandRecoveryPendingError);
    expect(refusal).toMatchObject({ message: expect.stringContaining("no longer current") });
    expect(createManagedHandoffLeaseStore().read(serviceRoot)).toMatchObject({
      kind: "current",
      lease: { owner: "replacement" },
    });
  });
}
