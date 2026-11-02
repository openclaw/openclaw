// Command queue tests cover bounded command execution and queue ordering.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { getLaneState, getQueueState } from "./command-queue.state.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import {
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";
import { CommandLane } from "./lanes.js";
import { processProbeEntrypoints } from "./process-probes-runtime.test-support.js";

const diagnosticMocks = vi.hoisted(() => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diag: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: diagnosticMocks.logLaneEnqueue,
  logLaneDequeue: diagnosticMocks.logLaneDequeue,
  diagnosticLogger: diagnosticMocks.diag,
}));

type CommandQueueModule = typeof import("./command-queue.js");

let queue: CommandQueueModule;

function park<T>(
  lane: string,
  value: T,
  opts?: Parameters<CommandQueueModule["enqueueCommandInLane"]>[2],
) {
  const gate = createDeferred();
  const task = queue.enqueueCommandInLane(lane, afterGate(gate, value), opts);
  return { task, release: gate.resolve };
}

function afterGate<T>(gate: { promise: Promise<unknown> }, value: T) {
  return async () => {
    await gate.promise;
    return value;
  };
}

function expectCounts(lane: string, activeCount: number, queuedCount: number) {
  expect(queue.getCommandLaneSnapshot(lane)).toMatchObject({ activeCount, queuedCount });
}

function diagnosticDebugMessages(): string[] {
  return diagnosticMocks.diag.debug.mock.calls
    .map(([message]) => message)
    .filter((message): message is string => typeof message === "string");
}

