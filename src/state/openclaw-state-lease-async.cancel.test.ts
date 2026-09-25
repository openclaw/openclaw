import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawStateLeaseAsync } from "./openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const queued = vi.hoisted(() => ({
  execute: vi.fn<(_command: unknown, options?: { signal?: AbortSignal }) => Promise<never>>(),
}));
vi.mock("./openclaw-state-worker-store.js", () => ({
  // Model a command waiting in the broker queue, before native dispatch and settlement custody.
  runOpenClawStateWorkerOperation: async (
    _context: unknown,
    operation: (scope: { execute: typeof queued.execute }) => Promise<unknown>,
  ) => operation({ execute: queued.execute }),
}));
vi.mock("./openclaw-state-db-cache.js", () => ({
  registerOpenClawStateDatabaseAsyncResource: () => () => {},
}));

it("settles an aborted acquisition without waiting for an unrelated queued command", async () => {
  const entered = createDeferredCore();
  const pending = createDeferredCore<never>();
  queued.execute.mockImplementation((_command, options) => {
    const reject = () => pending.reject(options?.signal?.reason);
    if (options?.signal?.aborted) {
      reject();
    } else {
      options?.signal?.addEventListener("abort", reject, { once: true });
    }
    entered.resolve();
    return pending.promise;
  });
  const context: OpenClawStateWorkerContext = {
    environment: { OPENCLAW_STATE_DIR: "/synthetic-lease" },
    coordinatorRuntime: { directory: "/synthetic-coordinator", keepAlive: false },
    admission: {
      databasePath: "/synthetic-lease/state.sqlite",
      identity: { key: "file:synthetic-lease", canonicalPath: "/synthetic-lease/state.sqlite" },
      assertCurrent() {},
    },
  };
  const controller = new AbortController();
  const callback = vi.fn(async () => {});
  let settled = false;
  const outcome = withOpenClawStateLeaseAsync(
    { scope: "core:test", key: "queued", leaseMs: 30_000, waitMs: 0, signal: controller.signal },
    context,
    callback,
  ).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await entered.promise;
    const reason = new Error("caller canceled while queued");
    controller.abort(reason);
    await yieldImmediate();
    expect(settled).toBe(true);
    expect(await outcome).toMatchObject({
      code: "OPENCLAW_STATE_LEASE_ABORTED",
      outcome: { kind: "aborted", reason: "caller-signal" },
      cause: reason,
    });
    expect(callback).not.toHaveBeenCalled();
  } finally {
    pending.reject(new Error("Synthetic queue disposed"));
    await outcome;
  }
});
