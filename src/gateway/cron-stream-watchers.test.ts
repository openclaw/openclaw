import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../process/supervisor/types.js";
import { createCronStreamWatchers } from "./cron-stream-watchers.js";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "stream-job",
    name: "stream job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "stream", command: ["stream-source"], batchMs: 50 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "base" },
    state: {},
    ...overrides,
  };
}

function exitResult(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "exit",
    exitCode: 0,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

function fakeSupervisor() {
  const inputs: SpawnInput[] = [];
  const runs: ManagedRun[] = [];
  const exits: Array<(result: RunExit) => void> = [];
  const spawn = vi.fn(async (input: SpawnInput) => {
    inputs.push(input);
    let resolveWait!: (result: RunExit) => void;
    const wait = new Promise<RunExit>((resolve) => {
      resolveWait = resolve;
    });
    const run: ManagedRun = {
      runId: `run-${runs.length + 1}`,
      startedAtMs: Date.now(),
      stdin: undefined,
      cancel: vi.fn(() => resolveWait(exitResult({ reason: "manual-cancel" }))),
      detachOutput: vi.fn(),
      wait: () => wait,
    };
    runs.push(run);
    exits.push(resolveWait);
    return run;
  });
  const supervisor = {
    spawn,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  } satisfies ProcessSupervisor;
  return { inputs, runs, exits, spawn, supervisor };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe("cron stream watchers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps lifecycle ownership when a diagnostic state write fails", async () => {
    const fake = fakeSupervisor();
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState: vi.fn(async () => {
        throw new Error("state write failed");
      }),
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await watchers.reconcile([job()], true);
    await settle();

    expect(fake.spawn).toHaveBeenCalledOnce();
    expect(watchers.inspect("stream-job")?.state).toBe("running");
    await watchers.stopAll("shutdown");
  });

  it("does not spawn after the cron store explicitly rejects schedule ownership", async () => {
    const fake = fakeSupervisor();
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState: vi.fn(async () => false),
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await watchers.start(job());

    expect(fake.spawn).not.toHaveBeenCalled();
    expect(watchers.inspect("stream-job")?.state).toBe("stopped");
  });

  it("batches stdout and stderr, filters match mode, and truncates at the byte cap", async () => {
    vi.useFakeTimers();
    const fake = fakeSupervisor();
    const fireBatch = vi.fn(async (_job: CronJob, _batch: string) => "fired" as const);
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile(
      [
        job({
          schedule: {
            kind: "stream",
            command: ["stream-source"],
            mode: "match",
            match: "^keep",
            batchMs: 50,
            maxBatchBytes: 1_024,
          },
        }),
      ],
      true,
    );
    await settle();

    fake.inputs[0]?.onStdout?.("drop this\nkeep one\n");
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    fake.inputs[0]?.onStderr?.(`keep ${"x".repeat(2_000)}\n`);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    await settle();

    expect(fireBatch).toHaveBeenCalledTimes(2);
    expect(fireBatch.mock.calls[0]?.[1]).toBe("keep one");
    expect(fireBatch.mock.calls[1]?.[1]).toMatch(/\[truncated\]$/u);
    await watchers.stopAll("shutdown");
  });

  it("buffers output emitted before the asynchronous spawn call resolves", async () => {
    vi.useFakeTimers();
    let resolveWait!: (exit: RunExit) => void;
    const wait = new Promise<RunExit>((resolve) => {
      resolveWait = resolve;
    });
    const run: ManagedRun = {
      runId: "early-output",
      startedAtMs: Date.now(),
      cancel: vi.fn(() => resolveWait(exitResult({ reason: "manual-cancel" }))),
      detachOutput: vi.fn(),
      wait: () => wait,
    };
    const spawn = vi.fn(async (input: SpawnInput) => {
      input.onStdout?.("early\n");
      return run;
    });
    const supervisor = {
      spawn,
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    } satisfies ProcessSupervisor;
    const fireBatch = vi.fn(async () => "fired" as const);
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await watchers.start(job());
    await vi.advanceTimersByTimeAsync(50);

    expect(fireBatch).toHaveBeenCalledWith(expect.any(Object), "early", expect.any(String));
    await watchers.stopAll("shutdown");
  });

  it("keeps one bounded pending batch while a payload is busy and honors minimum spacing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fake = fakeSupervisor();
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fireBatch = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first;
        return "fired" as const;
      })
      .mockResolvedValue("fired" as const);
    const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 100 } },
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("first\n");
    await vi.advanceTimersByTimeAsync(50);
    fake.inputs[0]?.onStdout?.("second\nthird\n");
    await vi.advanceTimersByTimeAsync(50);
    expect(fireBatch).toHaveBeenCalledTimes(1);
    releaseFirst();
    await settle();
    await vi.advanceTimersByTimeAsync(49);
    expect(fireBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fireBatch).toHaveBeenLastCalledWith(
      expect.any(Object),
      "second\nthird",
      expect.any(String),
    );
    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      expect.objectContaining({ streamCoalescedBatches: 1 }),
      expect.any(String),
    );
    await watchers.stopAll("shutdown");
  });

  it("prepends a busy retry ahead of batches that arrived while it was in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fake = fakeSupervisor();
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fireBatch = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first;
        return "busy" as const;
      })
      .mockResolvedValue("fired" as const);
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.start(job());

    fake.inputs[0]?.onStdout?.("first\n");
    await vi.advanceTimersByTimeAsync(50);
    fake.inputs[0]?.onStdout?.("second\n");
    await vi.advanceTimersByTimeAsync(50);
    releaseFirst();
    await settle();
    await vi.advanceTimersByTimeAsync(1);

    expect(fireBatch).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      "first\nsecond",
      expect.any(String),
    );
    await watchers.stopAll("shutdown");
  });

  it("serializes exact coalesced counter updates under sustained output", async () => {
    vi.useFakeTimers();
    const fake = fakeSupervisor();
    let releasePayload!: () => void;
    const payload = new Promise<void>((resolve) => {
      releasePayload = resolve;
    });
    const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => {
        await payload;
        return "fired" as const;
      }),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();

    for (const line of ["first", "second", "third", "fourth"]) {
      fake.inputs[0]?.onStdout?.(`${line}\n`);
      await vi.advanceTimersByTimeAsync(50);
    }
    const counterCalls = () =>
      updateState.mock.calls.filter(([, patch]) => patch.streamCoalescedBatches !== undefined);
    expect(counterCalls()).toHaveLength(3);
    expect(counterCalls().at(-1)?.[1]).toEqual(
      expect.objectContaining({ streamCoalescedBatches: 3 }),
    );

    releasePayload();
    await settle();
    await watchers.stopAll("shutdown");
  });

  it("counts a gate drop in the serialized owner", async () => {
    vi.useFakeTimers();
    const fake = fakeSupervisor();
    const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "dropped" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("ignored\n");
    await vi.advanceTimersByTimeAsync(50);

    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      expect.objectContaining({ streamDroppedBatches: 1 }),
      expect.any(String),
    );
    await watchers.stopAll("shutdown");
  });

  it("counts payload errors and rejected dispatches in the serialized owner", async () => {
    vi.useFakeTimers();
    const fake = fakeSupervisor();
    const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
    const fireBatch = vi
      .fn<() => Promise<"error">>()
      .mockResolvedValueOnce("error")
      .mockRejectedValueOnce(new Error("dispatch failed"));
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("failed\n");
    await vi.advanceTimersByTimeAsync(50);
    await settle();

    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      expect.objectContaining({ streamDroppedBatches: 1 }),
      expect.any(String),
    );

    fake.inputs[0]?.onStdout?.("rejected\n");
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      expect.objectContaining({ streamDroppedBatches: 2 }),
      expect.any(String),
    );
    await watchers.stopAll("shutdown");
  });

  it("counts a batch lost when fire dispatch rejects before cron can persist it", async () => {
    vi.useFakeTimers();
    const fake = fakeSupervisor();
    const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => await Promise.reject(new Error("transient failure"))),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("failed\n");
    await vi.advanceTimersByTimeAsync(50);
    await settle();

    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      expect.objectContaining({ streamDroppedBatches: 1 }),
      expect.any(String),
    );
    await watchers.stopAll("shutdown");
  });

  it("fires a batch for an empty line accepted by match mode", async () => {
    vi.useFakeTimers();
    const fake = fakeSupervisor();
    const fireBatch = vi.fn(async () => "fired" as const);
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile(
      [
        job({
          schedule: {
            kind: "stream",
            command: ["stream-source"],
            mode: "match",
            match: "^$",
            batchMs: 50,
          },
        }),
      ],
      true,
    );
    await settle();

    fake.inputs[0]?.onStdout?.("\n");
    await vi.advanceTimersByTimeAsync(50);

    expect(fireBatch).toHaveBeenCalledWith(expect.any(Object), "", expect.any(String));
    await watchers.stopAll("shutdown");
  });

  it("preserves leading and consecutive empty lines in a batch", async () => {
    vi.useFakeTimers();
    const fake = fakeSupervisor();
    const fireBatch = vi.fn(async () => "fired" as const);
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("\n\nvalue\n");
    await vi.advanceTimersByTimeAsync(50);

    expect(fireBatch).toHaveBeenCalledWith(expect.any(Object), "\n\nvalue", expect.any(String));
    await watchers.stopAll("shutdown");
  });

  it("stops the source when a once trigger disables its job", async () => {
    vi.useFakeTimers();
    const fake = fakeSupervisor();
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "disabled" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("once\n");
    await vi.advanceTimersByTimeAsync(50);
    await settle();

    expect(fake.runs[0]?.detachOutput).toHaveBeenCalled();
    expect(fake.runs[0]?.cancel).toHaveBeenCalled();
    expect(watchers.activeJobIds()).toEqual([]);
  });

  it("keeps interleaved stdout and stderr partial lines independent", async () => {
    vi.useFakeTimers();
    const fake = fakeSupervisor();
    const fireBatch = vi.fn(async (_job: CronJob, _batch: string) => "fired" as const);
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("out");
    fake.inputs[0]?.onStderr?.("err\n");
    fake.inputs[0]?.onStdout?.("put\n");
    await vi.advanceTimersByTimeAsync(50);

    expect(fireBatch).toHaveBeenCalledWith(expect.any(Object), "err\noutput", expect.any(String));
    await watchers.stopAll("shutdown");
  });

  it("detaches output and awaits exit on disable, removal, and shutdown", async () => {
    const fake = fakeSupervisor();
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await settle();
    await watchers.reconcile([job({ enabled: false })], true);
    expect(fake.runs[0]?.detachOutput).toHaveBeenCalled();
    expect(fake.runs[0]?.cancel).toHaveBeenCalled();

    await watchers.reconcile([job({ id: "remove-me" })], true);
    await settle();
    await watchers.reconcile([], true);
    expect(watchers.activeJobIds()).toEqual([]);

    await watchers.reconcile([job({ id: "shutdown-me" })], true);
    await settle();
    await watchers.stopAll("shutdown");
    expect(watchers.activeJobIds()).toEqual([]);
  });

  it("does not spawn and records a clear status when trigger trust is disabled", async () => {
    const fake = fakeSupervisor();
    const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await watchers.reconcile([job()], false);

    expect(fake.spawn).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      {
        streamStatus: "disabled",
        streamError: "stream sources require cron.triggers.enabled=true",
      },
      expect.any(String),
    );
  });

  it("reports cron-disabled remediation when only cron itself is off", async () => {
    const fake = fakeSupervisor();
    const updateState = vi.fn(async () => {});
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    // cron globally disabled but triggers enabled: the remediation must name
    // cron, not point the operator at an already-enabled trigger flag.
    await watchers.reconcile([job()], false, true);

    expect(fake.spawn).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      { streamStatus: "disabled", streamError: "cron is disabled" },
      expect.any(String),
    );
  });

  it("creates a quiescent owner to persist disabled status for an inactive stream job", async () => {
    const fake = fakeSupervisor();
    const updateState = vi.fn(async () => {});
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => fake.supervisor,
      updateState,
      recordFailure: vi.fn(async () => {}),
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await watchers.stop("stream-job", "trust-disabled", job());

    expect(fake.spawn).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(
      "stream-job",
      {
        streamStatus: "disabled",
        streamError: "stream sources require cron.triggers.enabled=true",
      },
      expect.any(String),
    );
  });

  it("restarts fast exits and records terminal failure after five attempts", async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(async () => {
      const result = exitResult();
      return {
        runId: `run-${spawn.mock.calls.length}`,
        startedAtMs: Date.now(),
        cancel: vi.fn(),
        detachOutput: vi.fn(),
        wait: async () => result,
      } satisfies ManagedRun;
    });
    const supervisor = {
      spawn,
      cancel: vi.fn(),
      cancelScope: vi.fn(),
      getRecord: vi.fn(),
    } satisfies ProcessSupervisor;
    const recordFailure = vi.fn(async () => {});
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 }, retry: { backoffMs: [1] } },
      updateState: vi.fn(async () => {}),
      recordFailure,
      fireBatch: vi.fn(async () => "fired" as const),
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile([job()], true);
    await vi.advanceTimersByTimeAsync(10);
    expect(spawn).toHaveBeenCalledTimes(5);
    expect(recordFailure).toHaveBeenCalledWith(
      "stream-job",
      expect.stringContaining("stream source exited"),
      expect.objectContaining({ streamRestartExhausted: true, streamConsecutiveFailures: 5 }),
      expect.any(String),
    );
    await watchers.start(job({ state: { streamRestartExhausted: false } }));
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn.mock.calls.length).toBeGreaterThan(5);
    await watchers.stopAll("shutdown");
  });

  describe("serialized owner interleavings", () => {
    it("starts unrelated jobs without cross-job mutation fencing", async () => {
      const fake = fakeSupervisor();
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      await Promise.all([
        watchers.start(job({ id: "stream-a" })),
        watchers.start(job({ id: "stream-b" })),
      ]);

      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.activeJobIds()).toEqual(expect.arrayContaining(["stream-a", "stream-b"]));
      await watchers.stopAll("shutdown");
    });

    it("rechecks the stop fence after a slow starting-state write and persists stopped", async () => {
      const fake = fakeSupervisor();
      let releaseStarting!: () => void;
      const startingWrite = new Promise<void>((resolve) => {
        releaseStarting = resolve;
      });
      let markStarting!: () => void;
      const starting = new Promise<void>((resolve) => {
        markStarting = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamStatus === "starting") {
          markStarting();
          await startingWrite;
        }
      });
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      const start = watchers.start(job());
      await starting;
      const shutdown = watchers.stopAll("shutdown");
      releaseStarting();
      await Promise.all([start, shutdown]);

      expect(fake.spawn).not.toHaveBeenCalled();
      expect(updateState.mock.calls.at(-1)?.[1]).toMatchObject({ streamStatus: "stopped" });
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        processAlive: false,
        restartTimerPending: false,
      });
    });

    it("bounds shutdown outside a stalled owner operation and pre-cancels its scope", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let markStarting!: () => void;
      const starting = new Promise<void>((resolve) => {
        markStarting = resolve;
      });
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
          if (patch.streamStatus === "starting") {
            markStarting();
            await new Promise<never>(() => {});
          }
        }),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      void watchers.start(job());
      await starting;
      const shutdown = watchers.stopAll("shutdown");
      const shutdownFailure = expect(shutdown).rejects.toThrow("stream owner stop did not settle");

      expect(fake.supervisor.cancelScope).toHaveBeenCalledWith(
        "cron-stream:stream-job",
        "manual-cancel",
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await shutdownFailure;
      expect(fake.spawn).not.toHaveBeenCalled();
    });

    it("discards a queued replacement start superseded by shutdown", async () => {
      const fake = fakeSupervisor();
      let blockStops = false;
      let releaseStop!: () => void;
      const stopWrite = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      let markStop!: () => void;
      const stopStarted = new Promise<void>((resolve) => {
        markStop = resolve;
      });
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
          if (blockStops && patch.streamStatus === "stopped") {
            markStop();
            await stopWrite;
          }
        }),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      blockStops = true;

      const replacement = watchers.start(
        job({ schedule: { kind: "stream", command: ["replacement"], batchMs: 50 } }),
      );
      await stopStarted;
      const shutdown = watchers.stopAll("shutdown");
      releaseStop();
      await Promise.all([replacement, shutdown]);

      expect(fake.spawn).toHaveBeenCalledOnce();
      expect(watchers.activeJobIds()).toEqual([]);
    });

    it("retains a late spawn handle until a later stop confirms its exit", async () => {
      vi.useFakeTimers();
      let resolveSpawn!: (run: ManagedRun) => void;
      const spawned = new Promise<ManagedRun>((resolve) => {
        resolveSpawn = resolve;
      });
      let resolveWait!: (exit: RunExit) => void;
      const wait = new Promise<RunExit>((resolve) => {
        resolveWait = resolve;
      });
      let cancelAttempts = 0;
      const run: ManagedRun = {
        runId: "late-run",
        startedAtMs: Date.now(),
        cancel: vi.fn(() => {
          cancelAttempts += 1;
          if (cancelAttempts === 2) {
            resolveWait(exitResult({ reason: "manual-cancel" }));
          }
        }),
        detachOutput: vi.fn(),
        wait: () => wait,
      };
      const supervisor = {
        spawn: vi.fn(async () => await spawned),
        cancel: vi.fn(),
        cancelScope: vi.fn(),
        getRecord: vi.fn(),
      } satisfies ProcessSupervisor;
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => supervisor,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      const starting = watchers.start(job());
      await settle();
      const stopping = watchers.stop("stream-job", "shutdown");
      resolveSpawn(run);
      const startFailure = expect(starting).rejects.toThrow("stream source did not exit");
      await vi.advanceTimersByTimeAsync(10_000);

      await startFailure;
      await stopping;
      expect(run.cancel).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        processAlive: false,
        restartTimerPending: false,
      });
    });

    it("drops and counts an open batch when disable wins, then freezes after stop", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 1 } },
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());

      const lateOutput = fake.inputs[0]?.onStdout;
      lateOutput?.("open batch\n");
      await settle();
      await watchers.stop("stream-job", "disabled");

      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        processAlive: false,
        restartTimerPending: false,
        droppedBatches: 1,
        coalescedBatches: 0,
      });
      expect(fireBatch).not.toHaveBeenCalled();
      const counterWrites = () =>
        updateState.mock.calls.filter(([, patch]) => patch.streamDroppedBatches !== undefined);
      expect(counterWrites()).toHaveLength(1);

      lateOutput?.("late batch\n");
      await vi.runAllTimersAsync();
      await settle();
      expect(counterWrites()).toHaveLength(1);
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(1);
    });

    it("does not count unmatched partial or discarded oversized input as a batch", async () => {
      const fake = fakeSupervisor();
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      const unmatched = job({
        id: "unmatched-partial",
        schedule: {
          kind: "stream",
          command: ["source"],
          mode: "match",
          match: "^keep$",
          maxBatchBytes: 1_024,
        },
      });
      const oversized = job({
        id: "discarded-oversized",
        schedule: {
          kind: "stream",
          command: ["source"],
          mode: "match",
          match: "^never$",
          maxBatchBytes: 1_024,
        },
      });
      await watchers.start(unmatched);
      await watchers.start(oversized);
      fake.inputs[0]?.onStdout?.("ignore");
      fake.inputs[1]?.onStdout?.("x".repeat(2_000));
      await settle();

      await watchers.stop(unmatched.id, "disabled");
      await watchers.stop(oversized.id, "disabled");

      expect(watchers.inspect(unmatched.id)?.droppedBatches).toBe(0);
      expect(watchers.inspect(oversized.id)?.droppedBatches).toBe(0);
    });

    it("carries final counters into a replacement created from a stale snapshot", async () => {
      const fake = fakeSupervisor();
      const updateState = vi.fn(async () => {});
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      const staleJob = job();
      await watchers.start(staleJob);
      fake.inputs[0]?.onStdout?.("first\n");
      await settle();
      await watchers.stop(staleJob.id, "removed");

      await watchers.start(staleJob);
      fake.inputs[1]?.onStdout?.("second\n");
      await settle();
      await watchers.stop(staleJob.id, "disabled");

      expect(watchers.inspect(staleJob.id)?.droppedBatches).toBe(2);
      expect(updateState).toHaveBeenCalledWith(
        staleJob.id,
        expect.objectContaining({ streamDroppedBatches: 2 }),
        expect.any(String),
      );
    });

    it("treats process exit during stopping as expected and never restarts", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 1 }, retry: { backoffMs: [10] } },
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());

      await watchers.stop("stream-job", "disabled");
      await vi.advanceTimersByTimeAsync(100);

      expect(fake.spawn).toHaveBeenCalledOnce();
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        processAlive: false,
        restartTimerPending: false,
      });
    });

    it("cancels old backoff before starting an updated schedule", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 1 }, retry: { backoffMs: [100] } },
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.exits[0]?.(exitResult());
      await settle();
      await settle();
      expect(watchers.inspect("stream-job")?.state).toBe("backoff");

      await watchers.start(
        job({ schedule: { kind: "stream", command: ["replacement"], batchMs: 50 } }),
      );
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(fake.inputs[1]).toMatchObject({ argv: ["replacement"] });
      await vi.advanceTimersByTimeAsync(200);
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      await watchers.stopAll("shutdown");
    });

    it("counts obsolete output once during backoff and after replacement", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const updateState = vi.fn(async () => {});
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 1 }, retry: { backoffMs: [10] } },
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      const obsoleteOutput = fake.inputs[0]?.onStdout;
      fake.exits[0]?.(exitResult());
      await settle();
      expect(watchers.inspect("stream-job")?.state).toBe("backoff");

      obsoleteOutput?.("late during backoff\n");
      await settle();
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(1);

      await vi.advanceTimersByTimeAsync(10);
      await settle();
      expect(fake.spawn).toHaveBeenCalledTimes(2);

      obsoleteOutput?.("late after replacement\n");
      await settle();

      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(1);
      expect(updateState).toHaveBeenCalledWith(
        "stream-job",
        expect.objectContaining({ streamDroppedBatches: 1 }),
        expect.any(String),
      );
      await watchers.stopAll("shutdown");
    });

    it("retains a cadence-delayed batch across source restart backoff", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const fake = fakeSupervisor();
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 100 }, retry: { backoffMs: [200] } },
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("first\n");
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      fake.inputs[0]?.onStdout?.("pending\n");
      await vi.advanceTimersByTimeAsync(50);
      fake.exits[0]?.(exitResult());
      await settle();

      await vi.advanceTimersByTimeAsync(50);
      expect(fireBatch).toHaveBeenCalledTimes(1);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "backoff",
        droppedBatches: 0,
      });

      await vi.advanceTimersByTimeAsync(150);
      await settle();
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(fireBatch).toHaveBeenLastCalledWith(expect.any(Object), "pending", expect.any(String));
      await watchers.stopAll("shutdown");
    });

    it("counts a pending batch before terminal restart exhaustion", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const fake = fakeSupervisor();
      const updateState = vi.fn(async () => {});
      const recordFailure = vi.fn(async () => {});
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 100 } },
        updateState,
        recordFailure,
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job({ state: { lastRunAtMs: 1_000, streamConsecutiveFailures: 4 } }));
      fake.inputs[0]?.onStdout?.("pending\n");
      await vi.advanceTimersByTimeAsync(50);
      fake.exits[0]?.(exitResult());
      await settle();

      expect(fireBatch).not.toHaveBeenCalled();
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
        consecutiveFailures: 5,
      });
      expect(recordFailure).toHaveBeenCalledOnce();
    });

    it("honors a synchronous stop fence in a pending-fire operation already queued first", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const fake = fakeSupervisor();
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 100 } },
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("first\n");
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      fake.inputs[0]?.onStdout?.("pending\n");
      await vi.advanceTimersByTimeAsync(50);
      await settle();

      vi.advanceTimersByTime(50);
      await watchers.stop("stream-job", "disabled");

      expect(fireBatch).toHaveBeenCalledTimes(1);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
      });
    });

    it("drains output accepted behind a slow owner write before entering backoff", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let releasePayload!: () => void;
      const payload = new Promise<void>((resolve) => {
        releasePayload = resolve;
      });
      let releaseCounter!: () => void;
      const counter = new Promise<void>((resolve) => {
        releaseCounter = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamCoalescedBatches === 1) {
          await counter;
        }
      });
      const fireBatch = vi
        .fn()
        .mockImplementationOnce(async () => {
          await payload;
          return "fired" as const;
        })
        .mockResolvedValue("fired" as const);
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 1 }, retry: { backoffMs: [1] } },
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("first\n");
      await vi.advanceTimersByTimeAsync(50);
      fake.inputs[0]?.onStdout?.("second\n");
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      expect(updateState).toHaveBeenCalledWith(
        "stream-job",
        expect.objectContaining({ streamCoalescedBatches: 1 }),
        expect.any(String),
      );

      fake.inputs[0]?.onStdout?.("accepted-before-exit\n");
      fake.exits[0]?.(exitResult());
      releaseCounter();
      await settle();
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);

      releasePayload();
      await settle();
      await vi.advanceTimersByTimeAsync(2);
      expect(fireBatch).toHaveBeenLastCalledWith(
        expect.any(Object),
        "second\naccepted-before-exit",
        expect.any(String),
      );
      await watchers.stopAll("shutdown");
    });

    it("ignores a late batch after removal without moving counters", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
      const fireBatch = vi.fn(async () => "fired" as const);
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 1 } },
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch,
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      const lateOutput = fake.inputs[0]?.onStdout;
      await watchers.stop("stream-job", "removed");
      const counterWrites = updateState.mock.calls.filter(
        ([, patch]) => patch.streamDroppedBatches !== undefined,
      ).length;

      lateOutput?.("late\n");
      await vi.runAllTimersAsync();
      await settle();

      expect(watchers.inspect("stream-job")).toBeUndefined();
      expect(fireBatch).not.toHaveBeenCalled();
      expect(
        updateState.mock.calls.filter(([, patch]) => patch.streamDroppedBatches !== undefined),
      ).toHaveLength(counterWrites);
    });

    it("serializes rapid enable-disable-enable into one final running owner", async () => {
      const fake = fakeSupervisor();
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 1 } },
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });

      const enabled = watchers.start(job());
      const disabled = watchers.stop("stream-job", "disabled");
      const reenabled = watchers.start(job());
      await Promise.all([enabled, disabled, reenabled]);

      expect(fake.spawn).toHaveBeenCalledOnce();
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "running",
        processAlive: true,
        restartTimerPending: false,
      });
      await watchers.stopAll("shutdown");
    });

    it("fences a stale reconcile that is overtaken by shutdown", async () => {
      const fake = fakeSupervisor();
      let releaseStopWrite!: () => void;
      const stopWrite = new Promise<void>((resolve) => {
        releaseStopWrite = resolve;
      });
      let markStopWriteStarted!: () => void;
      const stopWriteStarted = new Promise<void>((resolve) => {
        markStopWriteStarted = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamStatus === "stopped") {
          markStopWriteStarted();
          await stopWrite;
        }
      });
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job({ id: "old-job" }));

      const staleReconcile = watchers.reconcile([job({ id: "new-job" })], true);
      await stopWriteStarted;
      const shutdown = watchers.stopAll("shutdown");
      releaseStopWrite();
      await Promise.all([staleReconcile, shutdown]);

      expect(fake.spawn).toHaveBeenCalledOnce();
      expect(watchers.activeJobIds()).toEqual([]);
      expect(watchers.inspect("new-job")).toBeUndefined();
    });

    it("fences a stale reconcile snapshot after a newer direct update", async () => {
      const fake = fakeSupervisor();
      let releaseStopWrite!: () => void;
      const stopWrite = new Promise<void>((resolve) => {
        releaseStopWrite = resolve;
      });
      let markStopWriteStarted!: () => void;
      const stopWriteStarted = new Promise<void>((resolve) => {
        markStopWriteStarted = resolve;
      });
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
          if (patch.streamStatus === "stopped") {
            markStopWriteStarted();
            await stopWrite;
          }
        }),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job({ id: "blocking-job" }));

      const staleReconcile = watchers.reconcile(
        [
          job({
            id: "target-job",
            schedule: { kind: "stream", command: ["stale-source"], batchMs: 50 },
          }),
        ],
        true,
      );
      await stopWriteStarted;
      await watchers.start(
        job({
          id: "target-job",
          schedule: { kind: "stream", command: ["current-source"], batchMs: 50 },
        }),
      );
      releaseStopWrite();
      await staleReconcile;

      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(fake.inputs[1]).toMatchObject({ argv: ["current-source"] });
      expect(watchers.inspect("target-job")?.state).toBe("running");
      await watchers.stopAll("shutdown");
    });

    it("replaces an owner retired by an older reconcile when a newer snapshot wants it", async () => {
      const fake = fakeSupervisor();
      let releaseStopWrite!: () => void;
      const stopWrite = new Promise<void>((resolve) => {
        releaseStopWrite = resolve;
      });
      let markStopWriteStarted!: () => void;
      const stopWriteStarted = new Promise<void>((resolve) => {
        markStopWriteStarted = resolve;
      });
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
          if (patch.streamStatus === "stopped") {
            markStopWriteStarted();
            await stopWrite;
          }
        }),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());

      const staleReconcile = watchers.reconcile([], true);
      await stopWriteStarted;
      const currentReconcile = watchers.reconcile([job()], true);
      releaseStopWrite();
      await Promise.all([staleReconcile, currentReconcile]);

      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "running",
        processAlive: true,
      });
      await watchers.stopAll("shutdown");
    });

    it("lets a newer explicit start replace an owner being removed", async () => {
      const fake = fakeSupervisor();
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());

      const removal = watchers.stop("stream-job", "removed");
      const replacement = watchers.start(job());
      await Promise.all([removal, replacement]);

      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "running",
        processAlive: true,
      });
      await watchers.stopAll("shutdown");
    });

    it("does not leak owner or mutation-epoch state across unique-id churn", async () => {
      const fake = fakeSupervisor();
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        updateState: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => "fired" as const),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      // Push far past MAX_MUTATION_EPOCHS (1024) distinct job ids through
      // start+remove so the LRU eviction path runs many times; a broken cap
      // would grow unbounded (or spin). Removed jobs must leave no live owner.
      for (let i = 0; i < 2_100; i++) {
        const id = `churn-${i}`;
        await watchers.start(job({ id }));
        await watchers.stop(id, "removed");
      }
      expect(watchers.activeJobIds()).toEqual([]);
      await watchers.stopAll("shutdown");
    });

    it("bounds raw output while a serialized counter write is slow", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let releasePayload!: () => void;
      const payload = new Promise<void>((resolve) => {
        releasePayload = resolve;
      });
      let releaseCounter!: () => void;
      const counter = new Promise<void>((resolve) => {
        releaseCounter = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamCoalescedBatches === 1) {
          await counter;
        }
      });
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 1 } },
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => {
          await payload;
          return "fired" as const;
        }),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(
        job({
          schedule: {
            kind: "stream",
            command: ["source"],
            batchMs: 50,
            maxBatchBytes: 1_024,
          },
        }),
      );
      fake.inputs[0]?.onStdout?.("first\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);
      fake.inputs[0]?.onStdout?.("second\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);
      await settle();
      expect(updateState).toHaveBeenCalledWith(
        "stream-job",
        expect.objectContaining({ streamCoalescedBatches: 1 }),
        expect.any(String),
      );

      for (let index = 0; index < 1_000; index += 1) {
        fake.inputs[0]?.onStdout?.(`${"x".repeat(100)}\n`);
      }
      expect(watchers.inspect("stream-job")).toMatchObject({
        bufferedOutputBytes: 1_024,
        bufferedOutputSegments: 1,
      });

      releaseCounter();
      releasePayload();
      await vi.advanceTimersByTimeAsync(100);
      await settle();
      await watchers.stopAll("shutdown");
    });

    it("bounds stop while a payload remains in flight and freezes its counter", async () => {
      vi.useFakeTimers();
      const fake = fakeSupervisor();
      let releasePayload!: () => void;
      const payload = new Promise<void>((resolve) => {
        releasePayload = resolve;
      });
      const updateState = vi.fn(async (_jobId: string, _patch: Partial<CronJob["state"]>) => {});
      const watchers = createCronStreamWatchers({
        getProcessSupervisor: () => fake.supervisor,
        cronConfig: { triggers: { minIntervalMs: 1 } },
        updateState,
        recordFailure: vi.fn(async () => {}),
        fireBatch: vi.fn(async () => {
          await payload;
          return "fired" as const;
        }),
        logger: { info: vi.fn(), warn: vi.fn() },
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("in flight\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);

      const stopping = watchers.stop("stream-job", "disabled");
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
      });
      const counterWrites = updateState.mock.calls.filter(
        ([, patch]) => patch.streamDroppedBatches !== undefined,
      ).length;

      releasePayload();
      await settle();
      expect(
        updateState.mock.calls.filter(([, patch]) => patch.streamDroppedBatches !== undefined),
      ).toHaveLength(counterWrites);
    });
  });

  it("supervises a real Node line source and tears it down", async () => {
    vi.useRealTimers();
    const supervisor = createProcessSupervisor();
    const fireBatch = vi.fn(async () => "fired" as const);
    const watchers = createCronStreamWatchers({
      getProcessSupervisor: () => supervisor,
      cronConfig: { triggers: { minIntervalMs: 1 } },
      updateState: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      fireBatch,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await watchers.reconcile(
      [
        job({
          schedule: {
            kind: "stream",
            command: [
              process.execPath,
              "-e",
              "console.log('live-line'); setInterval(() => {}, 1000)",
            ],
            batchMs: 50,
          },
        }),
      ],
      true,
    );
    await vi.waitFor(
      () =>
        expect(fireBatch).toHaveBeenCalledWith(expect.any(Object), "live-line", expect.any(String)),
      {
        timeout: 3_000,
      },
    );
    await watchers.stopAll("shutdown");
    expect(watchers.activeJobIds()).toEqual([]);
  });
});
