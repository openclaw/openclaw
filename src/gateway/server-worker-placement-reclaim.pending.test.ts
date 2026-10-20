import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  beginSessionEffect,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());
afterEach(clearRuntimeConfigSnapshot);

it.each(["active", "failed"] as const)(
  "a %s reclaim whose canonical cancellation rejects preserves its mutation-owned effect",
  async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = path.join(tempDirs.make(`cancel-failure-${state}-`), "sessions.sqlite");
    const sessionKey = "agent:main:cancel-failure";
    const sessionId = "cancel-failure-session";
    const entry = {
      sessionId,
      updatedAt: 1,
      worktree: {
        id: "cancel-failure-worktree",
        branch: "cancel-failure",
        repoRoot: "/fixture/workspace",
      },
    };
    await replaceSessionEntry({ agentId: "main", sessionKey, storePath: scope }, entry);
    const cancellationFailure = new Error("canonical terminal drain rejected");
    const cancel = vi.fn(async () => {
      throw cancellationFailure;
    });
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements: {
        get: () => ({ state, sessionId }) as never,
        getAsync: async () => ({ state, sessionId }) as never,
        waitForTurnClaimRelease: vi.fn(),
      },
      loadSessionRuntime: async () => ({
        managedWorktrees: {
          findLiveByOwner: async () => ({
            id: "cancel-failure-worktree",
            ownerId: sessionKey,
            path: "/fixture/workspace",
          }),
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
    const acquired = await beginSessionEffect({
      scope,
      identities: [sessionKey, sessionId],
      agentId: "main",
      assertAllowed: () => {},
      onInterrupt: acquiredInterrupted,
    });
    const begin = vi.fn();
    const reclaim = vi.fn();
    let pending!: Promise<{ admitted: boolean; error?: unknown }>;
    try {
      await runSessionMutation({
        scope,
        identities: [sessionKey, sessionId],
        agentId: "main",
        run: async () => {
          pending = beginSessionEffect({
            scope,
            identities: [sessionKey, sessionId],
            agentId: "main",
            assertAllowed: validated,
            onInterrupt: interrupted,
          }).then(
            (lease) => {
              expect(lease.isActive()).toBe(true);
              lease.release();
              return { admitted: true };
            },
            (error: unknown) => ({ admitted: false, error }),
          );
          const request = { sessionId, sessionKey, agentId: "main", begin, reclaim };
          const stop =
            state === "failed"
              ? barriers.runFailedReclaimBarrier(request)
              : barriers.runReclaimBarrier(request);
          await expect(stop).rejects.toBe(cancellationFailure);
        },
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(begin).not.toHaveBeenCalled();
      expect(reclaim).not.toHaveBeenCalled();
      // Failed Stop never begins teardown; work admitted by the surrounding mutation
      // remains subordinate to that mutation instead of becoming a competing owner.
      expect(acquiredInterrupted).not.toHaveBeenCalled();
      expect(acquired.isActive()).toBe(true);
      expect(await pending).toEqual({ admitted: true });
      expect(interrupted).not.toHaveBeenCalled();
      expect(validated).toHaveBeenCalledOnce();
      const fresh = await beginSessionEffect({
        scope,
        identities: [sessionKey, sessionId],
        agentId: "main",
        assertAllowed: () => {},
      });
      fresh.release();
    } finally {
      acquired.release();
      await pending;
    }
  },
);
