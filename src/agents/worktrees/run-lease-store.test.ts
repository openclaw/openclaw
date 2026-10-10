import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { worktreeRegistryPublication } from "./registry-publication.js";
import { insertRegistryWorktree, releaseWorktreeRunLeaseRow } from "./registry.js";
import {
  admitWorktreeRunLeaseRowAsync,
  releaseWorktreeRunLeaseRowAsync,
} from "./run-lease-store.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

it("settles exact lease deletions without host SQL or fsync and refuses a retired store", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("worktree-release-worker-") };
  const database = openOpenClawStateDatabase({ env });
  await insertRegistryWorktree(env, {
    id: "synthetic",
    name: "synthetic",
    repoFingerprint: "0123456789abcdef",
    repoRoot: env.OPENCLAW_STATE_DIR,
    path: env.OPENCLAW_STATE_DIR,
    branch: "synthetic",
    baseRef: "HEAD",
    ownerKind: "session",
    createdAt: 1,
    lastActiveAt: 1,
  });
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const insert = db.prepare(
        "INSERT INTO state_leases (scope, lease_key, owner, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
      );
      for (let index = 0; index < 100; index++) {
        insert.run("worktree-run:synthetic", `run-${index}`, "synthetic-owner");
      }
      insert.run("worktree-run:synthetic", "successor", "synthetic-owner");
      insert.run("worktree-run:other", "run-0", "synthetic-owner");
    },
    { database, env },
  );
  const context = captureOpenClawStateWorkerContext({ env });
  const deleted: string[] = [];
  const unsubscribe = worktreeRegistryPublication.subscribeFacts((change) => {
    if (change.kind === "committed") {
      for (const [key, fact] of change.receipt.facts) {
        if (fact.kind === "absent") {
          deleted.push(key);
        }
      }
    }
  });
  const sql = observeMainThreadSql();
  const sync = vi.spyOn(fs, "fsyncSync");
  try {
    for (let index = 0; index < 99; index++) {
      await releaseWorktreeRunLeaseRowAsync(env, "synthetic", `run-${index}`, context);
    }
    sql.expectIdle();
    expect(sync).not.toHaveBeenCalled();
  } finally {
    sql.restore();
    sync.mockRestore();
  }
  try {
    // Exit-only cleanup must publish synchronously, including the exact token tombstone.
    releaseWorktreeRunLeaseRow(env, "synthetic", "run-99");
    expect(deleted).toEqual(
      Array.from({ length: 100 }, (_, index) =>
        JSON.stringify(["state_leases", "worktree-run:synthetic", `run-${index}`]),
      ),
    );
  } finally {
    unsubscribe();
  }
  expect(
    database.db
      .prepare("SELECT scope, lease_key FROM state_leases ORDER BY scope, lease_key")
      .all(),
  ).toEqual([
    { scope: "worktree-run:other", lease_key: "run-0" },
    { scope: "worktree-run:synthetic", lease_key: "successor" },
  ]);
  await closeOpenClawStateDatabaseAsync();
  await expect(
    releaseWorktreeRunLeaseRowAsync(env, "synthetic", "successor", context),
  ).rejects.toThrow();
  const settlement = vi.fn();
  await expect(
    admitWorktreeRunLeaseRowAsync(
      context,
      {
        worktreeId: "synthetic",
        token: "retired-admission",
        pid: process.pid,
        startTime: null,
        now: 1,
      },
      settlement,
    ),
  ).rejects.toThrow();
  expect(settlement).toHaveBeenCalledExactlyOnceWith("not-entered");
  expect(
    openOpenClawStateDatabase({ env })
      .db.prepare("SELECT COUNT(*) AS count FROM state_leases")
      .get(),
  ).toMatchObject({ count: 2 });
});
