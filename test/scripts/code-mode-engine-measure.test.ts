import { Script } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CodeModeExecutor,
  CodeModeExecutorContinuation,
  CodeModeWorkerResult,
} from "../../src/agents/code-mode-executor-types.js";
import type { PendingBridgeRequest } from "../../src/agents/code-mode-worker-types.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../helpers/promise.js";

const runtime = vi.hoisted(() => ({ execute: vi.fn(), close: vi.fn(), stop: vi.fn() }));
// mock-isolation: inject deterministic failures without starting real executor workers.
vi.mock("../../src/agents/code-mode-node.js", () => ({
  nodeCodeModeExecutor: { id: "node", execute: runtime.execute },
}));
// mock-isolation: the fake executor does not consume or acquire a real tool catalog.
vi.mock("../../src/agents/code-mode-node-input.js", () => ({
  prepareCodeModeNodeCatalog: () => ({}),
}));
// mock-isolation: inject host-close failures without acquiring real plugin resources.
vi.mock("../../src/plugins/legacy-sdk-resource-host.js", () => ({
  LegacyPluginSdkResourceHost: class {
    bindScheduler() {}
    run<T>(run: () => T): T {
      return run();
    }
    close() {
      return runtime.close();
    }
  },
}));
// mock-isolation: observe scheduler stop ordering independently of its implementation.
vi.mock("../../src/infra/gateway-scheduler.js", () => ({
  GatewayScheduler: class {
    stop() {
      return runtime.stop();
    }
  },
}));

const output = { count: 0, source: { kind: "complete" as const, json: "[]" } };
const completed = (value: unknown): CodeModeWorkerResult => ({
  status: "completed",
  value: { kind: "complete", json: JSON.stringify(value) },
  output,
});
const failed: CodeModeWorkerResult = {
  status: "failed",
  error: "fixture failure",
  code: "internal_error",
  failurePhase: "host",
  bridgeDispatchStarted: false,
  output,
};

// Execute the probe's committed guest programs, faking only the executor boundary
// so failures and delayed ownership transfers are deterministic. This is not VM proof.
function installExecutor(
  parallel: (
    index: number,
    produce: () => Promise<CodeModeWorkerResult>,
  ) => Promise<CodeModeWorkerResult>,
  dispose: () => Promise<void>,
) {
  let parallelIndex = 0;
  const starting = new Set<object>();
  const execute: CodeModeExecutor["execute"] = async (input, options) => {
    const token = {};
    starting.add(token);
    await Promise.resolve();
    const concurrent = starting.size > 1;
    await Promise.resolve();
    starting.delete(token);
    const produce = async (): Promise<CodeModeWorkerResult> => {
      const guest = new Script(`(async (tool_0) => {${input.source}\n})`).runInNewContext() as (
        tool: (args: unknown) => Promise<unknown>,
      ) => Promise<unknown>;
      const checkpoint = new Error("checkpoint");
      let pending: PendingBridgeRequest | undefined;
      try {
        return completed(
          await guest(async (args) => {
            const request: PendingBridgeRequest = {
              id: "request",
              method: "callValue",
              args: ["tool_0", args],
            };
            const signal = new AbortController().signal;
            const reply = await options.inlineHost!.onBoundary(
              {
                status: "boundary",
                pendingRequests: [request],
                canceledRequestIds: [],
                settlementMode: { kind: "awaiting" },
                output,
                memoryUsedBytes: 0,
              },
              { signal, yieldSignal: signal, maxTimeoutMs: options.timeoutMs },
            );
            if (reply.kind === "checkpoint") {
              pending = request;
              throw checkpoint;
            }
            return JSON.parse(reply.settledRequests[0]!.json) as unknown;
          }),
        );
      } catch (error) {
        if (error !== checkpoint || !pending) {
          throw error;
        }
        const continuation: CodeModeExecutorContinuation = {
          executor: "node",
          retainedBytes: 1,
          resume: async (resume) =>
            completed(
              await guest(async () => JSON.parse(resume.settledRequests[0]!.json) as unknown),
            ),
          dispose: concurrent ? dispose : async () => {},
        };
        return {
          status: "waiting",
          continuation,
          pendingRequests: [pending],
          canceledRequestIds: [],
          settlementMode: { kind: "awaiting" },
          output,
        };
      }
    };
    return concurrent ? parallel(parallelIndex++, produce) : produce();
  };
  const calls: Promise<CodeModeWorkerResult>[] = [];
  const tracked: CodeModeExecutor["execute"] = (input, options) => {
    const call = execute(input, options);
    calls.push(call);
    return call;
  };
  runtime.execute.mockImplementation(tracked);
  return () => Promise.allSettled(calls);
}

