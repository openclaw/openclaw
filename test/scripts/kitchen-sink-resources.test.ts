import { describe, expect, it, vi } from "vitest";
import {
  compareResourcePhases,
  measureResourceOperations,
  summarizeResourcePhase,
} from "../../scripts/e2e/lib/kitchen-sink-resources.mts";
import type { GatewayResourceSnapshot } from "../../scripts/lib/gateway-bench-profile.js";

function snapshot(step: number, memory = 100): GatewayResourceSnapshot {
  return {
    pid: 123,
    atMonotonicMicros: step * 1_000,
    cpuEnvironment: { availableParallelism: 2, affinity: "0-1" },
    process: { user: step * 100, system: step * 10 },
    mainThread: { user: step * 50, system: step * 5 },
    memory: {
      rss: memory,
      heapTotal: memory,
      heapUsed: memory,
      external: memory,
      arrayBuffers: memory,
    },
    runtime: { node: "26.0.0", platform: "linux", arch: "x64" },
    activeResources: { Timeout: 1 },
  };
}

describe("Kitchen Sink resource phase receipts", () => {
  it("splits the original 20 calls with one shared midpoint and outer aggregate counters", async () => {
    const before = snapshot(1, 100);
    const midpoint = snapshot(3, 80);
    const after = snapshot(12, 70);
    const order: string[] = [];
    const samples = [before, midpoint, after];
    const sample = vi.fn(async () => {
      order.push("sample");
      return samples.shift()!;
    });
    const phase = await measureResourceOperations({
      name: "plugin-tool",
      count: 20,
      splitFirst: true,
      sample,
      run: async (index) => {
        order.push(`run:${index}`);
      },
    });
    expect(order).toEqual([
      "sample",
      "run:0",
      "sample",
      ...Array.from({ length: 19 }, (_, index) => `run:${index + 1}`),
      "sample",
    ]);
    const [first, warm] = phase.breakdown!;
    expect(first).toMatchObject({
      name: "plugin-tool-first",
      status: "exercised",
      operations: { attempted: 1, completed: 1, failed: 0 },
      memoryChangeBytes: { rss: -20 },
    });
    expect(warm).toMatchObject({
      name: "plugin-tool-warm",
      status: "exercised",
      operations: { attempted: 19, completed: 19, failed: 0 },
      memoryChangeBytes: { rss: -10 },
    });
    expect(first!.after).toBe(midpoint);
    expect(warm!.before).toBe(midpoint);
    expect(phase.before).toBe(before);
    expect(phase.after).toBe(after);
    expect(phase).toMatchObject(
      summarizeResourcePhase("plugin-tool", before, after, {
        attempted: 20,
        completed: 20,
        failed: 0,
      }),
    );
    expect(first!.processCpuMsPerCompletedOperation).toBeCloseTo(0.22);
    expect(warm!.processCpuMsPerCompletedOperation).toBeCloseTo(0.99 / 19);
    expect(phase.processCpuMsPerCompletedOperation).toBeCloseTo(1.21 / 20);
  });

  it.each([0, 1, 3])(
    "retains partial split counts when original operation %i fails",
    async (failedIndex) => {
      let step = 0;
      const sample = vi.fn(async () => snapshot(++step));
      const run = vi.fn(async (index: number) => {
        if (index === failedIndex) {
          throw new Error("invalid tool result");
        }
      });
      const phase = await measureResourceOperations({
        name: "plugin-tool",
        count: 20,
        splitFirst: true,
        sample,
        run,
      });
      expect(run.mock.calls).toEqual(
        Array.from({ length: failedIndex + 1 }, (_, index) => [index]),
      );
      expect(phase).toMatchObject({
        status: "failed",
        operations: { attempted: failedIndex + 1, completed: failedIndex, failed: 1 },
        processCpuMsPerCompletedOperation: null,
      });
      expect(sample).toHaveBeenCalledTimes(failedIndex === 0 ? 2 : 3);
      expect(phase.breakdown).toHaveLength(failedIndex === 0 ? 1 : 2);
      if (failedIndex > 0) {
        expect(phase.breakdown![0]).toMatchObject({
          status: "exercised",
          operations: { attempted: 1, completed: 1, failed: 0 },
        });
      }
      expect(phase.breakdown!.at(-1)).toMatchObject({
        name: failedIndex === 0 ? "plugin-tool-first" : "plugin-tool-warm",
        status: "failed",
        operations: {
          attempted: failedIndex === 0 ? 1 : failedIndex,
          completed: Math.max(0, failedIndex - 1),
          failed: 1,
        },
      });
    },
  );

  const invalidSamples: Array<[string, () => Promise<GatewayResourceSnapshot>]> = [
    [
      "missing",
      async () => {
        throw new Error("sample unavailable");
      },
    ],
    [
      "malformed memory",
      async () => {
        const value = snapshot(3);
        value.memory.rss = Number.NaN;
        return value;
      },
    ],
    ["changed PID", async () => ({ ...snapshot(3), pid: 999 })],
    [
      "changed CPU environment",
      async () => ({
        ...snapshot(3),
        cpuEnvironment: { availableParallelism: 4, affinity: "0-3" },
      }),
    ],
  ];
  it.each(invalidSamples)(
    "stops before warm work on a %s midpoint without failing a completed call",
    async (_name, invalidSample) => {
      const sample = vi
        .fn()
        .mockResolvedValueOnce(snapshot(1))
        .mockImplementationOnce(invalidSample);
      const run = vi.fn(async () => {});
      const phase = await measureResourceOperations({
        name: "plugin-tool",
        count: 20,
        splitFirst: true,
        sample,
        run,
      });
      expect(run.mock.calls).toEqual([[0]]);
      expect(sample).toHaveBeenCalledTimes(2);
      expect(phase).toMatchObject({
        status: "failed",
        operations: { attempted: 1, completed: 1, failed: 0 },
        after: null,
        cpu: null,
      });
      expect(phase.error).toContain("Resource sample failed");
      expect(phase.breakdown).toHaveLength(1);
      expect(phase.breakdown![0]).toMatchObject({
        name: "plugin-tool-first",
        status: "failed",
        operations: phase.operations,
      });
    },
  );

  it.each(invalidSamples)(
    "preserves the first receipt and all completions on a %s final sample",
    async (_name, invalidSample) => {
      const before = snapshot(1);
      const midpoint = snapshot(2, 90);
      const sample = vi
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(midpoint)
        .mockImplementationOnce(invalidSample);
      const run = vi.fn(async () => {});
      const phase = await measureResourceOperations({
        name: "plugin-tool",
        count: 20,
        splitFirst: true,
        sample,
        run,
      });
      expect(run).toHaveBeenCalledTimes(20);
      expect(sample).toHaveBeenCalledTimes(3);
      expect(phase).toMatchObject({
        status: "failed",
        operations: { attempted: 20, completed: 20, failed: 0 },
        after: null,
        cpu: null,
      });
      expect(phase.before).toBe(before);
      expect(phase.breakdown![0]).toEqual(
        summarizeResourcePhase("plugin-tool-first", before, midpoint, {
          attempted: 1,
          completed: 1,
          failed: 0,
        }),
      );
      expect(phase.breakdown![1]).toMatchObject({
        name: "plugin-tool-warm",
        status: "failed",
        operations: { attempted: 19, completed: 19, failed: 0 },
        after: null,
        cpu: null,
      });
    },
  );

  it("counts only asserted responses and stops on the first failure without retrying", async () => {
    const sample = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockResolvedValueOnce(snapshot(4, 80));
    const run = vi.fn(async (index: number) => {
      if (index === 1) {
        throw new Error("tool output missed its fixture");
      }
    });
    const phase = await measureResourceOperations({ name: "plugin-tool", count: 20, sample, run });
    expect(run.mock.calls).toEqual([[0], [1]]);
    expect(phase).toMatchObject({
      status: "failed",
      operations: { attempted: 2, completed: 1, failed: 1 },
      error: "tool output missed its fixture",
      memoryChangeBytes: { rss: -20, heapUsed: -20 },
      processCpuMsPerCompletedOperation: null,
    });
  });

  it("keeps completed-operation receipts when the final resource sample is unavailable", async () => {
    const sample = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1))
      .mockRejectedValueOnce(new Error("child exited"));
    const phase = await measureResourceOperations({
      name: "neutral-rpc",
      count: 2,
      sample,
      run: async () => {},
    });
    expect(phase).toMatchObject({
      status: "failed",
      operations: { attempted: 2, completed: 2, failed: 0 },
      after: null,
      cpu: null,
      memoryChangeBytes: null,
      processCpuMsPerCompletedOperation: null,
    });
    expect(phase.error).toContain("child exited");
  });

  it("waits for work before sampling and divides CPU only by completed operations", async () => {
    const order: string[] = [];
    let tick = 0;
    const sample = async () => {
      order.push("sample");
      return snapshot(++tick);
    };
    const phase = await measureResourceOperations({
      name: "neutral-rpc",
      count: 2,
      sample,
      run: async (index) => {
        await Promise.resolve();
        order.push(`completed:${index}`);
      },
    });
    expect(order).toEqual(["sample", "completed:0", "completed:1", "sample"]);
    expect(phase.status).toBe("exercised");
    expect(phase.operations).toEqual({ attempted: 2, completed: 2, failed: 0 });
    expect(phase.processCpuMsPerCompletedOperation).toBeCloseTo(0.055);
  });

  it("preserves signed paired deltas without inventing an empty-host tool workload", () => {
    const ops = { attempted: 2, completed: 2, failed: 0 };
    const empty = summarizeResourcePhase("neutral-rpc", snapshot(1, 100), snapshot(5, 120), ops);
    const enabled = summarizeResourcePhase("neutral-rpc", snapshot(6, 95), snapshot(8, 90), ops);
    const tools = { ...enabled, name: "plugin-tool" };
    expect(compareResourcePhases([empty], [enabled, tools])).toEqual([
      expect.objectContaining({
        phase: "neutral-rpc",
        completedOperations: 2,
        wallMs: -2,
        memoryEndBytes: {
          rss: -30,
          heapTotal: -30,
          heapUsed: -30,
          external: -30,
          arrayBuffers: -30,
        },
        memoryGrowthBytes: {
          rss: -25,
          heapTotal: -25,
          heapUsed: -25,
          external: -25,
          arrayBuffers: -25,
        },
      }),
    ]);
    expect(compareResourcePhases([empty], [{ ...enabled, status: "failed" }])).toEqual([]);
    expect(
      compareResourcePhases(
        [empty],
        [{ ...enabled, operations: { attempted: 1, completed: 1, failed: 0 } }],
      ),
    ).toEqual([]);
  });

  it("rejects mixed process identities and unavailable memory rather than reporting zero", () => {
    const ops = { attempted: 0, completed: 0, failed: 0 };
    expect(() =>
      summarizeResourcePhase("idle", snapshot(1), { ...snapshot(2), pid: 999 }, ops),
    ).toThrow("one process");
    const invalid = snapshot(2);
    invalid.memory.rss = Number.NaN;
    expect(() => summarizeResourcePhase("idle", snapshot(1), invalid, ops)).toThrow("invalid rss");
  });

  it("retains signed resource changes and rejects missing observations", () => {
    const before = { ...snapshot(1), activeResources: { Timeout: 2, TCPServerWrap: 1 } };
    const after = { ...snapshot(2), activeResources: { Timeout: 1, Immediate: 1 } };
    const ops = { attempted: 0, completed: 0, failed: 0 };
    expect(summarizeResourcePhase("stop", before, after, ops).activeResourceChanges).toEqual({
      Immediate: 1,
      TCPServerWrap: -1,
      Timeout: -1,
    });
    expect(() =>
      summarizeResourcePhase(
        "stop",
        before,
        {
          ...after,
          activeResources: { Timeout: Number.NaN },
        },
        ops,
      ),
    ).toThrow("invalid active-resource");
  });
});