describe("command queue", () => {
  beforeAll(async () => {
    queue = await import("./command-queue.js");
  });

  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    // Queue state is global across module instances, so reset main lane
    // concurrency explicitly to avoid cross-file leakage.
    queue.setCommandLaneConcurrency(CommandLane.Main, 1);
    for (const mock of [
      diagnosticMocks.logLaneEnqueue,
      diagnosticMocks.logLaneDequeue,
      ...Object.values(diagnosticMocks.diag),
    ]) {
      mock.mockClear();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
  });

  it("runs queued tasks and their lifecycle callbacks in their enqueue-time async context", async () => {
    const context = new AsyncLocalStorage<string>();
    const blocker = createDeferred();
    const callbacks: Array<[string, string | undefined]> = [];
    const record = (event: string) => callbacks.push([event, context.getStore()]);
    const first = context.run("first", () =>
      queue.enqueueCommandInLane(CommandLane.Main, async () => {
        await blocker.promise;
        return context.getStore();
      }),
    );
    const second = context.run("second", () =>
      queue.enqueueCommandInLane(CommandLane.Main, async () => context.getStore(), {
        warnAfterMs: 0,
        onWait: () => record("wait"),
      }),
    );
    blocker.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(callbacks).toEqual([["wait", "second"]]);
  });

  it("preserves priority and FIFO order across partial drains and resumed growth", async () => {
    const lane = "priority-fifo-resume";
    const calls: string[] = [];
    const enqueue = (label: string, priority?: "foreground" | "background") =>
      queue.enqueueCommandInLane(lane, async () => void calls.push(label), { priority });
    queue.setCommandLaneConcurrency(lane, 0);
    const normal = Array.from({ length: 20 }, (_, index) => enqueue(`normal-${index}`));
    queue.setCommandLaneConcurrency(lane, 5);
    queue.setCommandLaneConcurrency(lane, 0);
    await Promise.all(normal.slice(0, 5));
    const resumedNormal = Array.from({ length: 20 }, (_, index) => enqueue(`normal-${index + 20}`));
    const background = Array.from({ length: 18 }, (_, index) =>
      enqueue(`background-${index}`, "background"),
    );
    const foreground = Array.from({ length: 18 }, (_, index) =>
      enqueue(`foreground-${index}`, "foreground"),
    );
    queue.setCommandLaneConcurrency(lane, 1);
    await Promise.all([...normal, ...resumedNormal, ...background, ...foreground]);
    expect(calls).toEqual([
      ...Array.from({ length: 5 }, (_, index) => `normal-${index}`),
      ...Array.from({ length: 18 }, (_, index) => `foreground-${index}`),
      ...Array.from({ length: 35 }, (_, index) => `normal-${index + 5}`),
      ...Array.from({ length: 18 }, (_, index) => `background-${index}`),
    ]);
  });

  it("avoids quadratic array work as a paused queue doubles", () => {
    const queueUrl = resolveRuntimeWorkerUrl(processProbeEntrypoints.commandQueue);
    const script = String.raw`
      const { enqueueCommandInLane, setCommandLaneConcurrency } = await import(
        ${JSON.stringify(queueUrl.href)}
      );
      const originalFindIndex = Array.prototype.findIndex;
      const originalShift = Array.prototype.shift;
      let enqueueComparisons = 0;
      let shiftedSlots = 0;

      Array.prototype.findIndex = function (predicate, thisArg) {
        return originalFindIndex.call(this, (value, index, array) => {
          enqueueComparisons += 1;
          return predicate.call(thisArg, value, index, array);
        });
      };
      Array.prototype.shift = function () {
        shiftedSlots += this.length;
        return originalShift.call(this);
      };

      const measureQueueWork = async (count) => {
        const lane = "linear-queue-" + count;
        setCommandLaneConcurrency(lane, 0);
        const comparisonStart = enqueueComparisons;
        const tasks = Array.from({ length: count }, (_, index) =>
          enqueueCommandInLane(lane, async () => index),
        );
        const enqueueWork = enqueueComparisons - comparisonStart;
        const shiftedSlotStart = shiftedSlots;
        setCommandLaneConcurrency(lane, count);
        const dequeueWork = shiftedSlots - shiftedSlotStart;
        await Promise.all(tasks);
        return { enqueueWork, dequeueWork };
      };

      const smaller = await measureQueueWork(256);
      const larger = await measureQueueWork(512);
      process.stdout.write(JSON.stringify({ smaller, larger }));
    `;
    const result = spawnSync(
      process.execPath,
      [...resolveRuntimeWorkerArgv(queueUrl).slice(0, -1), "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
        },
        timeout: 60_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const measurements = JSON.parse(result.stdout) as {
      smaller: { enqueueWork: number; dequeueWork: number };
      larger: { enqueueWork: number; dequeueWork: number };
    };
    expect(measurements.larger.enqueueWork).toBeLessThanOrEqual(
      measurements.smaller.enqueueWork * 3 + 512,
    );
    expect(measurements.larger.dequeueWork).toBeLessThanOrEqual(
      measurements.smaller.dequeueWork * 3 + 512,
    );
  });

  it("does not report capacity waiting for an entry synchronously cancelled during enqueue", async () => {
    const lane = "reentrant-cancel";
    queue.setCommandLaneConcurrency(lane, 0);
    const cancellation = new AbortController();
    const reason = new Error("owner cancelled during enqueue");
    diagnosticMocks.logLaneEnqueue.mockImplementationOnce(() => cancellation.abort(reason));
    const onQueued = vi.fn();
    await expect(
      queue.enqueueCommandInLane(lane, async () => undefined, {
        onQueued,
        abortSignal: cancellation.signal,
      }),
    ).rejects.toBe(reason);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("demotes live model switch lane failures to debug noise", async () => {
    const error = new Error("Live session model switch requested: anthropic/claude-opus-4-6");
    error.name = "LiveSessionModelSwitchError";
    await expect(
      queue.enqueueCommandInLane("nested", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(diagnosticMocks.diag.error).not.toHaveBeenCalled();
    expect(
      diagnosticDebugMessages().some((message) =>
        message.includes("lane task interrupted: lane=nested"),
      ),
    ).toBe(true);
  });

  it.each([
    "session:probe-setup-inference:openai",
    "session:temp:setup-inference:probe-setup-inference-test-uuid",
  ])("keeps setup-inference probe lane failures quiet: %s", async (lane) => {
    const error = new Error("Authentication failed");
    await expect(
      queue.enqueueCommandInLane(lane, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(diagnosticMocks.diag.error).not.toHaveBeenCalled();
    expect(
      diagnosticDebugMessages().some((message) =>
        message.includes(`lane task interrupted: lane=${lane}`),
      ),
    ).toBe(false);
  });

  it.each([0, 3])("counts lane work with concurrency %s", async (concurrency) => {
    const lane = CommandLane.CronNested;
    const finish = createDeferred();
    queue.setCommandLaneConcurrency(lane, concurrency);
    const tasks = Array.from({ length: 3 }, () =>
      queue.enqueueCommandInLane(lane, () => finish.promise),
    );
    try {
      expect(queue.getQueueSize(lane)).toBe(3);
    } finally {
      finish.resolve();
      queue.setCommandLaneConcurrency(lane, 3);
      await Promise.all(tasks);
    }
    expect(queue.getQueueSize(lane)).toBe(0);
  });

  it("keeps draining functional after synchronous onWait failure", async () => {
    const lane = "drain-sync-throw";
    queue.setCommandLaneConcurrency(lane, 1);
    const first = park(lane, "first");
    const second = queue.enqueueCommandInLane(lane, async () => "second", {
      warnAfterMs: 0,
      onWait: () => {
        throw new Error("onWait exploded");
      },
    });
    await Promise.resolve();
    expect(queue.getQueueSize(lane)).toBeGreaterThanOrEqual(2);
    first.release();
    await expect(first.task).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it.each(["admission", "error"] as const)(
    "settles callers and drains the command lane when %s diagnostics throw",
    async (phase) => {
      vi.useFakeTimers();
      const lane = "diagnostic-failure";
      const diagnosticError = new Error("diagnostic sink failed");
      const taskError = new Error("Session transcript keyed user is outside the current turn");
      const gate = createDeferred<string>();
      const firstTask = vi.fn(() => gate.promise);
      const successor = vi.fn(async () => "successor");
      const taskIdentity = { taskKind: "turn", runId: "diagnostic-failure-run" };
      if (phase === "admission") {
        diagnosticMocks.logLaneDequeue.mockImplementationOnce(() => {
          throw diagnosticError;
        });
      }
      const outcomes = Promise.allSettled([
        queue.enqueueCommandInLane(lane, firstTask, { taskIdentity }),
        queue.enqueueCommandInLane(lane, successor),
      ]);
      if (phase !== "admission") {
        diagnosticMocks.diag.error.mockImplementationOnce(() => {
          throw diagnosticError;
        });
      }
      if (phase === "error") {
        gate.reject(taskError);
      } else {
        gate.resolve("first");
      }
      await vi.runAllTimersAsync();
      expect(successor).toHaveBeenCalledOnce();
      expect(firstTask).toHaveBeenCalledTimes(phase === "admission" ? 0 : 1);
      expect(await outcomes).toEqual([
        { status: "rejected", reason: phase === "admission" ? diagnosticError : taskError },
        { status: "fulfilled", value: "successor" },
      ]);
      expectCounts(lane, 0, 0);
      if (phase !== "admission") {
        expect(diagnosticMocks.diag.warn).toHaveBeenCalledWith(
          expect.stringContaining("lane task diagnostics failed after settlement:"),
          taskIdentity,
        );
      }
    },
  );

  it.each([
    { reason: "restart", message: "Gateway is restarting. Please try again shortly." },
    {
      reason: "stop (SIGTERM)",
      message: "Gateway is shutting down. Please try again once it is back online.",
    },
  ] satisfies {
    reason: Parameters<CommandQueueModule["markGatewayDraining"]>[0];
    message: string;
  }[])("explains why new enqueues are refused for $reason", async ({ reason, message }) => {
    queue.markGatewayDraining(reason);
    const task = vi.fn(async () => "blocked");
    await expect(queue.enqueueCommandInLane(CommandLane.Main, task)).rejects.toMatchObject({
      name: "GatewayDrainingError",
      message,
    });
    expect(task).not.toHaveBeenCalled();
  });

  it("does not affect already-active tasks after markGatewayDraining", async () => {
    const { task, release } = park(CommandLane.Main, "ok");
    queue.markGatewayDraining();
    release();
    await expect(task).resolves.toBe("ok");
  });

  it("reversibly fences new enqueues without disturbing an active task", async () => {
    const { task, release } = park(CommandLane.Main, "active-finished");
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    await expect(
      queue.enqueueCommandInLane(CommandLane.Main, async () => "blocked"),
    ).rejects.toThrow("Gateway is temporarily paused. Please try again shortly.");
    release();
    await expect(task).resolves.toBe("active-finished");
    expect(suspension?.release()).toBe(true);
    await expect(queue.enqueueCommandInLane(CommandLane.Main, async () => "resumed")).resolves.toBe(
      "resumed",
    );
  });

  function prepareRootEnqueue() {
    const gate = createDeferred();
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    const result = root?.run(async () => {
      await gate.promise;
      return await queue.enqueueCommandInLane(CommandLane.Main, async () => "continued");
    });
    return { root, result, resume: gate.resolve };
  }

  it.each(["suspend", "restart"] as const)(
    "checks subordinate admission during %s",
    async (mode) => {
      const { root, result, resume } = prepareRootEnqueue();
      const suspension = mode === "suspend" ? tryBeginGatewaySuspendAdmission(() => {}) : undefined;
      try {
        if (mode === "restart") {
          queue.markGatewayDraining();
        }
        resume();
        if (mode === "suspend") {
          await expect(result).resolves.toBe("continued");
          await expect(
            queue.enqueueCommandInLane(CommandLane.Main, async () => "blocked"),
          ).rejects.toBeInstanceOf(queue.GatewayDrainingError);
        } else {
          await expect(result).rejects.toBeInstanceOf(queue.GatewayDrainingError);
        }
      } finally {
        suspension?.rollback();
        root?.release();
      }
    },
  );

  it.each(["reset", "release"] as const)(
    "handles a captured queued root after %s",
    async (mode) => {
      const outerLane = "root-outer";
      queue.setCommandLaneConcurrency(outerLane, 0);
      const root = tryBeginGatewayRootWorkAdmission();
      expect(root).not.toBeNull();
      let task: Promise<string> | undefined;
      await root?.run(async () => {
        task = queue.enqueueCommandInLane(outerLane, async () =>
          queue.enqueueCommandInLane("root-inner", async () => "continued"),
        );
      });
      if (mode === "reset") {
        queue.markGatewayDraining();
        queue.resetAllLanes();
      } else {
        root?.release();
      }
      queue.setCommandLaneConcurrency(outerLane, 1);
      if (mode === "reset") {
        await expect(task).resolves.toBe("continued");
        root?.release();
      } else {
        await expect(task).rejects.toBeInstanceOf(queue.GatewayDrainingError);
      }
    },
  );

  it("shares lane state across distinct module instances", async () => {
    const commandQueueA = await importFreshModule<typeof import("./command-queue.js")>(
      import.meta.url,
      "./command-queue.js?scope=shared-a",
    );
    const commandQueueB = await importFreshModule<typeof import("./command-queue.js")>(
      import.meta.url,
      "./command-queue.js?scope=shared-b",
    );
    const lane = "shared-state";
    const blocker = createDeferred();
    commandQueueA.resetAllLanes();
    try {
      const task = commandQueueA.enqueueCommandInLane(lane, afterGate(blocker, "done"));
      expect(commandQueueB.getQueueSize(lane)).toBe(1);
      expect(commandQueueB.getTotalQueueSize()).toBe(1);
      blocker.resolve();
      await expect(task).resolves.toBe("done");
      expect(commandQueueB.getQueueSize(lane)).toBe(0);
    } finally {
      blocker.resolve();
      commandQueueA.resetAllLanes();
    }
  });
  describe("scoped command lane lifecycle", () => {
    it.each(["session:probe-", "cli:"])(
      "retires parallel %s lanes after completion",
      async (prefix) => {
        const lanes = getQueueState().lanes;
        const baselineSize = lanes.size;
        const allRunsStarted = createDeferred();
        let activeRuns = 0;
        let peakActiveRuns = 0;
        const laneNames = Array.from(
          { length: 10 },
          (_, index) => `${prefix}agent:main:autoqa-${index}`,
        );
        const results = await Promise.all(
          laneNames.map((lane, index) =>
            queue.enqueueCommandInLane(lane, async () => {
              activeRuns += 1;
              peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
              if (activeRuns === laneNames.length) {
                allRunsStarted.resolve();
              }
              await allRunsStarted.promise;
              activeRuns -= 1;
              return index;
            }),
          ),
        );
        expect(results).toEqual(Array.from({ length: 10 }, (_, index) => index));
        expect(peakActiveRuns).toBe(10);
        expect(activeRuns).toBe(0);
        expect(queue.getTotalQueueSize()).toBe(0);
        expect(lanes.size).toBe(baselineSize);
        for (const lane of laneNames) {
          expect(lanes.has(lane)).toBe(false);
        }
      },
    );

    it("keeps a setup-probe lane until its queued successor finishes", async () => {
      const lanes = getQueueState().lanes;
      const lane = "session:probe-autoqa-queued";
      const first = park(lane, "first");
      const second = park(lane, "second");
      expect(lanes.has(lane)).toBe(true);
      first.release();
      await expect(first.task).resolves.toBe("first");
      expect(lanes.has(lane)).toBe(true);
      expectCounts(lane, 1, 0);
      second.release();
      await expect(second.task).resolves.toBe("second");
      expect(lanes.has(lane)).toBe(false);
    });

    it("updates each session's subagent capacity and retires the queues after completion", async () => {
      const lanes = getQueueState().lanes;
      const parents = ["subagent:agent:main:parent-a", "subagent:agent:main:parent-b"];
      const gate = createDeferred();
      queue.setCommandLaneConcurrency(CommandLane.Subagent, 2);
      const runs = parents.flatMap((lane) =>
        Array.from({ length: 3 }, () =>
          queue.enqueueCommandInLane(lane, afterGate(gate, undefined)),
        ),
      );
      try {
        for (const [maxConcurrent, activeCount, queuedCount] of [
          [2, 2, 1],
          [1, 2, 1],
          [3, 3, 0],
        ] as const) {
          if (maxConcurrent !== 2) {
            queue.setCommandLaneConcurrency(CommandLane.Subagent, maxConcurrent);
          }
          for (const lane of parents) {
            expect(queue.getCommandLaneSnapshot(lane)).toMatchObject({
              maxConcurrent,
              activeCount,
              queuedCount,
            });
          }
        }
      } finally {
        gate.resolve();
        await Promise.all(runs);
      }
      for (const lane of parents) {
        expect(lanes.has(lane)).toBe(false);
        expect(queue.getCommandLaneSnapshot(lane).maxConcurrent).toBe(3);
        expect(lanes.has(lane)).toBe(false);
      }
    });

    it("preserves explicitly configured and paused dynamic lanes", async () => {
      const lanes = getQueueState().lanes;
      const configuredLane = "session:probe-autoqa-configured";
      const pausedLane = "nested:agent:main:autoqa-paused";

      queue.setCommandLaneConcurrency(configuredLane, 2);
      await Promise.all([
        queue.enqueueCommandInLane(configuredLane, async () => "first"),
        queue.enqueueCommandInLane(configuredLane, async () => "second"),
      ]);

      expect(lanes.has(configuredLane)).toBe(true);
      expect(queue.getCommandLaneSnapshot(configuredLane)).toMatchObject({
        activeCount: 0,
        queuedCount: 0,
        maxConcurrent: 2,
      });

      queue.setCommandLaneConcurrency(pausedLane, 0);
      let pausedRunStarted = false;
      const pausedRun = queue.enqueueCommandInLane(pausedLane, async () => {
        pausedRunStarted = true;
        return "resumed";
      });

      expect(pausedRunStarted).toBe(false);
      expect(lanes.has(pausedLane)).toBe(true);
      expect(queue.getCommandLaneSnapshot(pausedLane)).toMatchObject({
        activeCount: 0,
        queuedCount: 1,
        maxConcurrent: 0,
      });

      queue.setCommandLaneConcurrency(pausedLane, 1);
      await expect(pausedRun).resolves.toBe("resumed");
      expect(lanes.has(pausedLane)).toBe(false);
      expect(lanes.has(configuredLane)).toBe(true);
    });

    it("does not let pre-restart probe completion retire a replacement-generation run", async () => {
      const lanes = getQueueState().lanes;
      const lane = "session:probe-autoqa-replacement";
      const staleRun = park(lane, "stale", {
        sessionTarget: { agentId: "stale", sessionId: "stale" },
      });
      queue.resetAllLanes();
      const replacementRun = park(lane, "replacement", {
        sessionTarget: { agentId: "replacement", sessionId: "replacement" },
      });
      const replacementState = lanes.get(lane);
      staleRun.release();
      await expect(staleRun.task).resolves.toBe("stale");
      expect(lanes.get(lane)).toBe(replacementState);
      expectCounts(lane, 1, 0);
      expect(Array.from(replacementState?.activeTasks.values() ?? [])).toEqual([
        { agentId: "replacement", sessionId: "replacement" },
      ]);
      replacementRun.release();
      await expect(replacementRun.task).resolves.toBe("replacement");
      expect(lanes.has(lane)).toBe(false);
    });

    it("recreates a maintenance lane for deferred same-session follow-up work", async () => {
      const lanes = getQueueState().lanes;
      const lane = "context-engine-turn-maintenance:agent:main:autoqa-rerun";
      const replacementGate = createDeferred();
      const firstRun = queue.enqueueCommandInLane(lane, async () => "first");
      const originalState = lanes.get(lane);
      const replacementRun = firstRun.then(() =>
        queue.enqueueCommandInLane(lane, afterGate(replacementGate, "replacement")),
      );
      await expect(firstRun).resolves.toBe("first");
      expect(lanes.has(lane)).toBe(true);
      expect(lanes.get(lane)).not.toBe(originalState);
      expectCounts(lane, 1, 0);
      replacementGate.resolve();
      await expect(replacementRun).resolves.toBe("replacement");
      expect(lanes.has(lane)).toBe(false);
    });

    it("does not retire a newer lane state when stale work finishes", async () => {
      const lanes = getQueueState().lanes;
      const lane = "session:probe-autoqa-recreated-state";
      const staleRun = park(lane, "stale");
      lanes.delete(lane);
      const replacementState = getLaneState(lane);
      staleRun.release();
      await expect(staleRun.task).resolves.toBe("stale");
      expect(lanes.get(lane)).toBe(replacementState);
      lanes.delete(lane);
    });
  });
});
