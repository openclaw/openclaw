import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withExistingOpenClawStateSchema as withSchema } from "../../state/openclaw-state-db-schema-policy.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as leaseWorker from "../../state/openclaw-state-lease-worker-operation.js";
import * as stateLeases from "../../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withWorktreeAllocationLease, withWorktreeMutationLease } from "./allocation.js";
import { WORKTREE_CREATE_LEASE_SCOPE, WORKTREE_MUTATION_LEASE_SCOPE } from "./capacity-contract.js";
import {
  createWorktreeDiskAdmission,
  WorktreeCapacityContentionError,
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
} from "./capacity.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

const roots = useWorktreeStateRoots();
const lost = { code: "OPENCLAW_STATE_LEASE_LOST" };
type DiskAdmission = Pick<ReturnType<typeof createWorktreeDiskAdmission>, "requireDiskSpace">;
const reserve = (capacity: DiskAdmission, root: string, bytes = 1, retained = true) =>
  capacity.requireDiskSpace([{ path: root, bytes }], "fixture", retained);

function atWorkerCommit(beforeCommit: () => void, preserveAuthority = true) {
  const run = leaseWorker.runWithOpenClawStateLeasesWorker;
  vi.spyOn(leaseWorker, "runWithOpenClawStateLeasesWorker").mockImplementation(
    (leases, context, operation, authority) =>
      run(leases, context, operation, {
        ...(preserveAuthority ? authority : {}),
        assertCurrent: () => authority?.assertCurrent(),
        beforeCommit: () => {
          beforeCommit();
          authority?.beforeCommit?.();
        },
      }),
  );
}

async function expectOffThread(run: () => Promise<void>, checkDisk = false) {
  const sql = observeHostDataSql();
  const disk = checkDisk ? vi.spyOn(fs, "statfsSync") : undefined;
  await run();
  expect(sql.queries).toEqual([]);
  if (disk) {
    expect(disk).not.toHaveBeenCalled();
  }
  disk?.mockRestore();
  sql.restore();
}

function fixture() {
  const root = roots.make("worktree-capacity-worker-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const database = openOpenClawStateDatabase({ env });
  const debts = () =>
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<Pick<DB, "state_leases">>(database.db)
        .selectFrom("state_leases")
        .select("lease_key")
        .where("scope", "=", WORKTREE_CAPACITY_RESERVATION_SCOPE),
    ).rows;
  return { root, env, database, debts };
}

it("releases off-thread disk debt after caller and schema admission end", async () => {
  const f = fixture();
  const caller = new AbortController();
  await withSchema({ path: f.database.path }, () => {
    const leaseContext = captureOpenClawStateWorkerContext({ env: f.env });
    return stateLeases.withOpenClawStateLeaseAsync(
      {
        scope: WORKTREE_MUTATION_LEASE_SCOPE,
        key: "retirement",
        leaseMs: 60_000,
        waitMs: 0,
        heartbeat: "worker",
      },
      leaseContext,
      async (lease) => {
        const ended = await withSchema({ path: f.database.path }, async () => {
          const context = captureOpenClawStateWorkerContext({ env: f.env });
          const capacity = createWorktreeDiskAdmission({
            env: f.env,
            workerAuthority: {
              leaseSet: { context: leaseContext, leases: [lease] },
              assertCurrent: () => caller.signal.throwIfAborted(),
            },
            assertCurrent: () => caller.signal.throwIfAborted(),
          });
          await expectOffThread(() => reserve(capacity, f.root), true);
          return { capacity, context };
        });
        expect(f.debts()).toHaveLength(1);
        caller.abort(new Error("caller cancelled"));
        expect(() => ended.context.admission.assertCurrent()).toThrow("schema admission has ended");
        await expectOffThread(() => ended.capacity.release());
        expect(f.debts()).toEqual([]);
      },
    );
  });
});

