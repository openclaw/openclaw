import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { acquireOpenClawStateLeaseInTransaction } from "../../state/openclaw-state-lease-store.js";
import {
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
  WORKTREE_MUTATION_LEASE_SCOPE,
} from "./capacity-contract.js";
import { reserveWorktreeCapacityInWorker } from "./capacity.worker.js";
import { ManagedWorktreeService } from "./service.js";
import { initializeManagedWorktreeTestRepository } from "./service.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL worktree capacity reservation", () => {
  const state = useMixedAgentPair("postgres", "postgres");

  it("creates and registers a real Git checkout through PostgreSQL-backed allocation", async () => {
    const repo = await initializeManagedWorktreeTestRepository(path.join(state.root, "checkout"));
    const service = new ManagedWorktreeService({
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const created = await service.create({
      repoRoot: repo,
      name: "postgres-proof",
      baseRef: "HEAD",
    });
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
    expect(await service.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id, path: created.path })]),
    );
    // The suite retires database workers before deleting its isolated state and Git roots.
  });

  it("admits and renews only the current owner capacity reservation", () =>
    withEngineStoreAdmission(() => {
      const options = { env: process.env };
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
      // Transport fixture only: SQL generation and database ownership checks stay real.
      const admission = vi
        .spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission")
        .mockImplementation(() => {});
      try {
        const reserve = () =>
          reserveWorktreeCapacityInWorker(input, {
            open: () => database,
            stateOptions: () => ({ ...options, path: database.path }),
          });
        expect(reserve()).toEqual({ admitted: true });
        expect(reserve()).toEqual({ admitted: true });
        database.db
          .prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?")
          .run("replacement-owner", WORKTREE_CAPACITY_RESERVATION_SCOPE, input.key);
        expect(reserve).toThrow("Managed worktree capacity reservation changed");
      } finally {
        admission.mockRestore();
      }
    }));
});
