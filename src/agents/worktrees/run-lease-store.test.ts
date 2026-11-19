import fs from "node:fs";
import { expect, it, onTestFinished, vi } from "vitest";
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
import { makeWorktreeRecord } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

const dirs = useWorktreeStateRoots();

it("settles exact lease deletions without host SQL or fsync and refuses a retired store", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("worktree-release-worker-") };
  const database = openOpenClawStateDatabase({ env });
  await insertRegistryWorktree(env, makeWorktreeRecord(env.OPENCLAW_STATE_DIR, "synthetic"));
  const insert = database.db.prepare(
    "INSERT INTO state_leases (scope, lease_key, owner, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
  );
  runOpenClawStateWriteTransaction(
    () => {
      for (let index = 0; index < 100; index++) {
        insert.run("worktree-run:synthetic", `run-${index}`, "synthetic-owner");
      }
      insert.run("worktree-run:synthetic", "successor", "synthetic-owner");
      insert.run("worktree-run:other", "run-0", "synthetic-owner");
    },
    { database, env },
  );
  const context = captureOpenClawStateWorkerContext({ env });
  const release = (token: string) =>
    releaseWorktreeRunLeaseRowAsync(env, "synthetic", token, context);
  const deleted: string[] = [];
  const unsubscribe = worktreeRegistryPublication.subscribeFacts((change) => {
    if (change.kind !== "committed") {
      return;
    }
    for (const [key, fact] of change.receipt.facts) {
      if (fact.kind === "absent") {
        deleted.push(key);
      }
    }
  });
  onTestFinished(unsubscribe);
  const sql = observeMainThreadSql();
  const sync = vi.spyOn(fs, "fsyncSync");
  for (let index = 0; index < 99; index++) {
    await release(`run-${index}`);
  }
  sql.expectIdle();
  expect(sync).not.toHaveBeenCalled();
  // Exit-only cleanup must publish synchronously, including the exact token tombstone.
  releaseWorktreeRunLeaseRow(env, "synthetic", "run-99");
  expect(deleted).toEqual(
    Array.from({ length: 100 }, (_, index) =>
      JSON.stringify(["state_leases", "worktree-run:synthetic", `run-${index}`]),
    ),
  );
  const remaining = database.db.prepare(
    "SELECT scope, lease_key FROM state_leases ORDER BY scope, lease_key",
  );
  expect(remaining.all()).toEqual([
    { scope: "worktree-run:other", lease_key: "run-0" },
    { scope: "worktree-run:synthetic", lease_key: "successor" },
  ]);
  await closeOpenClawStateDatabaseAsync();
  await expect(release("successor")).rejects.toThrow();
  const settlement = vi.fn();
  const retired = {
    worktreeId: "synthetic",
    token: "retired-admission",
    pid: process.pid,
    startTime: null,
    now: 1,
  };
  await expect(admitWorktreeRunLeaseRowAsync(context, retired, settlement)).rejects.toThrow();
  expect(settlement).toHaveBeenCalledExactlyOnceWith("not-entered");
  const reopened = openOpenClawStateDatabase({ env }).db;
  expect(reopened.prepare("SELECT COUNT(*) AS count FROM state_leases").get()?.count).toBe(2);
});
