import { expect, it, vi } from "vitest";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => ({}),
}));

function fixture(name: string, state: "active" | "failed" | "local" | "reclaimed" = "active") {
  const request = {
    sessionId: `session-${name}`,
    sessionKey: `agent:main:${name}`,
    agentId: "main",
  };
  const entry = { sessionId: request.sessionId, lifecycleRevision: "original", updatedAt: 1 };
  const target = {
    storePath: `/fixture/reclaim-preparation-${name}.sqlite`,
    canonicalKey: request.sessionKey,
    storeKeys: [request.sessionKey],
    agentId: request.agentId,
    store: { [request.sessionKey]: entry },
  };
  const placement = {
    ...request,
    state,
    generation: 4,
    environmentId: "worker",
    activeOwnerEpoch: 7,
  };
  const cancel = vi.fn(async (input: { assertCurrent: () => void }) => input.assertCurrent());
  const barriers = createGatewayWorkerPlacementReclaimBarriers({
    placements: {
      get: () => ({ ...placement }) as never,
      getAsync: async () => ({ ...placement }) as never,
      waitForTurnClaimRelease: async () => {},
    },
    loadSessionRuntime: async () => ({
      managedWorktrees: { findLiveByOwner: async () => undefined },
      resolveGatewaySessionStoreTargetWithStore: () => target,
      resolveCanonicalSessionEntryFromStoreKeys: () => entry,
    }),
    cancelSessionWork: cancel,
    revokeSessionAuthority: vi.fn(),
  });
  const run = vi.fn(async () => ({ ...placement, state: "reclaimed" as const }) as never);
  const admit = (onInterrupt?: () => void) =>
    beginSessionWorkAdmission({
      scope: target.storePath,
      identities: [request.sessionKey, request.sessionId],
      assertAllowed: () => {},
      onInterrupt,
    });
  return {
    ...request,
    entry,
    placement,
    cancel,
    run,
    admit,
    prepare: (options: Partial<Parameters<typeof barriers.runReclaimPreparation>[0]> = {}) =>
      barriers.runReclaimPreparation({ ...request, run, ...options }),
  };
}

it("one failed Stop cannot reopen ingress while another Stop still owns its closure", async () => {
  const f = fixture("overlap");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let calls = 0;
  f.cancel.mockImplementation(async ({ assertCurrent }) => {
    assertCurrent();
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
    } else {
      throw new Error("second cancellation failed");
    }
  });
  const first = f.prepare();
  await entered.promise;
  try {
    await expect(f.prepare()).rejects.toThrow("second cancellation failed");
    await expect(f.admit()).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await first;
  }
  (await f.admit()).release();
});

it.each(["authorization", "incarnation"] as const)(
  "rejects changed %s after cancellation and reopens admission on failure",
  async (change) => {
    const f = fixture(`changed-${change}`);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let authorized = true;
    const interrupted = vi.fn();
    const acquired = await f.admit(() => {
      interrupted();
      acquired.release();
    });
    f.cancel.mockImplementation(async ({ assertCurrent }) => {
      assertCurrent();
      entered.resolve();
      await release.promise;
    });
    try {
      const stop = f.prepare({
        authorize: () => {
          if (!authorized) {
            throw new Error("access revoked");
          }
        },
      });
      const rejected = expect(stop).rejects.toThrow(
        change === "authorization" ? "access revoked" : "Session",
      );
      await entered.promise;
      if (change === "authorization") {
        authorized = false;
      } else {
        f.entry.lifecycleRevision = "replacement-with-same-session-id";
      }
      release.resolve();
      await rejected;
      expect(interrupted).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
      (await f.admit()).release();
    } finally {
      release.resolve();
      acquired.release();
    }
  },
);

it("rechecks the exact worker owner after asynchronous cancellation setup", async () => {
  const f = fixture("changed-worker");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const signalled = vi.fn();
  f.cancel.mockImplementation(async ({ assertCurrent }) => {
    entered.resolve();
    await release.promise;
    assertCurrent();
    signalled();
  });
  const stop = f.prepare();
  const rejected = expect(stop).rejects.toThrow("worker changed before cancellation");
  await entered.promise;
  // The store returns immutable snapshots; replacement must not mutate the captured owner.
  const priorGeneration = f.placement.generation;
  f.placement.generation = priorGeneration + 1;
  release.resolve();
  await rejected;
  expect(signalled).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});

it("auto-suspend eligibility rejects before closing admission or signalling cancellation", async () => {
  const f = fixture("auto-suspend");
  await expect(
    f.prepare({
      beforeDrain: () => {
        throw new Error("session is busy");
      },
    }),
  ).rejects.toThrow("session is busy");
  expect(f.cancel).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
  (await f.admit()).release();
});

it("keeps admissions closed while serialized teardown is queued, then revalidates the incarnation", async () => {
  const f = fixture("queued-teardown");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const teardown = vi.fn();
  const stop = f.prepare({
    run: async (authorize) => {
      entered.resolve();
      await release.promise;
      authorize?.();
      teardown();
      return await f.run();
    },
  });
  const rejected = expect(stop).rejects.toThrow("Session");
  await entered.promise;
  await expect(f.admit()).rejects.toThrow();
  f.entry.lifecycleRevision = "new-incarnation";
  release.resolve();
  await rejected;
  expect(teardown).not.toHaveBeenCalled();
});
