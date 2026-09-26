import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

const callerScope = new AsyncLocalStorage<object>();
type LeaseOptions = Parameters<typeof withOpenClawStateLease>[0];

async function assertCollected(reference: WeakRef<object>, scenario: string) {
  const gc = globalThis.gc;
  assert.ok(gc, "The retention child requires --expose-gc");
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  assert.equal(
    reference.deref(),
    undefined,
    `${scenario}: canceled lease timers retained caller state`,
  );
}

async function captureCompletedLease(options: LeaseOptions) {
  const caller = { label: "previous gateway generation" };
  const reference = new WeakRef(caller);
  const retained: {
    lease?: OpenClawStateLeaseContext;
    timer?: NodeJS.Timeout;
    worker?: Worker;
  } = {};
  const observeWorker = (worker: Worker) => {
    retained.worker = worker;
  };
  process.once("worker", observeWorker);
  try {
    await callerScope.run(caller, () =>
      withOpenClawStateLease(options, async (lease) => {
        retained.lease = lease;
        // The child keeps the real lease-owner scope, but its caller generation has advanced.
        retained.timer = callerScope.run({ label: "next gateway generation" }, () =>
          setInterval(() => undefined, 60_000),
        );
      }),
    );
  } finally {
    process.removeListener("worker", observeWorker);
  }
  return { reference, retained };
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
  if (scenario === "completed" || scenario === "completed-worker") {
    if (scenario === "completed-worker") {
      // Observe the heartbeat, not the shared acquisition worker. The completed case stays cold.
      await withOpenClawStateLease(options, async (lease) => lease.assertOwned());
    }
    const { reference, retained } = await captureCompletedLease({
      ...options,
      ...(scenario === "completed-worker" ? { heartbeat: "worker" as const } : {}),
    });
    try {
      if (scenario === "completed-worker") {
        assert.ok(retained.worker);
        assert.equal(retained.worker.threadId, -1);
      }
      await assertCollected(reference, scenario);
      assert.ok(retained.lease);
      assert.ok(retained.timer);
      assert.throws(() => retained.lease?.assertOwned(), { code: "OPENCLAW_STATE_LEASE_LOST" });
      assert.throws(() => retained.lease?.renew?.(), { code: "OPENCLAW_STATE_LEASE_LOST" });
      await withOpenClawStateLease(options, async (next) => next.assertOwned());
    } finally {
      clearInterval(retained.timer);
    }
  } else {
    throw new Error(`Unknown lease retention scenario: ${scenario}`);
  }
});
