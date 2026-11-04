import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { sqliteWorkerPreloadEnv } from "../../infra/sqlite-worker-preload.test-support.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as leaseWorker from "../../state/openclaw-state-lease-worker-operation.js";
import { getOpenClawStateWorkerOwner } from "../../state/openclaw-state-worker-owner.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withWorktreeMutationLease } from "./allocation.js";
import { WORKTREE_CAPACITY_RESERVATION_SCOPE } from "./capacity-contract.js";
import * as capacityStore from "./capacity-store.js";
import { readPendingWorktrees } from "./pending-slots.js";
import { listRegistryWorktrees } from "./registry.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";

const GiB = 1024 ** 3;
const roots = useWorktreeStateRoots();
const initialize = useManagedWorktreeTestRepository();

async function withCapacityFixture(
  run: (f: {
    root: string;
    env: NodeJS.ProcessEnv;
    setAvailable: (bytes: number) => void;
    threads: () => number[];
    setVolumes: (volumes: { path: string; device: number; available: number }[]) => void;
    debts: () => { lease_key: string; payload_json: string | null }[];
  }) => Promise<void>,
) {
  const root = roots.make("capacity-settlement-worker-");
  const capacity = path.join(root, "capacity.json");
  const trace = path.join(root, "threads.jsonl");
  const preload = path.join(root, "capacity.cjs");
  let volumes: { path: string; device: number; available: number }[] = [];
  let available = 100 * GiB;
  const save = () => fs.writeFileSync(capacity, JSON.stringify({ available, volumes }));
  const setAvailable = (bytes: number) => {
    available = bytes;
    save();
  };
  const setVolumes = (next: typeof volumes) => {
    volumes = next;
    save();
  };
  setAvailable(100 * GiB);
  // Inject only disk observations; SQLite, ownership, commits, transport and native Git remain real.
  fs.writeFileSync(
    preload,
    "const fs = require('node:fs'); const {threadId} = require('node:worker_threads');" +
      "const original = fs.statfsSync; fs.statfsSync = function(...args) {" +
      "const value = Reflect.apply(original, this, args);" +
      "if (threadId === 0) return value;" +
      "fs.appendFileSync(" +
      JSON.stringify(trace) +
      ", JSON.stringify(threadId) + '\\n');" +
      "const config = JSON.parse(fs.readFileSync(" +
      JSON.stringify(capacity) +
      ", 'utf8'));" +
      "const match = config.volumes.find(v=>String(args[0]).startsWith(v.path));" +
      "const bytes = match ? match.available : config.available;" +
      "return {...value, bsize:4096, bavail:bytes/4096, bfree:bytes/4096}; };" +
      "const stat = fs.statSync; fs.statSync = function(...args) {" +
      "const value = Reflect.apply(stat, this, args); if(threadId===0) return value;" +
      "const config = JSON.parse(fs.readFileSync(" +
      JSON.stringify(capacity) +
      ", 'utf8'));" +
      "const match = config.volumes.find(v=>String(args[0]).startsWith(v.path));" +
      "if(match) Object.defineProperty(value, 'dev', {value:match.device}); return value; };" +
      "require('node:module').syncBuiltinESMExports();",
  );
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  openOpenClawStateDatabase({ env });
  const debts = () => {
    const database = openOpenClawStateDatabase({ env });
    return executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<Pick<DB, "state_leases">>(database.db)
        .selectFrom("state_leases")
        .select(["lease_key", "payload_json"])
        .where("scope", "=", WORKTREE_CAPACITY_RESERVATION_SCOPE),
    ).rows;
  };
  await drainGlobalSingletonLifecycleState();
  try {
    await withEnvAsync(sqliteWorkerPreloadEnv(preload), () =>
      run({
        root,
        env,
        setAvailable,
        setVolumes,
        debts,
        threads: () => fs.readFileSync(trace, "utf8").trim().split("\n").map(Number),
      }),
    );
    expect(
      fs
        .readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map(Number)
        .every((id) => id > 0),
    ).toBe(true);
  } finally {
    await drainGlobalSingletonLifecycleState();
  }
}

