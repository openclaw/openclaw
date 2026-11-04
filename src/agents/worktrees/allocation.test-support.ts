import { expect, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import * as heartbeatOwner from "../../state/openclaw-state-lease-heartbeat.js";
import { releaseOpenClawStateLeaseInTransaction } from "../../state/openclaw-state-lease-store.js";
import { WORKTREE_MUTATION_LEASE_SCOPE } from "./capacity-contract.js";

/** Checkout custody outlives allocation; revoke the exact retained checkout owner. */
export function captureWorktreeMutationHeartbeat(): (worktreeId: string) => Promise<void> {
  const start = heartbeatOwner.startOpenClawStateLeaseHeartbeat;
  const heartbeats = new Map<
    string,
    {
      params: Parameters<typeof start>[0];
      heartbeat: ReturnType<typeof start>;
      lost: Promise<void>;
    }
  >();
  vi.spyOn(heartbeatOwner, "startOpenClawStateLeaseHeartbeat").mockImplementation((params) => {
    const lost = createDeferredCore();
    const heartbeat = start({
      ...params,
      onLost(error) {
        params.onLost(error);
        lost.resolve();
      },
    });
    if (params.identity.scope === WORKTREE_MUTATION_LEASE_SCOPE) {
      heartbeats.set(params.identity.key, { params, heartbeat, lost: lost.promise });
    }
    return heartbeat;
  });
  return async (worktreeId) => {
    const retained = heartbeats.get(worktreeId);
    if (!retained) {
      throw new Error(`Worktree mutation heartbeat is not live: ${worktreeId}`);
    }
    runOpenClawStateWriteTransaction(
      ({ db }) => releaseOpenClawStateLeaseInTransaction(db, retained.params.identity),
      { path: retained.params.path },
    );
    await expect(retained.heartbeat.verify()).rejects.toMatchObject({
      code: "OPENCLAW_STATE_LEASE_LOST",
    });
    await retained.lost;
  };
}