function runProbe() {
  const argv = process.argv;
  process.argv = [argv[0]!, "probe", "--arm", "node", "1"];
  const run = import("../../scripts/perf/code-mode-engine-measure.js").finally(() => {
    process.argv = argv;
  });
  void run.catch(() => {});
  return run;
}

function expectTimersCleared() {
  const timers = vi.mocked(globalThis.setInterval).mock.results;
  expect(timers.length).toBeGreaterThan(0);
  for (const result of timers) {
    expect(
      vi.mocked(globalThis.clearInterval).mock.calls.some(([timer]) => timer === result.value),
    ).toBe(true);
  }
}

beforeEach(() => {
  vi.resetModules();
  runtime.execute.mockReset();
  runtime.close.mockReset().mockResolvedValue(undefined);
  runtime.stop.mockReset().mockResolvedValue(undefined);
  vi.spyOn(globalThis, "setInterval");
  vi.spyOn(globalThis, "clearInterval");
});
afterEach(() => {
  // A failing counterfactual must not leave the original probe's ref'ed timers alive.
  for (const result of vi.mocked(globalThis.setInterval).mock.results) {
    if (result.type === "return") {
      globalThis.clearInterval(result.value);
    }
  }
  vi.restoreAllMocks();
});

it("joins rejected and pending checkpoint disposals before closing the host and scheduler", async ({
  signal,
}) => {
  const entered = createDeferred();
  const release = createDeferred();
  const cleanupError = new Error("dispose failed");
  let disposals = 0;
  const join = installExecutor(
    async (index, produce) => (index === 0 ? failed : produce()),
    async () => {
      if (disposals++ === 0) {
        throw cleanupError;
      }
      entered.resolve();
      await release.promise;
    },
  );
  const run = runProbe();
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, run, "checkpoint custody was lost"),
      signal,
    );
    await nextEventLoopTurn();
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    release.resolve();
    const error: unknown = await run.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(cleanupError);
    expect((error as AggregateError).cause).toMatchObject({ name: "AssertionError" });
    expect(disposals).toBe(7);
    expect(runtime.close).toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalled();
    expectTimersCleared();
  } finally {
    release.resolve();
    await Promise.allSettled([run, join()]);
  }
});

it("joins a failed parallel execution before disposing a checkpoint returned later", async ({
  signal,
}) => {
  const entered = createDeferred();
  const release = createDeferred();
  const workloadError = new Error("execution failed");
  let disposed = 0;
  const join = installExecutor(
    async (index, produce) => {
      if (index === 0) {
        throw workloadError;
      }
      if (index === 1) {
        entered.resolve();
        await release.promise;
      }
      return produce();
    },
    async () => {
      disposed++;
    },
  );
  const run = runProbe();
  try {
    await withinTest(
      awaitGateBeforeSettlement(entered.promise, run, "parallel execution was not started"),
      signal,
    );
    await nextEventLoopTurn();
    expect(runtime.close).not.toHaveBeenCalled();
    release.resolve();
    await expect(run).rejects.toBe(workloadError);
    expect(disposed).toBe(7);
    expect(runtime.stop).toHaveBeenCalled();
    expectTimersCleared();
  } finally {
    release.resolve();
    await Promise.allSettled([run, join()]);
  }
});

it("preserves workload and host-close errors while stopping the scheduler and clearing timers", async () => {
  const workloadError = new Error("execution failed");
  const cleanupError = new Error("host close failed");
  runtime.execute.mockRejectedValue(workloadError);
  runtime.close.mockRejectedValue(cleanupError);
  const error: unknown = await runProbe().catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([workloadError, cleanupError]);
  expect((error as AggregateError).cause).toBe(workloadError);
  expect(runtime.stop).toHaveBeenCalled();
  expectTimersCleared();
});
