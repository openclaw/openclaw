// Command queue tests cover bounded command execution and queue ordering.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLaneQueue, type LaneState } from "./command-queue.state.js";
import { resetCommandQueueStateForTest } from "./command-queue.test-support.js";
import type { CommandQueueTaskDeadline } from "./command-queue.types.js";
import {
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "./gateway-work-admission.js";
import { CommandLane } from "./lanes.js";
import { processProbeEntrypoints } from "./process-probes-runtime.test-support.js";

const diagnosticMocks = vi.hoisted(() => ({
  logLaneEnqueue: vi.fn(),
  logLaneDequeue: vi.fn(),
  diag: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../logging/diagnostic-runtime.js", () => ({
  logLaneEnqueue: diagnosticMocks.logLaneEnqueue,
  logLaneDequeue: diagnosticMocks.logLaneDequeue,
  diagnosticLogger: diagnosticMocks.diag,
}));

type CommandQueueModule = typeof import("./command-queue.js");

let clearCommandLane: CommandQueueModule["clearCommandLane"];
let CommandLaneClearedError: CommandQueueModule["CommandLaneClearedError"];
let enqueueCommandInLane: CommandQueueModule["enqueueCommandInLane"];
let GatewayDrainingError: CommandQueueModule["GatewayDrainingError"];
let getCommandLaneSnapshot: CommandQueueModule["getCommandLaneSnapshot"];
let getQueueSize: CommandQueueModule["getQueueSize"];
let getTotalQueueSize: CommandQueueModule["getTotalQueueSize"];
let markGatewayDraining: CommandQueueModule["markGatewayDraining"];
let resetAllLanes: CommandQueueModule["resetAllLanes"];
let resetCommandLane: CommandQueueModule["resetCommandLane"];
let setCommandLaneConcurrency: CommandQueueModule["setCommandLaneConcurrency"];

function enqueueBlockedMainTask<T = void>(
  onRelease?: () => Promise<T> | T,
): {
  task: Promise<T>;
  release: () => void;
} {
  const deferred = createDeferred();
  const task = enqueueCommandInLane(CommandLane.Main, async () => {
    await deferred.promise;
    return (await onRelease?.()) as T;
  });
  return { task, release: deferred.resolve };
}

function diagnosticDebugMessages(): string[] {
  return diagnosticMocks.diag.debug.mock.calls
    .map(([message]) => message)
    .filter((message): message is string => typeof message === "string");
}

function captureDiagnosticConsole(level: "warn" | "error") {
  setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });
  const output = vi.fn();
  loggingState.rawConsole = {
    log: output,
    info: output,
    warn: output,
    error: output,
  };
  diagnosticMocks.diag[level].mockImplementationOnce(createSubsystemLogger("diagnostic")[level]);
  return output;
}

