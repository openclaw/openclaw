import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as config from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as lifecycle from "../sessions/session-controller.lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());
afterEach(config.clearRuntimeConfigSnapshot);

it.each([
  ["active", "runReclaimBarrier"],
  ["failed", "runFailedReclaimBarrier"],
] as const)(
  "a %s reclaim whose canonical cancellation rejects preserves its mutation-owned effect",
  async (state, method) => {
    config.setRuntimeConfigSnapshot({});
    const scope = path.join(tempDirs.make(`cancel-failure-${state}-`), "sessions.sqlite");
    const sessionKey = "agent:main:cancel-failure";
    const sessionId = "cancel-failure-session";
    const owner = { scope, identities: [sessionKey, sessionId], agentId: "main" };
    const workspace = {
      id: "cancel-failure-worktree",
      ownerId: sessionKey,
      path: "/fixture/workspace",
    };
    const worktree = { id: workspace.id, branch: "cancel-failure", repoRoot: workspace.path };
    const entry = { sessionId, updatedAt: 1, worktree };
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath: scope }, entry);
    const cancellationFailure = new Error("canonical terminal drain rejected");
    const cancel = vi.fn<() => Promise<never>>().mockRejectedValue(cancellationFailure);
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements: {
        get: () => ({ state, sessionId }) as never,
        getAsync: async () => ({ state, sessionId }) as never,
        waitForTurnClaimRelease: vi.fn(),
      },
      loadSessionRuntime: async () => ({
        managedWorktrees: {
          findLiveByOwner: async () => workspace,
        },
        resolveGatewaySessionStoreTargetInWorker: (params) =>
          resolveGatewaySessionStoreTargetInWorker({
            ...params,
            cfg: { ...params.cfg, session: { ...params.cfg.session, store: scope } },
          }),
        resolveCanonicalSessionEntryFromStoreKeys,
      }),
      cancelSessionWork: cancel,
      revokeSessionAuthority: vi.fn(),
    });
    const interrupted = vi.fn();
    const validated = vi.fn();
    const acquiredInterrupted = vi.fn();
    const effect = (assertAllowed = () => {}, onInterrupt?: () => void) =>
      lifecycle.beginSessionEffect({ ...owner, assertAllowed, onInterrupt });
    const acquired = await effect(undefined, acquiredInterrupted);
    const begin = vi.fn();
    const reclaim = vi.fn();
    let pending!: Promise<{ admitted: boolean; error?: unknown }>;
    try {
      await lifecycle.runSessionMutation({
        ...owner,
        run: async () => {
          pending = effect(validated, interrupted).then(
            (lease) => {
              expect(lease.isActive()).toBe(true);
              lease.release();
              return { admitted: true };
            },
            (error: unknown) => ({ admitted: false, error }),
          );
          const request = { sessionId, sessionKey, agentId: "main", begin, reclaim };
          await expect(barriers[method](request)).rejects.toBe(cancellationFailure);
        },
      });
      expect(cancel).toHaveBeenCalledOnce();
      for (const callback of [begin, reclaim, acquiredInterrupted]) {
        expect(callback).not.toHaveBeenCalled();
      }
      expect(acquired.isActive()).toBe(true);
      expect(await pending).toEqual({ admitted: true });
      expect(interrupted).not.toHaveBeenCalled();
      expect(validated).toHaveBeenCalledOnce();
      const fresh = await effect();
      fresh.release();
    } finally {
      acquired.release();
      await pending;
    }
  },
);
