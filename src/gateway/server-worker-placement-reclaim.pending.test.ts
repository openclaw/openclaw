import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());
afterEach(clearRuntimeConfigSnapshot);

it.each(["active", "failed"] as const)(
  "a %s reclaim whose canonical cancellation rejects still retires old pending work",
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
    const acquired = await beginSessionWorkAdmission({
      scope,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
      onInterrupt: acquiredInterrupted,
    });
    const begin = vi.fn();
    const reclaim = vi.fn();
    let pending!: Promise<{ admitted: boolean; error?: unknown }>;
    try {
      await runExclusiveSessionLifecycleMutation("placement-reclaim", {
        scope,
        identities: [sessionKey, sessionId],
        run: async () => {
          pending = beginSessionWorkAdmission({
            scope,
            identities: [sessionKey, sessionId],
            assertAllowed: validated,
            onInterrupt: interrupted,
          }).then(
            (lease) => {
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
      // Failed Stop never begins teardown; acquired runs retain canonical abort ordering.
      expect(acquiredInterrupted).not.toHaveBeenCalled();
      expect(await pending).toEqual({ admitted: false, error: expect.any(Error) });
      expect(interrupted).toHaveBeenCalledOnce();
      expect(validated).not.toHaveBeenCalled();
      const fresh = await beginSessionWorkAdmission({
        scope,
        identities: [sessionKey, sessionId],
        assertAllowed: () => {},
      });
      fresh.release();
    } finally {
      acquired.release();
      await pending;
    }
  },
);
