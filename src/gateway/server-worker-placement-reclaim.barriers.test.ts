import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import { sessionIdentity } from "./worker-environments/placement-suite.test-support.js";

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => ({}),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());

async function fixture(name: string) {
  const request = sessionIdentity(name);
  const storePath = path.join(tempDirs.make(`reclaim-preparation-${name}-`), "sessions.sqlite");
  const entry = { sessionId: request.sessionId, lifecycleRevision: "original", updatedAt: 1 };
  await replaceSessionEntry({ ...request, storePath }, entry);
  const placement = {
    ...request,
    state: "active" as const,
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
      resolveGatewaySessionStoreTargetInWorker: (params) =>
        resolveGatewaySessionStoreTargetInWorker({
          ...params,
          cfg: { ...params.cfg, session: { ...params.cfg.session, store: storePath } },
        }),
      resolveCanonicalSessionEntryFromStoreKeys,
    }),
    cancelSessionWork: cancel,
    revokeSessionAuthority: vi.fn(),
  });
  const run = vi.fn(async () => ({ ...placement, state: "reclaimed" as const }) as never);
  return {
    placement,
    cancel,
    run,
    admit: (onInterrupt?: () => void) =>
      beginSessionWorkAdmission({
        scope: storePath,
        identities: [request.sessionKey, request.sessionId],
        assertAllowed: () => {},
        onInterrupt,
      }),
    replaceEntry: (lifecycleRevision: string) => {
      entry.lifecycleRevision = lifecycleRevision;
      return replaceSessionEntry({ ...request, storePath }, entry);
    },
    prepare: (options: Partial<Parameters<typeof barriers.runReclaimPreparation>[0]> = {}) =>
      barriers.runReclaimPreparation({ ...request, run, ...options }),
  };
}

it("one failed Stop cannot reopen ingress while another Stop still owns its closure", async () => {
  const f = await fixture("overlap");
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

it.each(["authorization", "incarnation", "worker"] as const)(
  "rejects changed %s after cancellation and reopens admission on failure",
  async (change) => {
    const f = await fixture(`changed-${change}`);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let authorized = true;
    const interrupted = vi.fn();
    const signalled = vi.fn();
    const acquired = await f.admit(() => {
      interrupted();
      acquired.release();
    });
    f.cancel.mockImplementation(async ({ assertCurrent }) => {
      if (change !== "worker") {
        assertCurrent();
      }
      entered.resolve();
      await release.promise;
      if (change === "worker") {
        assertCurrent();
        signalled();
      }
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
        change === "authorization"
          ? "access revoked"
          : change === "worker"
            ? "worker changed before cancellation"
            : "Session",
      );
      await entered.promise;
      if (change === "authorization") {
        authorized = false;
      } else if (change === "worker") {
        // Replacement must not mutate the captured owner snapshot.
        f.placement.generation++;
      } else {
        await f.replaceEntry("replacement-with-same-session-id");
      }
      release.resolve();
      await rejected;
      expect(interrupted).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
      expect(signalled).not.toHaveBeenCalled();
      (await f.admit()).release();
    } finally {
      release.resolve();
      acquired.release();
    }
  },
);

it("auto-suspend eligibility rejects before closing admission or signalling cancellation", async () => {
  const f = await fixture("auto-suspend");
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
  const f = await fixture("queued-teardown");
  const sql = observeHostDataSql();
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
  try {
    await entered.promise;
    await expect(f.admit()).rejects.toThrow();
    await f.replaceEntry("new-incarnation");
    release.resolve();
    await rejected;
    expect(teardown).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    sql.restore();
  }
  expect(sql.queries).toEqual([]);
});
