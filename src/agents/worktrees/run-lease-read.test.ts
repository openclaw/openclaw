import path from "node:path";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as pidAlive from "../../shared/pid-alive.js";
import * as state from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { readWorktreeCleanupState } from "./registry-read.js";
import { insertRegistryWorktree } from "./registry.js";
import {
  readWorktreeRunLeaseStateInDatabase,
  worktreeRunLeaseScope as scope,
} from "./run-lease-owner.js";
import { reapWorktreeRunLeases } from "./run-lease-store.js";
import { admitWorktreeRunLeaseInDatabase } from "./run-lease-store.kernel.js";
import { hasLiveWorktreeRunLease as hasLiveLease } from "./run-lease.test-support.js";
import { makeWorktreeRecord } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

const tempDirs = useWorktreeStateRoots();

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
    const record = makeWorktreeRecord(root, entry.id, { path: path.join(root, entry.id) });
    await insertRegistryWorktree(env, record);
  }
  state.runOpenClawStateWriteTransaction(
    ({ db }) => {
      for (const entry of cases) {
        admitWorktreeRunLeaseInDatabase(db, {
          ...entry,
          worktreeId: entry.id,
          token: entry.id,
          now: 1,
        });
      }
    },
    { env },
  );
  const db = requireNativeSqliteDatabase(state.openOpenClawStateDatabase({ env }).db);
  const query = (sql: string) => db.prepare(sql);
  const writes = vi.spyOn(state, "runOpenClawStateWriteTransaction");
  vi.spyOn(pidAlive, "isPidDefinitelyDead").mockImplementation((pid) => pid === 2147483647);
  vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation((pid) =>
    pid === process.pid ? 2 : null,
  );
  db.exec("PRAGMA query_only = ON");
  try {
    for (const entry of cases) {
      expect(hasLiveLease(env, entry.id), entry.id).toBe(entry.live);
    }
    expect(writes).not.toHaveBeenCalled();
    const queries = trackSqliteStatementExecutions(db, ["leases"], (sql) =>
      sql.startsWith("select") && sql.includes('"state_leases"') ? "leases" : null,
    );
    try {
      const leases = readWorktreeRunLeaseStateInDatabase(db);
      expect(leases.liveScopes).toContain(scope("live"));
      expect(leases.staleScopes).toContain(scope("dead"));
      expect(queries.counts.leases).toBe(1);
    } finally {
      queries.restore();
    }
    expect(query("SELECT count(*) AS count FROM state_leases").get()?.count).toBe(4);
  } finally {
    db.exec("PRAGMA query_only = OFF");
    vi.restoreAllMocks();
  }

  const { leases } = await readWorktreeCleanupState(env);
  // A renewed owner after discovery must survive the batched reap.
  query("UPDATE state_leases SET payload_json = ? WHERE scope = ?").run(
    JSON.stringify({ pid: process.pid }),
    scope("dead"),
  );
  await reapWorktreeRunLeases(env, leases.staleScopes);
  expect(hasLiveLease(env, "dead")).toBe(true);
  expect(hasLiveLease(env, "live")).toBe(true);
  const reaped = query("SELECT lease_key FROM state_leases WHERE scope = ?").all(scope("reused"));
  expect(reaped).toEqual([]);
});
