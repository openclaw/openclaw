import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { readWorktreeCleanupState } from "./registry-read.js";
import {
  admitWorktreeRunLeaseRow,
  hasLiveWorktreeRunLeaseRow,
  insertRegistryWorktree,
} from "./registry.js";
import { readWorktreeRunLeaseStateInDatabase, worktreeRunLeaseScope } from "./run-lease-owner.js";
import { reapWorktreeRunLeases } from "./run-lease-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await stateDatabase.closeOpenClawStateDatabaseAsync();
    stateDatabase.closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

it("reads live, dead, reused, and unverifiable owners without reaping or writer admission", async () => {
  const root = tempDirs.make("openclaw-lease-read-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const cases = [
    { id: "live", pid: process.pid, startTime: null, live: true },
    { id: "dead", pid: 2147483647, startTime: null, live: false },
    { id: "reused", pid: process.pid, startTime: 1, live: false },
    { id: "foreign", pid: 12345, startTime: 1, live: true },
  ];
  for (const entry of cases) {
    insertRegistryWorktree(env, {
      id: entry.id,
      name: entry.id,
      repoFingerprint: "0123456789abcdef",
      repoRoot: root,
      path: path.join(root, entry.id),
      branch: entry.id,
      baseRef: "HEAD",
      ownerKind: "session",
      createdAt: 1,
      lastActiveAt: 1,
    });
    admitWorktreeRunLeaseRow(env, { ...entry, worktreeId: entry.id, token: entry.id, now: 1 });
  }
  const { db } = stateDatabase.openOpenClawStateDatabase({ env });
  const writes = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");
  db.exec("PRAGMA query_only = ON");
  try {
    for (const entry of cases) {
      expect(
        hasLiveWorktreeRunLeaseRow(env, entry.id, {
          isPidDefinitelyDead: (pid) => pid === 2147483647,
          getProcessStartTime: (pid) => (pid === process.pid ? 2 : null),
        }),
        entry.id,
      ).toBe(entry.live);
    }
    expect(writes).not.toHaveBeenCalled();
    const queries = trackSqliteStatementExecutions(db, ["leases"], (sql) =>
      sql.startsWith("select") && sql.includes('"state_leases"') ? "leases" : null,
    );
    try {
      const state = readWorktreeRunLeaseStateInDatabase(db);
      expect(state.liveScopes).toContain(worktreeRunLeaseScope("live"));
      expect(state.staleScopes).toContain(worktreeRunLeaseScope("dead"));
      expect(queries.counts.leases).toBe(1);
    } finally {
      queries.restore();
    }
    expect(db.prepare("SELECT count(*) AS count FROM state_leases").get()?.count).toBe(4);
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }

  const { leases } = await readWorktreeCleanupState(env);
  // A renewed owner after discovery must survive the batched reap.
  db.prepare("UPDATE state_leases SET payload_json = ? WHERE scope = ?").run(
    JSON.stringify({ pid: process.pid }),
    worktreeRunLeaseScope("dead"),
  );
  await reapWorktreeRunLeases(env, leases.staleScopes);
  expect(hasLiveWorktreeRunLeaseRow(env, "dead")).toBe(true);
  expect(hasLiveWorktreeRunLeaseRow(env, "live")).toBe(true);
  expect(
    db
      .prepare("SELECT lease_key FROM state_leases WHERE scope = ?")
      .all(worktreeRunLeaseScope("reused")),
  ).toEqual([]);
});
