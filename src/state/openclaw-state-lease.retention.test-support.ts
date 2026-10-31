import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Worker } from "node:worker_threads";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

const callerScope = new AsyncLocalStorage<object>();
type LeaseOptions = Parameters<typeof withOpenClawStateLease>[0];

async function captureCompletedLease(options: LeaseOptions) {
  const caller = { label: "previous gateway generation" };
  const reference = new WeakRef(caller);
  let worker: Worker | undefined;
  const observeWorker = (observed: Worker) => {
    worker = observed;
  };
  process.once("worker", observeWorker);
  try {
    const retained = await callerScope.run(caller, () =>
      withOpenClawStateLease(options, async (lease) => {
        if (options.heartbeat === "worker") {
          assert.ok(lease.assertOwnedAsync);
          await lease.assertOwnedAsync();
        }
        // The child keeps the real lease-owner scope, but its caller generation has advanced.
        const timer = callerScope.run({ label: "next gateway generation" }, () =>
          setInterval(() => undefined, 60_000),
        );
        return { lease, timer };
      }),
    );
    return { reference, worker, ...retained };
  } finally {
    process.removeListener("worker", observeWorker);
  }
}

await withOpenClawTestState({ label: "lease-retention" }, async (state) => {
  const options: LeaseOptions = {
    scope: "core:test-retention",
    key: "generation",
    database: { scope: "shared", options: { env: state.env } },
    leaseMs: 60_000,
    waitMs: 0,
  };
  const scenario = process.argv[2];
  assert.ok(scenario === "completed" || scenario === "completed-worker", `Unknown: ${scenario}`);
  const workerHeartbeat = scenario === "completed-worker";
  if (workerHeartbeat) {
    // Observe the heartbeat, not the shared acquisition worker. The completed case stays cold.
    await withOpenClawStateLease(options, async (lease) => lease.assertOwned());
  }
  const { reference, worker, lease, timer } = await captureCompletedLease({
    ...options,
    heartbeat: workerHeartbeat ? "worker" : undefined,
  });
  try {
    if (workerHeartbeat) {
      assert.equal(worker?.threadId, -1);
    }
    await collectForRetentionCheck(`lease-${scenario}`);
    assert.equal(reference.deref(), undefined, `${scenario}: caller state retained`);
    assert.throws(() => lease.assertOwned(), { code: "OPENCLAW_STATE_LEASE_LOST" });
    assert.throws(() => lease.renew?.(), { code: "OPENCLAW_STATE_LEASE_LOST" });
    if (workerHeartbeat) {
      assert.ok(lease.assertOwnedAsync);
      await assert.rejects(lease.assertOwnedAsync(), { code: "OPENCLAW_STATE_LEASE_LOST" });
    }
    await withOpenClawStateLease(options, async (next) => next.assertOwned());
  } finally {
    clearInterval(timer);
  }
});
