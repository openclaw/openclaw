// Archive responses finish before maintenance starts inspecting or removing worktrees.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";

const { createArchiveWorktreeFixture } = setupGatewaySessionsWorktreeTestHarness();

test.for(["sessions.patch", "sessions.patchMany"] as const)(
  "%s commits archive and releases same-session writes before responding and waking cleanup",
  async (method, { signal }) => {
    const { key, sessionId, storePath, worktree, tickWorktreeMaintenance } =
      await createArchiveWorktreeFixture();
    const revision = loadSessionEntry({ storePath, sessionKey: key })?.lifecycleRevision;
    await fs.writeFile(path.join(worktree.path, "draft.txt"), "preserved work\n");
    const effectsEntered = createDeferredCore();
    const releaseEffects = createDeferredCore();
    const cleanupEntered = createDeferredCore();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const originalGc = managedWorktrees.gc.bind(managedWorktrees);
    const gc = vi.spyOn(managedWorktrees, "gc").mockImplementation((params) => {
      cleanupEntered.resolve();
      return originalGc(params);
    });
    const originalRemove = managedWorktrees.remove.bind(managedWorktrees);
    const remove = vi.spyOn(managedWorktrees, "remove").mockImplementation(async (params) => {
      entered.resolve();
      await release.promise;
      return await originalRemove(params);
    });
    const archived = directSessionReq(
      method,
      method === "sessions.patch"
        ? { key, expectedSessionId: sessionId, archived: true }
        : { targets: [{ key, expectedSessionId: sessionId }], patch: { archived: true } },
      {
        context: {
          cron: {
            list: async () => {
              effectsEntered.resolve();
              await releaseEffects.promise;
              return [];
            },
            getDefaultAgentId: () => "main",
          },
        },
      },
    );
    let beforeResponseTick: Promise<void> | undefined;
    let cleanup: Promise<void> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          awaitGateBeforeSettlement(
            effectsEntered.promise,
            archived,
            "archive did not reach its committed effects",
          ),
          entered.promise,
          "archive awaited worktree removal before responding",
        ),
        signal,
      );
      expect(loadSessionEntry({ storePath, sessionKey: key })).toMatchObject({
        archivedAt: expect.any(Number),
        worktree: { id: worktree.id },
      });
      expect(loadSessionEntry({ storePath, sessionKey: key })?.lifecycleRevision).toBe(revision);
      expect(
        await withinTest(
          directSessionReq("sessions.patch", { key, label: "Same session" }),
          signal,
        ),
      ).toMatchObject({ ok: true });
      expect(loadSessionEntry({ storePath, sessionKey: key })?.label).toBe("Same session");
      await fs.access(worktree.path);

      beforeResponseTick = tickWorktreeMaintenance();
      await withinTest(
        awaitGateBeforeSettlement(
          beforeResponseTick,
          cleanupEntered.promise,
          "worktree cleanup started before the archive response",
        ),
        signal,
      );
      expect(gc).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();

      releaseEffects.resolve();
      expect(await withinTest(archived, signal)).toMatchObject(
        method === "sessions.patch"
          ? { ok: true }
          : { ok: true, payload: { outcomes: [{ ok: true }] } },
      );
      cleanup = tickWorktreeMaintenance();
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          cleanup,
          "cleanup did not remove the retired worktree",
        ),
        signal,
      );
      release.resolve();
      await cleanup;
      expect(getRegistryWorktree(process.env, worktree.id)).toMatchObject({
        removedAt: expect.any(Number),
        snapshotRef: expect.any(String),
      });
      await expect(fs.access(worktree.path)).rejects.toThrow();
    } finally {
      releaseEffects.resolve();
      release.resolve();
      await Promise.allSettled([archived, beforeResponseTick, cleanup]);
      gc.mockRestore();
      remove.mockRestore();
    }
  },
);
