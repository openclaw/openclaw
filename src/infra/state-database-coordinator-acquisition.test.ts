import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateDatabaseCoordinatorContentionError } from "./state-database-coordinator-errors.js";

const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("./state-database-coordinator.js", async () => ({
  ...(await import("./state-database-coordinator-errors.js")),
  acquireStateDatabaseCoordinator: acquire,
  withStateDatabaseCoordinatorRuntimeDirectory: (_runtime: unknown, run: () => unknown) => run(),
}));
import { acquireStateDatabaseCoordinatorWithWait } from "./state-database-coordinator-acquisition.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  acquire.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const busy = () => new StateDatabaseCoordinatorContentionError("state-lifecycle");
function options() {
  return {
    operation: "session-admission" as const,
    databasePath: "synthetic.sqlite",
    runtime: { directory: "synthetic-locks", keepAlive: false },
    deadlineMs: performance.now() + 5_000,
    assertCurrent: vi.fn(),
  };
}

it("retries native acquisition, retaining one deadline and the original physical target", async () => {
  const lease = { release: vi.fn() };
  acquire
    .mockImplementationOnce(() => {
      throw busy();
    })
    .mockReturnValue(lease);
  const params = options();
  const pending = acquireStateDatabaseCoordinatorWithWait(params);
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toBe(lease);
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(acquire).toHaveBeenLastCalledWith({ databasePath: params.databasePath, busyTimeoutMs: 0 });
  expect(params.assertCurrent).toHaveBeenCalledTimes(2);
});

it("does not attempt native acquisition after sleeping to the deadline", async () => {
  acquire.mockImplementation(() => {
    throw busy();
  });
  const params = { ...options(), deadlineMs: performance.now() + 50 };
  const outcome = Promise.allSettled([acquireStateDatabaseCoordinatorWithWait(params)]);
  await vi.advanceTimersByTimeAsync(50);
  expect(await outcome).toMatchObject([
    { status: "rejected", reason: { family: "state-lifecycle" } },
  ]);
  expect(acquire).toHaveBeenCalledTimes(2);
});

it("cancels the wait without admitting a later release", async () => {
  acquire.mockImplementation(() => {
    throw busy();
  });
  const controller = new AbortController();
  const pending = Promise.allSettled([
    acquireStateDatabaseCoordinatorWithWait({ ...options(), signal: controller.signal }),
  ]);
  await vi.advanceTimersByTimeAsync(0);
  const reason = new Error("stopped");
  controller.abort(reason);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await pending).toMatchObject([{ status: "rejected" }]);
  expect(acquire).toHaveBeenCalledOnce();
});

it("rechecks live authority after a wait and never retries a typed guard refusal", async () => {
  acquire.mockImplementation(() => {
    throw busy();
  });
  const params = options();
  const refusal = busy();
  params.assertCurrent
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw refusal;
    });
  const pending = Promise.allSettled([acquireStateDatabaseCoordinatorWithWait(params)]);
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toEqual([{ status: "rejected", reason: refusal }]);
  expect(acquire).toHaveBeenCalledOnce();
});

it.each([
  new Error(
    "StateDatabaseCoordinatorContentionError: another OpenClaw process owns state-lifecycle",
  ),
  new StateDatabaseCoordinatorContentionError("state-handles"),
  new AggregateError([busy()], "cleanup uncertain"),
])("does not retry an ineligible acquisition failure: %s", async (error) => {
  acquire.mockImplementation(() => {
    throw error;
  });
  await expect(acquireStateDatabaseCoordinatorWithWait(options())).rejects.toBe(error);
  expect(acquire).toHaveBeenCalledOnce();
});

it("publishes a single quiet wait notice only after contention becomes noticeable", async () => {
  acquire.mockImplementation(() => {
    throw busy();
  });
  const onWait = vi.fn();
  const controller = new AbortController();
  const pending = Promise.allSettled([
    acquireStateDatabaseCoordinatorWithWait({ ...options(), onWait, signal: controller.signal }),
  ]);
  await vi.advanceTimersByTimeAsync(999);
  expect(onWait).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(onWait).toHaveBeenCalledOnce();
  controller.abort();
  await pending;
});

it("observes the shared physical owner's updated deadline without resetting any caller budget", async () => {
  const started = performance.now();
  let deadline = started + 50;
  const lease = { release: vi.fn() };
  acquire.mockImplementation(() => {
    if (performance.now() < started + 75) {
      throw busy();
    }
    return lease;
  });
  const outcome = Promise.allSettled([
    acquireStateDatabaseCoordinatorWithWait({
      ...options(),
      get deadlineMs() {
        return deadline;
      },
    }),
  ]);
  await vi.advanceTimersByTimeAsync(25);
  deadline = started + 200;
  await vi.runAllTimersAsync();
  expect(await outcome).toEqual([{ status: "fulfilled", value: lease }]);
});
