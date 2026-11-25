import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withWorktreeAllocationLease, withWorktreeMutationLease } from "./allocation.js";
import {
  readPendingWorktrees,
  readWorktreeSlotCount,
  recoverPendingWorktrees,
  releasePendingWorktree,
  reservePendingWorktree,
} from "./pending-slots.js";
import { readRegistryWorktrees } from "./registry-read.js";
import { insertRegistryWorktree } from "./registry.js";
import type { ManagedWorktreeRecord } from "./types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeStateDatabaseForTest);

it("retains pending custody on refused publication and publishes atomically in the worker", async () => {
  const root = dirs.make("worktree-pending-worker-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const record: ManagedWorktreeRecord = {
    id: "synthetic-pending",
    name: "pending",
    repoRoot: root,
    repoFingerprint: "0123456789abcdef",
    path: path.join(root, "pending"),
    branch: "worktree/pending",
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: "agent:main:pending",
    createdAt: 1,
    lastActiveAt: 1,
  };
  await withWorktreeAllocationLease({ env, id: record.id }, async (guard) => {
    const sql = observeMainThreadSql();
    try {
      await expect(reservePendingWorktree(env, record, {})).rejects.toThrow(
        "retained checkout lease",
      );
      await reservePendingWorktree(env, record, guard.workerAuthority);
      expect(await readWorktreeSlotCount(env)).toBe(1);
      await recoverPendingWorktrees(env, guard.workerAuthority);
      expect(await readRegistryWorktrees(env)).toEqual([]);
      expect(await readPendingWorktrees(env)).toEqual([{ record, state: "pending" }]);
      await expect(
        insertRegistryWorktree(
          env,
          { ...record, path: path.join(root, "changed") },
          {
            pendingId: record.id,
            workerAuthority: guard.workerAuthority,
          },
        ),
      ).rejects.toThrow("identity changed before publication");
      expect(await readPendingWorktrees(env)).toEqual([{ record, state: "pending" }]);
      expect(await readRegistryWorktrees(env)).toEqual([]);
      await expect(releasePendingWorktree(env, record.id, {})).rejects.toThrow(
        "retained checkout lease",
      );
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
  await withWorktreeMutationLease({ env, id: record.id }, async (guard) => {
    await expect(reservePendingWorktree(env, record, guard.workerAuthority)).rejects.toThrow(
      "allocation lease",
    );
    await insertRegistryWorktree(env, record, {
      pendingId: record.id,
      workerAuthority: guard.workerAuthority,
    });
  });
  expect(await readPendingWorktrees(env)).toEqual([]);
  expect(await readWorktreeSlotCount(env)).toBe(1);
  expect(await readRegistryWorktrees(env)).toEqual([record]);
});
