import type { GatewayResourceSnapshot } from "../../scripts/lib/gateway-bench-profile.js";

export function memoryUsage(value: number) {
  return { rss: value, heapTotal: value, heapUsed: value, external: value, arrayBuffers: value };
}

export function snapshot(step: number, memory = 100): GatewayResourceSnapshot {
  return {
    pid: 123,
    atMonotonicMicros: step * 1_000,
    cpuEnvironment: { availableParallelism: 2, affinity: "0-1" },
    process: { user: step * 100, system: step * 10 },
    mainThread: { user: step * 50, system: step * 5 },
    memory: memoryUsage(memory),
    heapSpaces: [],
    runtime: { node: "26.0.0", platform: "linux", arch: "x64" },
    activeResources: { Timeout: 1 },
  };
}

export function operations(completed: number, failed = 0) {
  return { attempted: completed + failed, completed, failed };
}

export function receipt(completed: number, failed = 0) {
  return { status: failed ? "failed" : "exercised", operations: operations(completed, failed) };
}
