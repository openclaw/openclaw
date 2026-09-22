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