it("rolls back disk admission on owner revocation at worker commit", async () => {
  const f = fixture();
  const caller = new AbortController();
  atWorkerCommit(() => caller.abort(new Error("caller revoked at commit")));
  await expect(
    withWorktreeMutationLease({ env: f.env, id: "refused", signal: caller.signal }, (guard) =>
      reserve(guard, f.root),
    ),
  ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
  expect(caller.signal.aborted).toBe(true);
  expect(f.debts()).toEqual([]);
});

it.for(["parent", "child"] as const)(
  "rolls back nested capacity admission when the %s lease expires at commit",
  async (expired) => {
    const f = fixture();
    const expiredScope =
      expired === "parent" ? WORKTREE_CREATE_LEASE_SCOPE : WORKTREE_MUTATION_LEASE_SCOPE;
    const acquire = stateLeases.withOpenClawStateLeaseAsync;
    vi.spyOn(stateLeases, "withOpenClawStateLeaseAsync").mockImplementation(
      (options, context, body) =>
        acquire(
          { ...options, leaseMs: options.scope === expiredScope ? 60_000 : 120_000 },
          context,
          body,
        ),
    );
    let restoreClock: (() => void) | undefined;
    atWorkerCommit(() => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 90_000);
      restoreClock = () => clock.mockRestore();
    }, false);
    await expect(
      withWorktreeAllocationLease({ env: f.env, id: "nested-restore" }, async (guard) => {
        const capacity = createWorktreeDiskAdmission({
          env: f.env,
          workerAuthority: guard.workerAuthority,
          // Exercise the worker commit grant; native filesystem admission is covered separately.
          assertCurrent: () => {},
        });
        try {
          await expect(reserve(capacity, f.root)).rejects.toMatchObject(lost);
          expect(restoreClock).toBeDefined();
          expect(f.debts()).toEqual([]);
        } finally {
          restoreClock?.();
          await capacity.release();
        }
      }),
    ).rejects.toMatchObject(lost);
  },
);

it("preserves typed capacity contention across the worker result boundary", async () => {
  const f = fixture();
  await withWorktreeMutationLease({ env: f.env, id: "removal" }, async (guard) => {
    await reserve(guard, f.root);
    const [held] = f.debts();
    await expect(
      withWorktreeAllocationLease({ env: f.env }, (creation) =>
        reserve(creation, f.root, Number.MAX_SAFE_INTEGER, false),
      ),
    ).rejects.toMatchObject({
      name: WorktreeCapacityContentionError.name,
      reservationKey: held?.lease_key,
    });
    expect(f.debts()).toEqual([held]);
  });
  expect(f.debts()).toEqual([]);
});

it.each([true, false])(
  "reclaims an exited disk reservation only with its recorded namespace (namespace: %s)",
  async (namespace) => {
    const f = fixture();
    await withWorktreeMutationLease({ env: f.env, id: "abandoned" }, async (guard) => {
      await reserve(guard, f.root);
      const [held] = f.debts();
      expect(held).toBeDefined();
      // Keep the production owner's recorded namespace; only its PID has exited.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
              .updateTable("state_leases")
              .set((eb) => {
                const exited = eb.fn<string>("json_set", [
                  eb.ref("payload_json"),
                  eb.val("$.owner.pid"),
                  eb.val(2_147_483_647),
                ]);
                return {
                  payload_json: namespace
                    ? exited
                    : eb.fn<string>("json_remove", [exited, eb.val("$.owner.processNamespace")]),
                };
              })
              .where("scope", "=", WORKTREE_CAPACITY_RESERVATION_SCOPE)
              .where("lease_key", "=", held!.lease_key),
          );
        },
        { env: f.env },
      );
      await withWorktreeAllocationLease({ env: f.env }, async (replacement) => {
        await reserve(replacement, f.root);
        expect(f.debts().some((debt) => debt.lease_key === held!.lease_key)).toBe(!namespace);
      });
    });
    expect(f.debts()).toEqual([]);
  },
);
