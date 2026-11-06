import { expect, it, vi } from "vitest";
import * as queries from "../../infra/kysely-sync.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { acquireOpenClawStateLeaseInTransaction } from "../../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  WORKTREE_MUTATION_LEASE_SCOPE,
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
} from "./capacity-contract.js";
import { reserveWorktreeCapacityInWorker } from "./capacity.worker.js";
it("qualifies the capacity UPSERT owner and refuses a replacement owner", async () => {
  await withOpenClawTestState({ label: "capacity-owner-query" }, async (state) => {
    const options = { env: state.env };
    const database = openOpenClawStateDatabase(options);
    const lease = {
      scope: WORKTREE_MUTATION_LEASE_SCOPE,
      key: "capacity-test",
      owner: "mutation-owner",
    };
    runOpenClawStateWriteTransaction(
      ({ db }) => acquireOpenClawStateLeaseInTransaction(db, lease, 60_000),
      { ...options, database },
    );
    const input = {
      key: "reservation",
      owner: { pid: process.pid, host: "capacity-test", startedAt: null },
      demands: [],
      purpose: "capacity proof",
      snapshot: false,
      leases: [lease],
    };
    const admission = vi
      .spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission")
      .mockImplementation(() => {});
    const runQuery = queries.executeSqliteQuerySync;
    const captured: string[] = [];
    const query = vi.spyOn(queries, "executeSqliteQuerySync").mockImplementation((db, q) => {
      captured.push(q.compile().sql);
      return runQuery(db, q);
    });
    try {
      const reserve = () =>
        reserveWorktreeCapacityInWorker(input, {
          open: () => database,
          stateOptions: () => ({ ...options, path: database.path }),
        });
      expect(reserve()).toEqual({ admitted: true });
      expect(reserve()).toEqual({ admitted: true });
      expect(
        captured.some(
          (sql) => sql.includes("on conflict") && sql.includes('"state_leases"."owner"'),
        ),
      ).toBe(true);
      database.db
        .prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?")
        .run("replacement-owner", WORKTREE_CAPACITY_RESERVATION_SCOPE, input.key);
      expect(reserve).toThrow("Managed worktree capacity reservation changed");
    } finally {
      query.mockRestore();
      admission.mockRestore();
    }
  });
});
