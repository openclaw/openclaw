import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../process/supervisor/types.js";
import type { CronStreamOwnerParams } from "./cron-stream-job-owner.js";
import {
  createCronStreamWatcherFixture,
  fakeSupervisor,
  job,
  settle,
} from "./cron-stream-watchers.test-helpers.js";

describe("cron stream watcher stop settlement", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { reason: "shutdown", retires: true, settlement: true },
    { reason: "removed", retires: true, settlement: false },
    { reason: "trust-disabled", retires: true, settlement: false },
    { reason: "cron-disabled", retires: true, settlement: false },
    { reason: "disabled", retires: false, settlement: false },
    { reason: "schedule-update", retires: false, settlement: false },
    { reason: "restart-exhausted", retires: false, settlement: false },
    { reason: "trigger-disabled", retires: false, settlement: false },
  ] as const)(
    "marks only the Gateway shutdown stop as a settlement write: $reason",
    async ({ reason, retires, settlement }) => {
      vi.useFakeTimers();
      const retireSource = vi.fn<CronStreamOwnerParams["retireSource"]>(
        async (_jobId, _scheduleKey, identity) => `${identity}:retired`,
      );
      const updateState = vi.fn<CronStreamOwnerParams["updateState"]>(async () => {});
      const updateCounters = vi.fn<NonNullable<CronStreamOwnerParams["updateCounters"]>>(
        async () => {},
      );
      const { fake, watchers } = createCronStreamWatcherFixture({
        minIntervalMs: 1,
        retireSource,
        updateState,
        updateCounters,
      });
      await watchers.reconcile([job()], true);
      await settle();
      // A line still inside its quiet window is lost by the stop and recorded on the same path.
      fake.inputs[0]?.onStdout?.("pending line\n");
      await settle();
      updateState.mockClear();

      await watchers.stop("stream-job", reason);

      if (retires) {
        expect(retireSource).toHaveBeenCalledTimes(1);
        const [retirement] = retireSource.mock.calls;
        expect(retirement?.slice(0, 3)).toEqual([
          "stream-job",
          expect.any(String),
          "source:stream-job",
        ]);
        expect(retirement?.[3]).toEqual(settlement ? { settlement: true } : undefined);
      } else {
        expect(retireSource).not.toHaveBeenCalled();
      }
      expect(updateState).toHaveBeenCalled();
      for (const call of updateState.mock.calls) {
        expect(call[4]).toEqual(settlement ? { settlement: true } : undefined);
      }
      expect(updateCounters).toHaveBeenCalledTimes(1);
      expect(updateCounters.mock.calls[0]?.[1]).toEqual({
        streamDroppedBatches: 1,
        streamCoalescedBatches: 0,
      });
      expect(updateCounters.mock.calls[0]?.[2]).toEqual(
        settlement ? { settlement: true } : undefined,
      );
      // A removed job disposes its owner; every other stop keeps a stopped owner.
      if (reason === "removed") {
        expect(watchers.inspect("stream-job")).toBeUndefined();
      } else {
        expect(watchers.inspect("stream-job")).toMatchObject({
          state: "stopped",
          processAlive: false,
        });
      }
      await watchers.stopAll("shutdown");
    },
  );

  it.each([
    { reason: "shutdown", stateOnly: true },
    { reason: "disabled", stateOnly: false },
  ] as const)(
    "persists a stop failure as state only during Gateway shutdown: $reason",
    async ({ reason, stateOnly }) => {
      vi.useFakeTimers();
      const spawn = vi.fn(async (input: SpawnInput) => {
        // The child ignores its cancel, so the bounded stop rejects.
        const { promise: wait } = createDeferred<RunExit>();
        return {
          activity: { resultSettled: false, lastOutputAtMs: Date.now() },
          runId: `run-${input.scopeKey ?? "stream"}`,
          startedAtMs: Date.now(),
          cancel: vi.fn(),
          detachOutput: vi.fn(),
          wait: () => wait,
        } satisfies ManagedRun;
      });
      const supervisor = {
        ...fakeSupervisor().supervisor,
        spawn,
      } satisfies ProcessSupervisor;
      const updateState = vi.fn<CronStreamOwnerParams["updateState"]>(async () => {});
      const recordFailure = vi.fn<CronStreamOwnerParams["recordFailure"]>(async () => {});
      const { watchers } = createCronStreamWatcherFixture({
        getProcessSupervisor: () => supervisor,
        minIntervalMs: 1,
        updateState,
        recordFailure,
      });
      await watchers.reconcile([job()], true);
      await settle();
      updateState.mockClear();

      const stopping = watchers.stop("stream-job", reason).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await stopping).toBeInstanceOf(Error);

      const failurePatch = {
        streamStatus: "error",
        streamError: expect.stringContaining("stream source failed to stop"),
        streamRestartExhausted: true,
      };
      if (stateOnly) {
        // Shutdown already stopped the channels, so the failure settles without an alert.
        expect(recordFailure).not.toHaveBeenCalled();
        expect(updateState).toHaveBeenCalledExactlyOnceWith(
          "stream-job",
          failurePatch,
          expect.any(String),
          expect.any(String),
          { settlement: true },
        );
      } else {
        expect(recordFailure).toHaveBeenCalledExactlyOnceWith(
          "stream-job",
          expect.stringContaining("stream source failed to stop"),
          failurePatch,
          expect.any(String),
          expect.any(String),
        );
        expect(updateState).not.toHaveBeenCalled();
      }
    },
  );
});