it("publishes a completed peer before the refused completed creator releases custody", async ({
  signal,
}) => {
  await withCapacityFixture(async (f) => {
    const repo = await initialize(f.root);
    const service = new ManagedWorktreeService({
      env: f.env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const ready = createDeferred();
    const first = createDeferred();
    const second = createDeferred();
    const refusing = createDeferred();
    const cleanup = createDeferred();
    const secondResult = createDeferred<boolean>();
    const abort = [new AbortController(), new AbortController()];
    const keys: string[] = [];
    let pendingPaths: string[] = [];
    const remaining = new Set<string>();
    const reserve = capacityStore.reserveWorktreeCapacity;
    vi.spyOn(capacityStore, "reserveWorktreeCapacity").mockImplementation(async (params) => {
      const key = params.request.key;
      const bytes = params.request.demands.reduce((sum, demand) => sum + demand.bytes, 0);
      if (bytes > 0) {
        remaining.add(key);
      }
      if (bytes === 0 && remaining.delete(key)) {
        const position = keys.push(key) - 1;
        if (keys.length === 2) {
          ready.resolve();
        }
        await [first, second][position]!.promise;
        const result = await reserve(params);
        if (position === 1) {
          secondResult.resolve(result.admitted);
        }
        return result;
      }
      return await reserve(params);
    });
    const operations = abort.map((caller, index) =>
      service.create({
        repoRoot: repo,
        name: "completed-" + index,
        baseRef: "HEAD",
        signal: caller.signal,
        withRollback: async (run) => {
          refusing.resolve();
          await cleanup.promise;
          return await run(() => {});
        },
      }),
    );
    for (const operation of operations) {
      void operation.catch(() => {});
    }
    try {
      await withinTest(ready.promise, signal);
      expect(f.debts()).toHaveLength(2);
      pendingPaths = (await readPendingWorktrees(f.env)).map((slot) => slot.record.path);
      expect(pendingPaths).toHaveLength(2);
      for (const p of pendingPaths) {
        expect(fs.readFileSync(path.join(p, "README.md"), "utf8")).toBe("base\n");
      }
      f.setAvailable(4 * GiB);
      first.resolve();
      await withinTest(refusing.promise, signal);
      second.resolve();
      expect(await withinTest(secondResult.promise, signal)).toBe(true);
      const records = await withinTest(Promise.race(operations), signal);
      expect(fs.readFileSync(path.join(records.path, "README.md"), "utf8")).toBe("base\n");
      expect(listRegistryWorktrees(f.env).map((row) => row.id)).toEqual([records.id]);
      expect(f.debts()).toHaveLength(1);
      expect(
        JSON.parse(f.debts()[0]!.payload_json!).worktreeCapacity.every(
          (r: { bytes: number }) => r.bytes === 0,
        ),
      ).toBe(true);
    } finally {
      abort.forEach((caller) => caller.abort(new Error("test cleanup")));
      f.setAvailable(100 * GiB);
      first.resolve();
      second.resolve();
      cleanup.resolve();
      await Promise.allSettled(operations);
    }
    expect(f.debts()).toEqual([]);
    expect(await readPendingWorktrees(f.env)).toEqual([]);
    expect(listRegistryWorktrees(f.env)).toHaveLength(1);
    expect(pendingPaths.filter((p) => fs.existsSync(p))).toEqual(
      listRegistryWorktrees(f.env).map((record) => record.path),
    );
  });
});

it("shrinks only replacement debt on refused multi-device demand and rolls it back on revocation", async () => {
  await withCapacityFixture(async (f) => {
    const paths = ["a", "b", "c"].map((name) => path.join(f.root, name));
    paths.forEach((p) => fs.mkdirSync(p));
    const set = (available: number) =>
      f.setVolumes(paths.map((p, i) => ({ path: p, device: 91 + i, available })));
    set(100 * GiB);
    await withWorktreeMutationLease({ env: f.env, id: "replacement" }, async (guard) => {
      const demand = (bytes: number[]) =>
        guard.requireDiskSpace(
          bytes.map((n, i) => ({ path: paths[i]!, bytes: n })),
          "replacement",
          false,
        );
      await demand([8, 9].map((n) => n * 1024));
      const original = f.debts()[0]!;
      const oldThreads = new Set(f.threads());
      await getOpenClawStateWorkerOwner().close();
      expect(f.debts()).toEqual([original]);
      await demand([8, 9].map((n) => n * 1024));
      expect(f.threads().some((id) => !oldThreads.has(id))).toBe(true);
      const reservations = () => JSON.parse(f.debts()[0]!.payload_json!).worktreeCapacity;
      set(4 * GiB);
      await expect(demand([4 * 1024, 12 * 1024, 1024])).rejects.toThrow("Insufficient disk space");
      expect(reservations()).toEqual([
        { device: "91", bytes: 4 * 1024, reserve: 4 * GiB },
        { device: "92", bytes: 9 * 1024, reserve: 4 * GiB },
      ]);
      // The growth on B and new C were refused, while A's completed portion settled.
      await expect(demand([1024])).rejects.toThrow("Insufficient disk space");
      expect(reservations()).toEqual([
        { device: "91", bytes: 1024, reserve: 4 * GiB },
        { device: "92", bytes: 0, reserve: 4 * GiB },
      ]);
      const beforeRevocation = f.debts();
      set(4 * GiB - 4096);
      const run = leaseWorker.runWithOpenClawStateLeasesWorker;
      const revoked = new Error("live authority revoked at commit");
      const spy = vi
        .spyOn(leaseWorker, "runWithOpenClawStateLeasesWorker")
        .mockImplementation((leases, context, operation, authority) =>
          run(leases, context, operation, {
            ...authority,
            assertCurrent: () => authority?.assertCurrent(),
            beforeCommit: () => {
              throw revoked;
            },
          }),
        );
      try {
        await expect(demand([0])).rejects.toThrow(revoked.message);
      } finally {
        spy.mockRestore();
      }
      expect(f.debts()).toEqual(beforeRevocation);
      set(4 * GiB);
      await expect(demand([0])).resolves.toBeUndefined();
      expect(reservations()).toEqual([{ device: "91", bytes: 0, reserve: 4 * GiB }]);
      expect(f.debts()[0]!.lease_key).toBe(original.lease_key);
      // Snapshot requests cannot erase the floor retained by another live owner.
      await withWorktreeMutationLease({ env: f.env, id: "peer" }, async (peer) => {
        set(128 * 1024 ** 2);
        await expect(
          peer.requireDiskSpace([{ path: paths[0]!, bytes: 0 }], "snapshot", true),
        ).rejects.toThrow("safety reserve");
      });
    });
    expect(f.debts()).toEqual([]);
  });
});

it("retains a lost refusal reply and retries failed exact cleanup through real workers", async () => {
  await withCapacityFixture(async (f) => {
    let cleanup: Parameters<typeof capacityStore.releaseWorktreeCapacity>[0] | undefined;
    const reserve = capacityStore.reserveWorktreeCapacity;
    const unknown = Object.assign(new Error("lost refusal reply"), { code: "outcome-unknown" });
    const lost = vi
      .spyOn(capacityStore, "reserveWorktreeCapacity")
      .mockImplementation(async (params) => {
        const result = await reserve(params);
        if (!result.admitted) {
          throw unknown;
        }
        return result;
      });
    try {
      await expect(
        withWorktreeMutationLease({ env: f.env, id: "unknown" }, async (guard) => {
          await guard.requireDiskSpace([{ path: f.root, bytes: 1024 }], "writes");
          cleanup = {
            context: guard.workerAuthority.leaseSet.context,
            key: f.debts()[0]!.lease_key,
            assertCurrent: () => {},
          };
          f.setAvailable(4 * GiB - 4096);
          await guard.requireDiskSpace([{ path: f.root, bytes: 0 }], "completed");
        }),
      ).rejects.toBe(unknown);
    } finally {
      lost.mockRestore();
    }
    expect(f.debts()).toHaveLength(1);
    expect(JSON.parse(f.debts()[0]!.payload_json!).worktreeCapacity[0]).toMatchObject({
      bytes: 0,
      reserve: 4 * GiB,
    });
    await getOpenClawStateWorkerOwner().close();
    await expect(
      withWorktreeMutationLease({ env: f.env, id: "blocked" }, (guard) =>
        guard.requireDiskSpace([{ path: f.root, bytes: 0 }], "snapshot", true),
      ),
    ).rejects.toThrow("safety reserve");
    if (!cleanup) {
      throw new Error("missing exact cleanup custody");
    }
    await capacityStore.releaseWorktreeCapacity(cleanup);
    expect(f.debts()).toEqual([]);
    f.setAvailable(100 * GiB);
    const fail = vi
      .spyOn(capacityStore, "releaseWorktreeCapacity")
      .mockRejectedValueOnce(new Error("release unavailable"));
    try {
      await expect(
        withWorktreeMutationLease({ env: f.env, id: "retry" }, (guard) =>
          guard.requireDiskSpace([{ path: f.root, bytes: 1 }], "writes"),
        ),
      ).rejects.toThrow("cleanup failed");
    } finally {
      fail.mockRestore();
    }
    expect(f.debts()).toHaveLength(1);
    await withWorktreeMutationLease({ env: f.env, id: "retry-successor" }, async (guard) => {
      await guard.requireDiskSpace([{ path: f.root, bytes: 0 }], "postcheck");
      expect(f.debts()).toHaveLength(1);
    });
    expect(f.debts()).toEqual([]);
  });
});
