import { describe, expect, it, vi } from "vitest";
import {
  compareResourcePhases,
  measureResourceOperations,
  summarizeResourcePhase,
} from "../../scripts/e2e/lib/kitchen-sink-resources.mts";
import type { GatewayResourceSnapshot } from "../../scripts/lib/gateway-bench-profile.js";

const operations = (completed: number, failed = 0) => ({
  attempted: completed + failed,
  completed,
  failed,
});
const memoryUsage = (value: number) => ({
  rss: value,
  heapTotal: value,
  heapUsed: value,
  external: value,
  arrayBuffers: value,
});
function receipt(completed: number, failed = 0) {
  return { status: failed ? "failed" : "exercised", operations: operations(completed, failed) };
}

function snapshot(step: number, memory = 100): GatewayResourceSnapshot {
  return {
    pid: 123,
    atMonotonicMicros: step * 1_000,
    cpuEnvironment: { availableParallelism: 2, affinity: "0-1" },
    process: { user: step * 100, system: step * 10 },
    mainThread: { user: step * 50, system: step * 5 },
    memory: memoryUsage(memory),
    runtime: { node: "26.0.0", platform: "linux", arch: "x64" },
    activeResources: { Timeout: 1 },
  };
}

describe("Kitchen Sink resource phase receipts", () => {
  it.each([false, true])("samples completed operations with splitFirst=%s", async (splitFirst) => {
    const before = snapshot(1, 100);
    const midpoint = snapshot(3, 80);
    const after = splitFirst ? snapshot(12, 70) : snapshot(2);
    const count = splitFirst ? 20 : 2;
    const order: string[] = [];
    const samples = splitFirst ? [before, midpoint, after] : [before, after];
    const sample = vi.fn(async () => {
      order.push("sample");
      return samples.shift()!;
    });
    const phase = await measureResourceOperations({
      name: splitFirst ? "plugin-tool" : "neutral-rpc",
      count,
      splitFirst,
      sample,
      run: async (index) => {
        await Promise.resolve();
        order.push(`${splitFirst ? "run" : "completed"}:${index}`);
      },
    });
    if (!splitFirst) {
      expect(order).toEqual(["sample", "completed:0", "completed:1", "sample"]);
      expect(phase.status).toBe("exercised");
      expect(phase.operations).toEqual(operations(2));
      expect(phase.processCpuMsPerCompletedOperation).toBeCloseTo(0.055);
      return;
    }
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
      ...receipt(1),
      memoryChangeBytes: { rss: -20 },
    });
    expect(warm).toMatchObject({
      name: "plugin-tool-warm",
      ...receipt(19),
      memoryChangeBytes: { rss: -10 },
    });
    expect(first!.after).toBe(midpoint);
    expect(warm!.before).toBe(midpoint);
    expect(phase.before).toBe(before);
    expect(phase.after).toBe(after);
    expect(phase).toMatchObject(
      summarizeResourcePhase("plugin-tool", before, after, operations(20)),
    );
    expect(first!.processCpuMsPerCompletedOperation).toBeCloseTo(0.22);
    expect(warm!.processCpuMsPerCompletedOperation).toBeCloseTo(0.99 / 19);
    expect(phase.processCpuMsPerCompletedOperation).toBeCloseTo(1.21 / 20);
  });

  it.each([
    { splitFirst: true, failedIndex: 0 },
    { splitFirst: true, failedIndex: 3 },
    { splitFirst: false, failedIndex: 1 },
  ])(
    "retains asserted responses without retrying operation $failedIndex, splitFirst=$splitFirst",
    async ({ failedIndex, splitFirst }) => {
      let step = 0;
      const sample = splitFirst
        ? vi.fn(async () => snapshot(++step))
        : vi
            .fn<() => Promise<GatewayResourceSnapshot>>()
            .mockResolvedValueOnce(snapshot(1))
            .mockResolvedValueOnce(snapshot(4, 80));
      const run = vi.fn(async (index: number) => {
        if (index === failedIndex) {
          throw new Error(splitFirst ? "invalid tool result" : "tool output missed its fixture");
        }
      });
      const phase = await measureResourceOperations({
        name: "plugin-tool",
        count: 20,
        splitFirst,
        sample,
        run,
      });
      expect(run.mock.calls).toEqual(
        Array.from({ length: failedIndex + 1 }, (_, index) => [index]),
      );
      expect(phase).toMatchObject({
        ...receipt(failedIndex, 1),
        processCpuMsPerCompletedOperation: null,
      });
      if (!splitFirst) {
        expect(phase).toMatchObject({
          error: "tool output missed its fixture",
          memoryChangeBytes: { rss: -20, heapUsed: -20 },
        });
        return;
      }
      expect(sample).toHaveBeenCalledTimes(failedIndex === 0 ? 2 : 3);
      expect(phase.breakdown).toHaveLength(failedIndex === 0 ? 1 : 2);
      if (failedIndex > 0) {
        expect(phase.breakdown![0]).toMatchObject(receipt(1));
      }
      expect(phase.breakdown!.at(-1)).toMatchObject({
        name: failedIndex === 0 ? "plugin-tool-first" : "plugin-tool-warm",
        ...receipt(Math.max(0, failedIndex - 1), 1),
      });
    },
  );

  const malformed = snapshot(3);
  malformed.memory.rss = Number.NaN;
  const invalidSamples: Array<[string, () => Promise<GatewayResourceSnapshot>, boolean, boolean]> =
    [
      ["missing", unavailable, true, false],
      ["malformed memory", async () => malformed, true, false],
      ["changed PID", async () => ({ ...snapshot(3), pid: 999 }), true, false],
      [
        "changed CPU environment",
        async () => ({
          ...snapshot(3),
          cpuEnvironment: { availableParallelism: 4, affinity: "0-3" },
        }),
        true,
        false,
      ],
      ["missing final", unavailable, true, true],
      [
        "child exited",
        async () => {
          throw new Error("child exited");
        },
        false,
        true,
      ],
    ];
  it.each(invalidSamples)(
    "preserves completed receipts after %s",
    async (name, invalidSample, splitFirst, final) => {
      const before = snapshot(1);
      const midpoint = snapshot(2, 90);
      const count = splitFirst ? 20 : 2;
      const completed = final ? count : 1;
      const sample = vi.fn().mockResolvedValueOnce(before);
      if (splitFirst && final) {
        sample.mockResolvedValueOnce(midpoint);
      }
      sample.mockImplementationOnce(invalidSample);
      const run = vi.fn(async () => {});
      const phase = await measureResourceOperations({
        name: splitFirst ? "plugin-tool" : "neutral-rpc",
        count,
        splitFirst,
        sample,
        run,
      });
      expect(run).toHaveBeenCalledTimes(completed);
      expect(sample).toHaveBeenCalledTimes(splitFirst && final ? 3 : 2);
      expect(phase).toMatchObject({
        status: "failed",
        operations: operations(completed),
        after: null,
        cpu: null,
      });
      expect(phase.error).toContain("Resource sample failed");
      if (!splitFirst) {
        expect(phase).toMatchObject({
          memoryChangeBytes: null,
          processCpuMsPerCompletedOperation: null,
        });
        expect(phase.error).toContain(name);
        return;
      }
      if (final) {
        expect(phase.before).toBe(before);
        expect(phase.breakdown![0]).toEqual(
          summarizeResourcePhase("plugin-tool-first", before, midpoint, operations(1)),
        );
        expect(phase.breakdown![1]).toMatchObject({
          name: "plugin-tool-warm",
          status: "failed",
          operations: operations(19),
          after: null,
          cpu: null,
        });
        return;
      }
      expect(run.mock.calls).toEqual([[0]]);
      expect(phase.breakdown).toHaveLength(1);
      expect(phase.breakdown![0]).toMatchObject({
        name: "plugin-tool-first",
        status: "failed",
        operations: phase.operations,
      });
    },
  );

  it("preserves signed paired deltas without inventing an empty-host tool workload", () => {
    const ops = operations(2);
    const empty = summarizeResourcePhase("neutral-rpc", snapshot(1, 100), snapshot(5, 120), ops);
    const enabled = summarizeResourcePhase("neutral-rpc", snapshot(6, 95), snapshot(8, 90), ops);
    const tools = { ...enabled, name: "plugin-tool" };
    expect(compareResourcePhases([empty], [enabled, tools])).toEqual([
      expect.objectContaining({
        phase: "neutral-rpc",
        completedOperations: 2,
        wallMs: -2,
        memoryEndBytes: memoryUsage(-30),
        memoryGrowthBytes: memoryUsage(-25),
      }),
    ]);
    expect(compareResourcePhases([empty], [{ ...enabled, status: "failed" }])).toEqual([]);
    expect(compareResourcePhases([empty], [{ ...enabled, operations: operations(1) }])).toEqual([]);
  });

  it("retains signed resource changes and rejects missing observations", () => {
    const before = { ...snapshot(1), activeResources: { Timeout: 2, TCPServerWrap: 1 } };
    const after = { ...snapshot(2), activeResources: { Timeout: 1, Immediate: 1 } };
    const ops = operations(0);
    expect(summarizeResourcePhase("stop", before, after, ops).activeResourceChanges).toEqual({
      Immediate: 1,
      TCPServerWrap: -1,
      Timeout: -1,
    });
    expect(() =>
      summarizeResourcePhase(
        "stop",
        before,
        { ...after, activeResources: { Timeout: Number.NaN } },
        ops,
      ),
    ).toThrow("invalid active-resource");
  });
});

async function unavailable(): Promise<GatewayResourceSnapshot> {
  throw new Error("sample unavailable");
}