describe("command queue", () => {
  beforeAll(async () => {
    ({
      clearCommandLane,
      CommandLaneClearedError,
      enqueueCommandInLane,
      GatewayDrainingError,
      getCommandLaneSnapshot,
      getQueueSize,
      getTotalQueueSize,
      markGatewayDraining,
      resetAllLanes,
      resetCommandLane,
      setCommandLaneConcurrency,
    } = await import("./command-queue.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    // Queue state is global across module instances, so reset main lane
    // concurrency explicitly to avoid cross-file leakage.
    setCommandLaneConcurrency(CommandLane.Main, 1);
    diagnosticMocks.logLaneEnqueue.mockClear();
    diagnosticMocks.logLaneDequeue.mockClear();
    diagnosticMocks.diag.debug.mockClear();
    diagnosticMocks.diag.warn.mockClear();
    diagnosticMocks.diag.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setLoggerOverride(null);
    loggingState.rawConsole = null;
    resetLogger();
    resetCommandQueueStateForTest();
  });

  it("runs queued tasks and their lifecycle callbacks in their enqueue-time async context", async () => {
    const context = new AsyncLocalStorage<string>();
    const blocker = createDeferred();
    const callbacks: Array<[string, string | undefined]> = [];
    const first = context.run("first", () =>
      enqueueCommandInLane(CommandLane.Main, async () => {
        await blocker.promise;
        return context.getStore();
      }),
    );
    const second = context.run("second", () =>
      enqueueCommandInLane(CommandLane.Main, async () => context.getStore(), {
        warnAfterMs: 0,
        onWait: () => callbacks.push(["wait", context.getStore()]),
        taskTimeoutMs: 60_000,
        taskTimeoutProgressAtMs: () => {
          callbacks.push(["progress", context.getStore()]);
          return Date.now();
        },
        taskTimeoutSubscribe: () => {
          callbacks.push(["subscribe", context.getStore()]);
          return () => callbacks.push(["unsubscribe", context.getStore()]);
        },
      }),
    );

    blocker.resolve();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(callbacks).toEqual([
      ["wait", "second"],
      ["progress", "second"],
      ["subscribe", "second"],
      ["unsubscribe", "second"],
    ]);
  });

  it("preserves priority and FIFO order across partial drains and resumed growth", async () => {
    const lane = "priority-fifo-resume";
    const calls: string[] = [];
    const enqueue = (label: string, priority?: "foreground" | "background") =>
      enqueueCommandInLane(
        lane,
        async () => {
          calls.push(label);
        },
        { priority },
      );

    setCommandLaneConcurrency(lane, 0);
    const normal = Array.from({ length: 20 }, (_, index) => enqueue(`normal-${index}`));

    setCommandLaneConcurrency(lane, 5);
    setCommandLaneConcurrency(lane, 0);
    await Promise.all(normal.slice(0, 5));

    const resumedNormal = Array.from({ length: 20 }, (_, index) => enqueue(`normal-${index + 20}`));
    const background = Array.from({ length: 18 }, (_, index) =>
      enqueue(`background-${index}`, "background"),
    );
    const foreground = Array.from({ length: 18 }, (_, index) =>
      enqueue(`foreground-${index}`, "foreground"),
    );
    setCommandLaneConcurrency(lane, 1);
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

  it("does not report capacity waiting for an entry synchronously cleared during enqueue", async () => {
    const lane = "reentrant-clear";
    setCommandLaneConcurrency(lane, 0);
    diagnosticMocks.logLaneEnqueue.mockImplementationOnce(() => clearCommandLane(lane));
    const onQueued = vi.fn();
    await expect(
      enqueueCommandInLane(lane, async () => undefined, { onQueued }),
    ).rejects.toBeInstanceOf(CommandLaneClearedError);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("demotes live model switch lane failures to debug noise", async () => {
    const error = new Error("Live session model switch requested: anthropic/claude-opus-4-6");
    error.name = "LiveSessionModelSwitchError";

    await expect(
      enqueueCommandInLane("nested", async () => {
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

  it("logs error types separately from the actionable lane failure message", async () => {
    const consoleOutput = captureDiagnosticConsole("error");
    const error = new Error("provider request failed");
    error.name = "FailoverError";
    const taskIdentity = {
      taskKind: "turn",
      sessionKey: "agent:example:main",
      runId: 'run-"quoted"\nline',
    };

    await expect(
      enqueueCommandInLane(
        CommandLane.Main,
        async () => {
          throw error;
        },
        { taskIdentity },
      ),
    ).rejects.toBe(error);

    expect(diagnosticMocks.diag.error).toHaveBeenCalledWith(
      expect.not.stringContaining("FailoverError:"),
      expect.objectContaining({ errorName: "FailoverError", ...taskIdentity }),
    );
    expect(diagnosticMocks.diag.error).toHaveBeenCalledWith(
      expect.stringContaining('error="provider request failed"'),
      expect.any(Object),
    );
    expect(consoleOutput).toHaveBeenCalledWith(
      expect.stringContaining(
        'taskKind=turn sessionKey=agent:example:main runId="run-\\"quoted\\"\\nline"',
      ),
    );
    expect(consoleOutput.mock.calls[0]?.[0]).not.toMatch(/[\r\n]/);
    expect(consoleOutput.mock.calls[0]?.[0]).not.toContain("requesterSessionKey=");
  });

  it.each([
    "session:probe-setup-inference:openai",
    "session:temp:setup-inference:probe-setup-inference-test-uuid",
  ])("keeps setup-inference probe lane failures quiet: %s", async (lane) => {
    const error = new Error("Authentication failed");

    await expect(
      enqueueCommandInLane(lane, async () => {
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

  it("resetAllLanes drains queued work immediately after reset", async () => {
    const lane = `reset-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    const blocker = createDeferred();

    // Start a task that blocks the lane
    const task1 = enqueueCommandInLane(lane, async () => {
      await blocker.promise;
    });

    expect(getTotalQueueSize()).toBeGreaterThanOrEqual(1);

    // Enqueue another task — it should be stuck behind the blocker
    let task2Ran = false;
    const task2 = enqueueCommandInLane(lane, async () => {
      task2Ran = true;
    });

    expect(getQueueSize(lane)).toBeGreaterThanOrEqual(2);
    expect(task2Ran).toBe(false);

    // Simulate SIGUSR2: reset all lanes. Queued work (task2) should be
    // drained immediately — no fresh enqueue needed.
    resetAllLanes();

    // Complete the stale in-flight task; generation mismatch makes its
    // completion path a no-op for queue bookkeeping.
    blocker.resolve();
    await task1;

    // task2 should have been pumped by resetAllLanes's drain pass.
    await task2;
    expect(task2Ran).toBe(true);
  });

  it("resetCommandLane releases one stuck lane and drains its queued work", async () => {
    const lane = `reset-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const otherLane = `reset-lane-other-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);
    setCommandLaneConcurrency(otherLane, 1);

    const blocker = createDeferred();
    const otherBlocker = createDeferred();
    const first = enqueueCommandInLane(lane, async () => {
      await blocker.promise;
      return "first";
    });
    const other = enqueueCommandInLane(otherLane, async () => {
      await otherBlocker.promise;
      return "other";
    });

    let secondRan = false;
    const second = enqueueCommandInLane(lane, async () => {
      secondRan = true;
      return "second";
    });

    expect(secondRan).toBe(false);
    expect(
      getCommandLaneSnapshot(lane).activeCount + getCommandLaneSnapshot(otherLane).activeCount,
    ).toBe(2);
    expect(resetCommandLane(lane)).toBe(1);

    await expect(second).resolves.toBe("second");
    expect(secondRan).toBe(true);
    expect(getQueueSize(lane)).toBe(0);
    expect(getQueueSize(otherLane)).toBe(1);

    blocker.resolve();
    otherBlocker.resolve();
    await expect(first).resolves.toBe("first");
    await expect(other).resolves.toBe("other");
  });

  it("task timeout renews from progress timestamps", async () => {
    const lane = `timeout-progress-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    vi.useFakeTimers();
    try {
      let progressAtMs = Date.now();
      const blocker = createDeferred();
      const first = enqueueCommandInLane(
        lane,
        async () => {
          await blocker.promise;
          return "first";
        },
        {
          taskTimeoutMs: 25,
          taskTimeoutProgressAtMs: () => progressAtMs,
        },
      );
      let secondRan = false;
      const second = enqueueCommandInLane(lane, async () => {
        secondRan = true;
        return "second";
      });

      await vi.advanceTimersByTimeAsync(20);
      progressAtMs = Date.now();
      await vi.advanceTimersByTimeAsync(20);
      expect(secondRan).toBe(false);

      blocker.resolve();
      await expect(first).resolves.toBe("first");
      await expect(second).resolves.toBe("second");
      expect(secondRan).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("task timeout falls back when progress timestamp callback throws", async () => {
    const lane = `timeout-progress-throw-lane-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    vi.useFakeTimers();
    try {
      const first = enqueueCommandInLane(lane, async () => new Promise<never>(() => {}), {
        taskTimeoutMs: 25,
        taskTimeoutProgressAtMs: () => {
          throw new Error("progress failed");
        },
      });
      const firstRejected = expect(first).rejects.toMatchObject({
        name: "CommandLaneTaskTimeoutError",
        message: expect.stringContaining("no progress for 25ms (task budget 25ms"),
      });

      await vi.advanceTimersByTimeAsync(25);
      await firstRejected;

      expect(
        diagnosticMocks.diag.warn.mock.calls.some(([message]) =>
          String(message).includes("lane task timeout progress callback failed"),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps draining functional after synchronous onWait failure", async () => {
    const lane = `drain-sync-throw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(lane, 1);

    const deferred = createDeferred();
    const first = enqueueCommandInLane(lane, async () => {
      await deferred.promise;
      return "first";
    });
    const second = enqueueCommandInLane(lane, async () => "second", {
      warnAfterMs: 0,
      onWait: () => {
        throw new Error("onWait exploded");
      },
    });
    await Promise.resolve();
    expect(getQueueSize(lane)).toBeGreaterThanOrEqual(2);

    deferred.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it.each(["admission", "completion", "error"] as const)(
    "settles callers and drains the session lane when %s diagnostics throw",
    async (phase) => {
      vi.useFakeTimers();
      const lane = "session:agent:test:diagnostic-failure";
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
        enqueueCommandInLane(lane, firstTask, { taskIdentity }),
        enqueueCommandInLane(lane, successor),
      ]);
      if (phase !== "admission") {
        diagnosticMocks.diag[phase === "error" ? "error" : "debug"].mockImplementationOnce(() => {
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
        phase === "completion"
          ? { status: "fulfilled", value: "first" }
          : { status: "rejected", reason: phase === "admission" ? diagnosticError : taskError },
        { status: "fulfilled", value: "successor" },
      ]);
      expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 0, queuedCount: 0 });
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
    markGatewayDraining(reason);
    const task = vi.fn(async () => "blocked");
    await expect(enqueueCommandInLane(CommandLane.Main, task)).rejects.toMatchObject({
      name: "GatewayDrainingError",
      message,
    });
    expect(task).not.toHaveBeenCalled();
  });

  it("does not affect already-active tasks after markGatewayDraining", async () => {
    const { task, release } = enqueueBlockedMainTask(async () => "ok");
    markGatewayDraining();
    release();
    await expect(task).resolves.toBe("ok");
  });

  it("reversibly fences new enqueues without disturbing an active task", async () => {
    const { task, release } = enqueueBlockedMainTask(async () => "active-finished");
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    await expect(enqueueCommandInLane(CommandLane.Main, async () => "blocked")).rejects.toThrow(
      "Gateway is temporarily paused. Please try again shortly.",
    );

    release();
    await expect(task).resolves.toBe("active-finished");
    expect(suspension?.release()).toBe(true);
    await expect(enqueueCommandInLane(CommandLane.Main, async () => "resumed")).resolves.toBe(
      "resumed",
    );
  });

  it("lets an admitted root enqueue while suspension preparation refuses new work", async () => {
    const continueRoot = createDeferred();
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    const result = root?.run(async () => {
      await continueRoot.promise;
      return await enqueueCommandInLane(CommandLane.Main, async () => "continued");
    });
    const suspension = tryBeginGatewaySuspendAdmission(() => {});

    try {
      continueRoot.resolve();
      await expect(result).resolves.toBe("continued");
      await expect(
        enqueueCommandInLane(CommandLane.Main, async () => "blocked"),
      ).rejects.toBeInstanceOf(GatewayDrainingError);
    } finally {
      suspension?.rollback();
      root?.release();
    }
  });

  it("rejects subordinate enqueues from an admitted root after restart drain", async () => {
    const continueRoot = createDeferred();
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    const result = root?.run(async () => {
      await continueRoot.promise;
      return await enqueueCommandInLane(CommandLane.Main, async () => "blocked");
    });

    try {
      markGatewayDraining();
      continueRoot.resolve();
      await expect(result).rejects.toBeInstanceOf(GatewayDrainingError);
    } finally {
      root?.release();
    }
  });

  it("re-admits preserved queued work after reset retires its captured root", async () => {
    const outerLane = `restart-outer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const innerLane = `restart-inner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(outerLane, 0);
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    let task: Promise<string> | undefined;
    await root?.run(async () => {
      task = enqueueCommandInLane(outerLane, async () =>
        enqueueCommandInLane(innerLane, async () => "continued"),
      );
    });

    markGatewayDraining();
    resetAllLanes();
    setCommandLaneConcurrency(outerLane, 1);

    await expect(task).resolves.toBe("continued");
    root?.release();
  });

  it("does not re-admit queued work after its root is released normally", async () => {
    const outerLane = `released-outer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const innerLane = `released-inner-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setCommandLaneConcurrency(outerLane, 0);
    const root = tryBeginGatewayRootWorkAdmission();
    expect(root).not.toBeNull();
    let task: Promise<string> | undefined;
    await root?.run(async () => {
      task = enqueueCommandInLane(outerLane, async () =>
        enqueueCommandInLane(innerLane, async () => "unexpected"),
      );
    });

    root?.release();
    setCommandLaneConcurrency(outerLane, 1);

    await expect(task).rejects.toBeInstanceOf(GatewayDrainingError);
  });

  it("shares lane state across distinct module instances", async () => {
    const commandQueueA = await importFreshModule<typeof import("./command-queue.js")>(
      import.meta.url,
      "./command-queue.js?scope=shared-a",
    );
    const commandQueueB = await importFreshModule<typeof import("./command-queue.js")>(
      import.meta.url,
      "./command-queue.js?scope=shared-b",
    );
    const lane = `shared-state-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const blocker = createDeferred();

    commandQueueA.resetAllLanes();

    try {
      const task = commandQueueA.enqueueCommandInLane(lane, async () => {
        await blocker.promise;
        return "done";
      });

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
    function getCommandLaneRegistryForTest(): Map<string, unknown> {
      const state = (globalThis as Record<PropertyKey, unknown>)[
        Symbol.for("openclaw.commandQueueState")
      ];
      const lanes = (state as { lanes?: unknown } | undefined)?.lanes;
      if (!(lanes instanceof Map)) {
        throw new Error("Expected the shared command lane registry to be initialized");
      }
      return lanes as Map<string, unknown>;
    }

    it.each(["session", "cli"])("retires parallel %s lanes after completion", async (prefix) => {
      const lanes = getCommandLaneRegistryForTest();
      const baselineSize = lanes.size;
      const allRunsStarted = createDeferred();
      let activeRuns = 0;
      let peakActiveRuns = 0;
      const laneNames = Array.from(
        { length: 10 },
        (_, index) => `${prefix}:agent:main:autoqa-${index}`,
      );

      const results = await Promise.all(
        laneNames.map((lane, index) =>
          enqueueCommandInLane(lane, async () => {
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
      expect(getTotalQueueSize()).toBe(0);
      expect(lanes.size).toBe(baselineSize);
      for (const lane of laneNames) {
        expect(lanes.has(lane)).toBe(false);
      }
    });

    it("keeps a session lane until its queued successor finishes", async () => {
      const lanes = getCommandLaneRegistryForTest();
      const lane = "session:agent:main:autoqa-queued";
      const firstGate = createDeferred();
      const secondGate = createDeferred();

      const first = enqueueCommandInLane(lane, async () => {
        await firstGate.promise;
        return "first";
      });
      const second = enqueueCommandInLane(lane, async () => {
        await secondGate.promise;
        return "second";
      });

      expect(lanes.has(lane)).toBe(true);
      firstGate.resolve();
      await expect(first).resolves.toBe("first");
      expect(lanes.has(lane)).toBe(true);
      expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 0 });

      secondGate.resolve();
      await expect(second).resolves.toBe("second");
      expect(lanes.has(lane)).toBe(false);
    });

    it("updates each session's subagent capacity and retires the queues after completion", async () => {
      const lanes = getCommandLaneRegistryForTest();
      const parents = ["subagent:agent:main:parent-a", "subagent:agent:main:parent-b"];
      const gate = createDeferred();
      setCommandLaneConcurrency(CommandLane.Subagent, 2);
      const runs = parents.flatMap((lane) =>
        Array.from({ length: 3 }, () =>
          enqueueCommandInLane(lane, async () => {
            await gate.promise;
          }),
        ),
      );

      try {
        for (const lane of parents) {
          expect(getCommandLaneSnapshot(lane)).toMatchObject({
            maxConcurrent: 2,
            activeCount: 2,
            queuedCount: 1,
          });
        }

        setCommandLaneConcurrency(CommandLane.Subagent, 1);
        for (const lane of parents) {
          expect(getCommandLaneSnapshot(lane)).toMatchObject({
            maxConcurrent: 1,
            activeCount: 2,
            queuedCount: 1,
          });
        }

        setCommandLaneConcurrency(CommandLane.Subagent, 3);
        for (const lane of parents) {
          expect(getCommandLaneSnapshot(lane)).toMatchObject({
            maxConcurrent: 3,
            activeCount: 3,
            queuedCount: 0,
          });
        }
      } finally {
        gate.resolve();
        await Promise.all(runs);
      }
      for (const lane of parents) {
        expect(lanes.has(lane)).toBe(false);
        expect(getCommandLaneSnapshot(lane).maxConcurrent).toBe(3);
        expect(lanes.has(lane)).toBe(false);
      }
    });

    it("preserves explicitly configured and paused dynamic lanes", async () => {
      const lanes = getCommandLaneRegistryForTest();
      const configuredLane = "session:agent:main:autoqa-configured";
      const pausedLane = "nested:agent:main:autoqa-paused";

      setCommandLaneConcurrency(configuredLane, 2);
      await Promise.all([
        enqueueCommandInLane(configuredLane, async () => "first"),
        enqueueCommandInLane(configuredLane, async () => "second"),
      ]);

      expect(lanes.has(configuredLane)).toBe(true);
      expect(getCommandLaneSnapshot(configuredLane)).toMatchObject({
        activeCount: 0,
        queuedCount: 0,
        maxConcurrent: 2,
      });

      setCommandLaneConcurrency(pausedLane, 0);
      let pausedRunStarted = false;
      const pausedRun = enqueueCommandInLane(pausedLane, async () => {
        pausedRunStarted = true;
        return "resumed";
      });

      expect(pausedRunStarted).toBe(false);
      expect(lanes.has(pausedLane)).toBe(true);
      expect(getCommandLaneSnapshot(pausedLane)).toMatchObject({
        activeCount: 0,
        queuedCount: 1,
        maxConcurrent: 0,
      });

      setCommandLaneConcurrency(pausedLane, 1);
      await expect(pausedRun).resolves.toBe("resumed");
      expect(lanes.has(pausedLane)).toBe(false);
      expect(lanes.has(configuredLane)).toBe(true);
    });

    it("does not let stale session completion retire a replacement-generation run", async () => {
      const lanes = getCommandLaneRegistryForTest();
      const lane = "session:agent:main:autoqa-replacement";
      const staleGate = createDeferred();
      const replacementGate = createDeferred();
      const staleRun = enqueueCommandInLane(lane, async () => {
        await staleGate.promise;
        return "stale";
      });

      expect(resetCommandLane(lane)).toBe(1);
      const replacementRun = enqueueCommandInLane(lane, async () => {
        await replacementGate.promise;
        return "replacement";
      });
      const replacementState = lanes.get(lane);

      staleGate.resolve();
      await expect(staleRun).resolves.toBe("stale");
      expect(lanes.get(lane)).toBe(replacementState);
      expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 0 });

      replacementGate.resolve();
      await expect(replacementRun).resolves.toBe("replacement");
      expect(lanes.has(lane)).toBe(false);
    });

    it("recreates a maintenance lane for deferred same-session follow-up work", async () => {
      const lanes = getCommandLaneRegistryForTest();
      const lane = "context-engine-turn-maintenance:agent:main:autoqa-rerun";
      const replacementGate = createDeferred();
      const firstRun = enqueueCommandInLane(lane, async () => "first");
      const originalState = lanes.get(lane);
      const replacementRun = firstRun.then(() =>
        enqueueCommandInLane(lane, async () => {
          await replacementGate.promise;
          return "replacement";
        }),
      );

      await expect(firstRun).resolves.toBe("first");
      expect(lanes.has(lane)).toBe(true);
      expect(lanes.get(lane)).not.toBe(originalState);
      expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 0 });

      replacementGate.resolve();
      await expect(replacementRun).resolves.toBe("replacement");
      expect(lanes.has(lane)).toBe(false);
    });

    it("does not retire a newer lane state when stale work finishes", async () => {
      const lanes = getCommandLaneRegistryForTest();
      const lane = "session:agent:main:autoqa-recreated-state";
      const staleGate = createDeferred();
      const staleRun = enqueueCommandInLane(lane, async () => {
        await staleGate.promise;
        return "stale";
      });
      const replacementState = {
        lane,
        queue: createLaneQueue(),
        activeTaskIds: new Set<number>(),
        maxConcurrent: 1,
        draining: false,
        generation: 0,
      } satisfies LaneState;

      lanes.set(lane, replacementState);
      staleGate.resolve();
      await expect(staleRun).resolves.toBe("stale");

      expect(lanes.get(lane)).toBe(replacementState);
      lanes.delete(lane);
    });

    it("retires a scoped lane after its active task times out", async () => {
      const lanes = getCommandLaneRegistryForTest();
      const lane = "session:agent:main:autoqa-timed-out";

      vi.useFakeTimers();
      try {
        const timedOut = enqueueCommandInLane(lane, async () => new Promise<never>(() => {}), {
          taskTimeoutMs: 5,
        });
        const rejection = expect(timedOut).rejects.toMatchObject({
          name: "CommandLaneTaskTimeoutError",
        });

        await vi.advanceTimersByTimeAsync(5);
        await rejection;

        expect(lanes.has(lane)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("command lane owner deadlines", () => {
    const lane = "runtime-deadline-test";
    const finishers: Array<() => void> = [];

    function enqueueOwnedTask(initialDeadline: CommandQueueTaskDeadline, initiallyAborted = false) {
      const finish = createDeferred();
      finishers.push(finish.resolve);
      const abort = new AbortController();
      const release = new AbortController();
      if (initiallyAborted) {
        abort.abort();
      }
      const unsubscribe = vi.fn();
      let progressAtMs = Date.now();
      let publish: (deadline: CommandQueueTaskDeadline | undefined) => void = () => {
        throw new Error("deadline subscription is not active");
      };
      const task = enqueueCommandInLane(lane, () => finish.promise, {
        taskTimeoutMs: 25,
        taskTimeoutProgressAtMs: () => progressAtMs,
        taskTimeoutAbortSignal: abort.signal,
        taskTimeoutAbortGraceMs: 5,
        taskTimeoutReleaseSignal: release.signal,
        taskTimeoutSubscribe: (onDeadline) => {
          publish = onDeadline;
          onDeadline(initialDeadline);
          return unsubscribe;
        },
      });
      const outcome = task.then(
        () => ({ status: "completed" as const }),
        (error: unknown) => ({ status: "failed" as const, error }),
      );
      return {
        abort,
        release,
        finish: finish.resolve,
        outcome,
        unsubscribe,
        publish: (deadline: CommandQueueTaskDeadline | undefined) => publish(deadline),
        progress: () => {
          progressAtMs = Date.now();
        },
      };
    }

    beforeEach(() => {
      resetCommandQueueStateForTest();
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse("2026-08-20T12:00:00Z"));
    });

    afterEach(async () => {
      for (const finish of finishers.splice(0)) {
        finish();
      }
      await vi.advanceTimersByTimeAsync(0);
      resetCommandQueueStateForTest();
      vi.useRealTimers();
    });

    it("replaces idle timing with an absolute deadline that progress cannot extend", async () => {
      const owner = enqueueOwnedTask({ kind: "bounded", deadlineAtMs: Date.now() + 100 });
      const next = vi.fn(async () => "next");
      const queued = enqueueCommandInLane(lane, next);
      await vi.advanceTimersByTimeAsync(50);
      owner.progress();
      await vi.advanceTimersByTimeAsync(49);
      expect(next).not.toHaveBeenCalled();
      expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 1 });
      await vi.advanceTimersByTimeAsync(1);
      await expect(owner.outcome).resolves.toMatchObject({
        status: "failed",
        error: {
          name: "CommandLaneTaskTimeoutError",
          message: expect.stringContaining("owner deadline"),
        },
      });
      await expect(queued).resolves.toBe("next");
      expect(owner.unsubscribe).toHaveBeenCalledOnce();
    });

    it("lets unlimited execution hand off to bounded terminal settlement", async () => {
      const owner = enqueueOwnedTask({ kind: "unlimited" });
      await vi.advanceTimersByTimeAsync(49 * 60 * 60 * 1000);
      expect(getCommandLaneSnapshot(lane).activeCount).toBe(1);
      owner.publish({ kind: "bounded", deadlineAtMs: Date.now() + 120_000 });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(getCommandLaneSnapshot(lane).activeCount).toBe(1);
      owner.finish();
      await expect(owner.outcome).resolves.toEqual({ status: "completed" });
      owner.publish({ kind: "bounded", deadlineAtMs: Date.now() });
      await vi.advanceTimersByTimeAsync(1);
      expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("restores ordinary idle recovery after the runtime releases deadline ownership", async () => {
      const owner = enqueueOwnedTask({ kind: "unlimited" });
      await vi.advanceTimersByTimeAsync(1_000);
      owner.progress();
      owner.publish(undefined);
      await vi.advanceTimersByTimeAsync(24);
      expect(getCommandLaneSnapshot(lane).activeCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(owner.outcome).resolves.toMatchObject({
        status: "failed",
        error: {
          name: "CommandLaneTaskTimeoutError",
          message: expect.stringContaining("no progress for 25ms"),
        },
      });
    });

    it("does not let a late deadline update replace an accepted abort grace", async () => {
      const owner = enqueueOwnedTask({ kind: "unlimited" });
      owner.abort.abort();
      owner.publish({ kind: "unlimited" });
      await vi.advanceTimersByTimeAsync(4);
      expect(getCommandLaneSnapshot(lane).activeCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(owner.outcome).resolves.toMatchObject({
        status: "failed",
        error: {
          name: "CommandLaneTaskTimeoutError",
          message: expect.stringContaining("abort grace 5ms"),
        },
      });
    });

    it("honors immediate release when initially aborted", async () => {
      const owner = enqueueOwnedTask({ kind: "unlimited" }, true);
      owner.release.abort();
      await expect(owner.outcome).resolves.toMatchObject({
        status: "failed",
        error: {
          name: "CommandLaneTaskTimeoutError",
          message: expect.stringContaining("lane release requested"),
        },
      });
      expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
    });
  });
});
